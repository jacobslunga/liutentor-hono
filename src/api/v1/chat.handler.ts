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
  type ChatStreamEvent,
} from "~/utils/chat.utils";
import {
  validateChatAttachments,
  type ValidatedChatAttachment,
} from "./chat.attachments";

/**
 * The parts every chat route shares: reading the multipart request, working
 * out who is asking and whether the turn earns a title, and streaming the
 * reply back as SSE while logging both sides of the turn.
 */

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

/** Parses `payload` (JSON) against `schema` and validates the `files` fields. */
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
  // Anonymous chats have no row to check, so the title rides on the stream
  // only. The history-length guard keeps a client from paying for a title
  // call on every turn by always claiming it is the first message.
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

export interface StreamChatOptions {
  responseStream: AsyncGenerator<ChatStreamEvent>;
  identity: ChatIdentity;
  conversationId?: string | null;
  /** Course label handed to the title model; may be empty. */
  titleCourseCode: string;
  lastMsgText: string;
  /** Columns written on the assistant's log row besides role/content. */
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
  } = opts;

  // Status and source events need a frame to travel in, but a browser holding a
  // cached bundle still speaks the old concatenate-the-bytes protocol. Serving
  // both off the same generator lets the two repos deploy independently; the
  // plaintext branch can be deleted once no client asks for it.
  const wantsEvents = (c.req.header("accept") ?? "").includes(
    "text/event-stream",
  );

  if (wantsEvents) {
    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    // Cloud Run buffers a response it thinks it can compress, which would hold
    // every status event until the turn finished — exactly backwards.
    c.header("X-Accel-Buffering", "no");
  } else {
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Transfer-Encoding", "chunked");
  }

  return stream(c, async (s) => {
    let fullResponse = "";

    const sendEvent = async (type: string, data: unknown) => {
      await s.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const emit = async (event: ChatStreamEvent) => {
      if (event.type === "text") {
        fullResponse += event.delta;
        if (!wantsEvents) {
          await s.write(event.delta);
          return;
        }
      } else if (!wantsEvents) {
        // The plaintext protocol has nowhere to put anything but text.
        return;
      }
      await sendEvent(event.type, event);
    };

    try {
      for await (const event of responseStream) {
        await emit(event);
      }

      // The plaintext protocol has nowhere to put a title, and only a stored
      // conversation needs one without the stream.
      if (
        shouldGenerateTitle &&
        fullResponse.trim() &&
        (wantsEvents || (userId && conversationId))
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
          // A title is decorative; never fail an otherwise successful answer.
          console.error("Conversation title generation error:", error);
        }
      }

      if (wantsEvents) await sendEvent("done", {});
    } catch (error: any) {
      console.error("Streaming error:", error);
      // Once bytes are on the wire an HTTP status can no longer say anything,
      // so a framed client gets a real error frame instead of a truncated turn.
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

    logToDBAsync({
      ...logFields,
      role: "assistant",
      content: fullResponse,
    });
  });
}
