import { SYSTEM_PROMPT, WEB_SEARCH_PROMPT } from "~/utils/prompts";
import { chatMessageSchema, examIdSchema } from "./chat.schemas";
import { validateChatAttachments } from "./chat.attachments";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { supabase } from "~/db/supabase";
import {
  streamAnthropicResponse,
  streamGeminiResponse,
  streamOpenAIResponse,
  PdfData,
  ChatStreamEvent,
} from "~/utils/chat.utils";
import { getModelConfig } from "./chat.models";
import { fetchPdfAsBase64 } from "~/utils/pdf.cache";
import { rateLimitByIdentity } from "~/utils/rate.limit";
import {
  getAuthenticatedUserId,
  assertConversationOwnership,
} from "~/utils/auth";

function extractTextContent(content: unknown): string {
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part: any) => part?.type === "text" && typeof part?.text === "string",
    );
    return textPart?.text || "";
  }
  return typeof content === "string" ? content : "";
}

function logToDBAsync(payload: any) {
  supabase
    .from("ai_chat_logs")
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error("DB Log Error:", error.message);
    });
}

const chat = new Hono().basePath("/v1/chat");

chat.post(
  "/completion/:examId",
  // ~12/min is roughly 10x the fastest real usage: the p25 gap between turns in
  // a session is 54s, so even an intense student sits near 1/min.
  rateLimitByIdentity({ windowMs: 60_000, max: 12, name: "chat" }),
  zValidator("param", examIdSchema),
  bodyLimit({ maxSize: 22 * 1024 * 1024 }),
  timeout(120000),
  async (c) => {
    const { examId } = c.req.valid("param");
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

    const validation = chatMessageSchema.safeParse(parsedPayload);
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

    const userAttachments = await validateChatAttachments(fileFields);
    const body = validation.data;

    const {
      messages,
      examUrl,
      solutionUrl,
      courseCode,
      conversationId,
      modelId,
      selectionContext,
      webSearch: requestedWebSearch,
    } = body;

    if (!examUrl || !messages?.length) {
      throw new HTTPException(400, { message: "Missing examUrl or messages" });
    }

    const anonymousUserId = c.req.header("x-anonymous-user-id") || "unknown";
    const userId = await getAuthenticatedUserId(c.req.header("Authorization"));

    if (conversationId) {
      if (!userId) {
        throw new HTTPException(401, {
          message: "Authentication required for conversations",
        });
      }
      await assertConversationOwnership(conversationId, userId);
    }

    const {
      provider,
      modelId: resolvedModelId,
      requiresAuth,
      supportsWebSearch,
    } = getModelConfig(modelId);

    const webSearch = !!requestedWebSearch && !!supportsWebSearch;

    if (requiresAuth && !userId) {
      throw new HTTPException(403, {
        message: "Den här tankenivån kräver att du är inloggad",
      });
    }

    const lastMsgText = extractTextContent(
      messages[messages.length - 1]?.content,
    );

    logToDBAsync({
      user_id: userId,
      conversation_id: conversationId || null,
      anonymous_user_id: anonymousUserId,
      course_code: courseCode,
      exam_id: examId,
      role: "user",
      content: lastMsgText,
      model: resolvedModelId,
    });

    const [examBase64, solutionBase64] = await Promise.all([
      fetchPdfAsBase64(examUrl),
      solutionUrl ? fetchPdfAsBase64(solutionUrl) : Promise.resolve(null),
    ]);

    const cyan = "\x1b[36m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    console.log(
      `${cyan}┌─ CHAT REQUEST ${"─".repeat(35)}\n` +
        `│${reset}  ${bold}Course${reset}   ${dim}→${reset}  ${courseCode ?? "unknown"}\n` +
        `${cyan}│${reset}  ${bold}Exam ID${reset}  ${dim}→${reset}  ${examId}\n` +
        `${cyan}│${reset}  ${bold}Model${reset}    ${dim}→${reset}  ${resolvedModelId}  ${dim}(${provider})${reset}\n` +
        `${cyan}│${reset}  ${bold}Messages${reset} ${dim}→${reset}  ${messages.length}\n` +
        `${cyan}│${reset}  ${bold}Facit${reset}    ${dim}→${reset}  ${solutionUrl ? "yes" : "no"}\n` +
        `${cyan}│${reset}  ${bold}Files${reset}    ${dim}→${reset}  ${userAttachments.length}\n` +
        `${cyan}│${reset}  ${bold}Webb${reset}     ${dim}→${reset}  ${webSearch ? "on" : "off"}\n` +
        `${cyan}│${reset}  ${bold}User${reset}     ${dim}→${reset}  ${dim}${userId ?? `anon:${anonymousUserId}`}${reset}\n` +
        `${cyan}└${"─".repeat(50)}${reset}`,
    );

    const pdfs: PdfData[] = [];
    if (examBase64) {
      pdfs.push({
        data: examBase64,
        mimeType: "application/pdf",
        label: "tenta",
      });
    }
    if (solutionBase64) {
      pdfs.push({
        data: solutionBase64,
        mimeType: "application/pdf",
        label: "facit",
      });
    }

    const systemPrompt = webSearch
      ? SYSTEM_PROMPT + WEB_SEARCH_PROMPT
      : SYSTEM_PROMPT;

    const modelLastMsgText =
      lastMsgText.trim() ||
      "Hjälp mig att förstå och arbeta med det bifogade materialet.";

    const cacheKey = `${examUrl}:${solutionUrl || ""}`;

    const responseStream =
      provider === "google"
        ? streamGeminiResponse(
            systemPrompt,
            messages,
            resolvedModelId,
            pdfs,
            userAttachments,
            modelLastMsgText,
            selectionContext,
            cacheKey,
            webSearch,
          )
        : provider === "anthropic"
          ? streamAnthropicResponse(
              systemPrompt,
              messages,
              resolvedModelId,
              pdfs,
              userAttachments,
              modelLastMsgText,
              selectionContext,
            )
          : streamOpenAIResponse(
              systemPrompt,
              messages,
              resolvedModelId,
              pdfs,
              userAttachments,
              modelLastMsgText,
              selectionContext,
              cacheKey,
              webSearch,
            );

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
        user_id: userId,
        conversation_id: conversationId || null,
        anonymous_user_id: anonymousUserId,
        course_code: courseCode,
        exam_id: examId,
        role: "assistant",
        content: fullResponse,
        model: resolvedModelId,
      });
    });
  },
);

export default chat;
