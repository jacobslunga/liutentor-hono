import { SYSTEM_PROMPT } from "~/utils/prompts";
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
} from "~/utils/chat.utils";
import { getModelConfig } from "./chat.models";
import { extractInteractiveGraphBlocks } from "./chat.graphs";
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
        `${cyan}│${reset}  ${bold}Files${reset}    ${dim}→${reset}  ${userAttachments.length}\n` +
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

    const systemPrompt = SYSTEM_PROMPT;

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

      const graphBlocks = extractInteractiveGraphBlocks(fullResponse);
      const invalidGraphs = graphBlocks.filter((block) => !block.spec);
      if (invalidGraphs.length > 0) {
        console.warn(
          `Chat response contained ${invalidGraphs.length} invalid interactive graph artifact(s)`,
          invalidGraphs.map((block) => block.error),
        );
      }
    });
  },
);

export default chat;
