import { SYSTEM_PROMPT } from "~/utils/prompts";
import { chatMessageSchema, examIdSchema } from "./chat.schemas";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { supabase } from "~/db/supabase";
import { streamGoogleResponse } from "~/utils/chat.utils";
import { pdfToGeminiParts } from "~/utils/pdf.utils";
import {
  getAuthenticatedUserId,
  assertConversationOwnership,
} from "~/utils/auth";

type Provider = "google";

interface ModelConfig {
  provider: Provider;
  modelId: string;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  "gemini-3.1-flash-lite": {
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
  },
  "gemini-3-flash-preview": {
    provider: "google",
    modelId: "gemini-3-flash-preview",
  },
};

const getModelConfig = (modelId: string): ModelConfig =>
  MODEL_MAP[modelId] ?? {
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
  };

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
  zValidator("param", examIdSchema),
  zValidator("json", chatMessageSchema),
  bodyLimit({ maxSize: 20 * 1024 * 1024 }),
  timeout(120000),
  async (c) => {
    const { examId } = c.req.valid("param");
    const body = c.req.valid("json");

    const {
      messages,
      examUrl,
      solutionUrl,
      courseCode,
      conversationId,
      modelId = "gemini-3.1-flash-lite",
      selectionContext,
    } = body as any;

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

    const { provider, modelId: resolvedModelId } = getModelConfig(modelId);
    const lastMsgText = extractTextContent(
      messages[messages.length - 1]?.content,
    );

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
        `${cyan}│${reset}  ${bold}Solution${reset} ${dim}→${reset}  ${solutionUrl ? "yes" : "no"}\n` +
        `${cyan}│${reset}  ${bold}User${reset}     ${dim}→${reset}  ${dim}${userId ?? `anon:${anonymousUserId}`}${reset}\n` +
        `${cyan}└${"─".repeat(50)}${reset}`,
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

    // Process both PDFs in parallel: the work is mostly network I/O, and
    // sharp.concurrency(1) globally serializes the heavy image conversions, so
    // peak memory stays bounded even when both take the image path.
    const [examParts, solutionParts] = await Promise.all([
      pdfToGeminiParts(examUrl, "tenta"),
      solutionUrl
        ? pdfToGeminiParts(solutionUrl, "facit")
        : Promise.resolve([]),
    ]);

    const pdfParts = [...examParts, ...solutionParts];

    const systemPrompt = SYSTEM_PROMPT;

    const responseStream = streamGoogleResponse(
      systemPrompt,
      messages,
      resolvedModelId,
      pdfParts,
      lastMsgText,
      selectionContext,
    );

    return stream(c, async (s) => {
      c.header("Content-Type", "text/plain; charset=utf-8");
      c.header("Transfer-Encoding", "chunked");

      let fullResponse = "";

      try {
        for await (const text of responseStream) {
          fullResponse += text;
          await s.write(text);
        }
      } catch (error: any) {
        console.error("Streaming error:", error);
        throw new HTTPException(500, {
          message: "Failed while streaming response",
        });
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
