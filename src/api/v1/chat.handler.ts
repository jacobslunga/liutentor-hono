import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { z } from "zod";
import { supabase } from "~/db/supabase";
import {
  assertConversationOwnership,
  getAuthenticatedUserId,
} from "~/utils/auth";
import {
  generateConversationTitle,
  stripCitationMarkers,
  type ChatStreamEvent,
} from "~/utils/chat.utils";
import {
  validateChatAttachments,
  type ValidatedChatAttachment,
} from "./chat.attachments";

export function extractTextContent(content: unknown): string {
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part: any) => part?.type === "text" && typeof part?.text === "string",
    );
    return textPart?.text || "";
  }
  return typeof content === "string" ? content : "";
}

export function logToDBAsync(payload: any) {
  supabase
    .from("ai_chat_logs")
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error("DB Log Error:", error.message);
    });
}

export async function readChatForm<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ body: z.infer<S>; attachments: ValidatedChatAttachment[] }> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HTTPException(415, {
      message: "Chat requests must use multipart/form-data",
    });
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    throw new HTTPException(400, { message: "Malformed multipart request" });
  }

  const payload = formData.get("payload");
  if (typeof payload !== "string") {
    throw new HTTPException(400, { message: "Missing chat payload" });
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    throw new HTTPException(400, { message: "Invalid chat payload" });
  }

  const validation = schema.safeParse(parsedPayload);
  if (!validation.success) {
    throw new HTTPException(400, {
      message: validation.error.issues[0]?.message ?? "Invalid chat payload",
    });
  }

  const fileFields = formData
    .getAll("files")
    .filter((field): field is File => field instanceof File);
  if (fileFields.length !== formData.getAll("files").length) {
    throw new HTTPException(400, { message: "Invalid attachment field" });
  }

  const attachments = await validateChatAttachments(fileFields);
  return { body: validation.data, attachments };
}

export interface ChatIdentity {
  userId: string | null;
  anonymousUserId: string;
  shouldGenerateTitle: boolean;
}

export async function resolveChatIdentity(
  c: Context,
  opts: {
    conversationId?: string | null;
    isFirstMessage?: boolean;
    messageCount: number;
  },
): Promise<ChatIdentity> {
  const { conversationId, isFirstMessage, messageCount } = opts;
  const anonymousUserId = c.req.header("x-anonymous-user-id") || "unknown";
  const userId = await getAuthenticatedUserId(c.req.header("Authorization"));
  let shouldGenerateTitle = !!isFirstMessage && messageCount === 1;

  if (conversationId) {
    if (!userId) {
      throw new HTTPException(401, {
        message: "Authentication required for conversations",
      });
    }
    await assertConversationOwnership(conversationId, userId);
    if (isFirstMessage) {
      const { count, error } = await supabase
        .from("ai_chat_logs")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId);
      if (error) {
        console.error("Conversation title eligibility error:", error.message);
        shouldGenerateTitle = false;
      } else {
        shouldGenerateTitle = count === 0;
      }
    }
  }

  return { userId, anonymousUserId, shouldGenerateTitle };
}

const CANCELLED_NOTE = "> *Avbruten av användaren*";

const activeTurns = new Map<
  string,
  { controller: AbortController; owner: string }
>();

export interface ChatTurn {
  signal: AbortSignal;
  end: () => void;
}

export function startTurn(turnId: string | undefined, owner: string): ChatTurn {
  const controller = new AbortController();
  if (turnId) activeTurns.set(turnId, { controller, owner });
  return {
    signal: controller.signal,
    end: () => {
      if (turnId && activeTurns.get(turnId)?.controller === controller)
        activeTurns.delete(turnId);
    },
  };
}

export function cancelTurn(turnId: string, owner: string): boolean {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.owner !== owner) return false;
  turn.controller.abort();
  activeTurns.delete(turnId);
  return true;
}

export const turnOwner = ({
  userId,
  anonymousUserId,
}: Pick<ChatIdentity, "userId" | "anonymousUserId">) =>
  userId ?? `anon:${anonymousUserId}`;

export interface StreamChatOptions {
  responseStream: AsyncGenerator<ChatStreamEvent>;
  turn: ChatTurn;
  identity: ChatIdentity;
  conversationId?: string | null;
  titleCourseCode: string;
  lastMsgText: string;
  logFields: Record<string, unknown>;
}

export function streamChatResponse(c: Context, opts: StreamChatOptions) {
  const {
    responseStream,
    identity: { userId, shouldGenerateTitle },
    conversationId,
    titleCourseCode,
    lastMsgText,
    logFields,
    turn,
  } = opts;

  const wantsEvents = (c.req.header("accept") ?? "").includes(
    "text/event-stream",
  );

  if (wantsEvents) {
    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
  } else {
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Transfer-Encoding", "chunked");
  }

  return stream(c, async (s) => {
    let fullResponse = "";
    let sources: unknown[] = [];
    let clientGone = false;
    s.onAbort(() => {
      clientGone = true;
    });
    const write = async (chunk: string) => {
      if (!clientGone) await s.write(chunk);
    };

    const sendEvent = async (type: string, data: unknown) => {
      await write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const saveStopped = () => {
      fullResponse = stripCitationMarkers(fullResponse);
      turn.end();
      logToDBAsync({
        ...logFields,
        role: "assistant",
        content: fullResponse.trim()
          ? `${fullResponse.trim()}\n\n${CANCELLED_NOTE}`
          : CANCELLED_NOTE,
        sources: sources.length ? sources : null,
      });
    };

    const emit = async (event: ChatStreamEvent) => {
      if (event.type === "sources") sources = event.items;
      if (event.type === "text") {
        fullResponse += event.delta;
        if (!wantsEvents) {
          await write(event.delta);
          return;
        }
      } else if (!wantsEvents) {
        return;
      }
      await sendEvent(event.type, event);
    };

    try {
      for await (const event of responseStream) {
        await emit(event);
      }
      if (turn.signal.aborted) {
        saveStopped();
        return;
      }
      fullResponse = stripCitationMarkers(fullResponse);

      if (
        shouldGenerateTitle &&
        fullResponse.trim() &&
        ((wantsEvents && !clientGone) || (userId && conversationId))
      ) {
        try {
          const title = await generateConversationTitle(
            titleCourseCode,
            lastMsgText,
            fullResponse,
          );
          if (title) {
            let saved = true;
            if (userId && conversationId) {
              const { error } = await supabase
                .from("conversations")
                .update({ title })
                .eq("id", conversationId)
                .eq("user_id", userId);
              if (error) {
                saved = false;
                console.error(
                  "Conversation title update error:",
                  error.message,
                );
              }
            }
            if (saved && wantsEvents) await sendEvent("title", { title });
          }
        } catch (error) {
          console.error("Conversation title generation error:", error);
        }
      }

      if (wantsEvents) await sendEvent("done", {});
    } catch (error: any) {
      if (turn.signal.aborted) {
        saveStopped();
        return;
      }
      console.error("Streaming error:", error);
      if (wantsEvents) {
        await sendEvent("error", {
          message: "Något gick fel. Försök igen senare.",
        });
      } else {
        throw new HTTPException(500, {
          message: "Failed while streaming response",
        });
      }
    }

    turn.end();
    logToDBAsync({
      ...logFields,
      role: "assistant",
      content: fullResponse,
      sources: sources.length ? sources : null,
    });
  });
}
