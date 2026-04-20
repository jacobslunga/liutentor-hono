import { SYSTEM_PROMPT } from "~/utils/prompts";
import { chatMessageSchema, examIdSchema } from "./chat.schemas";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { supabase } from "~/db/supabase";
import { PdfData } from "~/utils/chat.utils";
import {
  streamAnthropicResponse,
  streamGoogleResponse,
  streamOpenAIResponse,
} from "~/utils/chat.utils";
import {
  getAuthenticatedUserId,
  assertConversationOwnership,
} from "~/utils/auth";

type Provider = "google" | "anthropic" | "openai";

interface ModelConfig {
  provider: Provider;
  modelId: string;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  "gemini-2.5-pro": { provider: "google", modelId: "gemini-2.5-flash" },
  "gemini-3.1-pro-preview": { provider: "google", modelId: "gemini-2.5-pro" },
  "gemini-3.1-flash-lite": { provider: "google", modelId: "gemini-2.5-flash" },
  "gpt-4.1": { provider: "openai", modelId: "gpt-4.1" },
  "gpt-4.1-mini": { provider: "openai", modelId: "gpt-4.1-mini" },
  "gpt-4o": { provider: "openai", modelId: "gpt-4o" },
};

const getModelConfig = (modelId: string): ModelConfig =>
  MODEL_MAP[modelId] ?? { provider: "google", modelId: "gemini-2.5-pro" };

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

async function fetchPdfAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch PDF at ${url}: ${response.statusText}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (error) {
    console.error(`Network error fetching PDF at ${url}:`, error);
    return null;
  }
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
      modelId = "gemini-2.5-pro",
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

    const [examBase64, solutionBase64] = await Promise.all([
      fetchPdfAsBase64(examUrl),
      solutionUrl ? fetchPdfAsBase64(solutionUrl) : Promise.resolve(null),
    ]);

    const pdfs: PdfData[] = [
      examBase64 ? { data: examBase64, mimeType: "application/pdf" } : null,
      solutionBase64
        ? { data: solutionBase64, mimeType: "application/pdf" }
        : null,
    ].filter(Boolean) as PdfData[];

    const systemPrompt = [SYSTEM_PROMPT].filter(Boolean).join("\n");

    const responseStream =
      provider === "anthropic"
        ? streamAnthropicResponse(
            systemPrompt,
            messages,
            resolvedModelId,
            pdfs,
            lastMsgText,
          )
        : provider === "openai"
          ? streamOpenAIResponse(
              systemPrompt,
              messages,
              resolvedModelId,
              pdfs,
              lastMsgText,
            )
          : streamGoogleResponse(
              systemPrompt,
              messages,
              resolvedModelId,
              pdfs,
              lastMsgText,
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
