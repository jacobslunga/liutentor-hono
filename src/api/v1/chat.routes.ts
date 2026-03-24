import { GoogleGenAI } from "@google/genai";
import { HINT_MODE, SYSTEM_PROMPT } from "~/utils/prompts";
import { chatMessageSchema, examIdSchema } from "./chat.schemas";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { supabase } from "~/db/supabase";

const googleAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
});

type Provider = "google" | "anthropic";

interface ModelConfig {
  provider: Provider;
  modelId: string;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  "gemini-2.5-pro": { provider: "google", modelId: "gemini-2.5-flash" },
  "gemini-3.1-pro-preview": { provider: "google", modelId: "gemini-2.5-pro" },
  "gemini-3.1-flash-lite": { provider: "google", modelId: "gemini-2.5-flash" },
  "claude-haiku": {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
  },
  "claude-sonnet": { provider: "anthropic", modelId: "claude-sonnet-4-6" },
};

const getModelConfig = (modelId: string): ModelConfig =>
  MODEL_MAP[modelId] ?? { provider: "google", modelId: "gemini-2.5-pro" };

function logToDBAsync(payload: any) {
  supabase
    .from("ai_chat_logs")
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error("DB Log Error:", error.message);
    });
}

function extractTextContent(content: unknown): string {
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part: any) => part?.type === "text" && typeof part?.text === "string",
    );
    return textPart?.text || "";
  }
  return typeof content === "string" ? content : "";
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

interface PdfData {
  data: string;
  mimeType: "application/pdf";
}

async function* streamGoogleResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  lastMsgText: string,
): AsyncGenerator<string> {
  const history = messages
    .slice(0, -1)
    .map((message: any) => {
      const role = message?.role === "assistant" ? "model" : "user";
      if (Array.isArray(message?.content)) {
        return {
          role,
          parts: message.content
            .filter(
              (part: any) =>
                part?.type === "text" && typeof part?.text === "string",
            )
            .map((part: any) => ({ text: part.text })),
        };
      }
      return {
        role,
        parts: [
          { text: typeof message?.content === "string" ? message.content : "" },
        ],
      };
    })
    .filter((msg: any) => Array.isArray(msg.parts) && msg.parts.length > 0);

  const pdfParts = pdfs.map((pdf) => ({
    inlineData: { data: pdf.data, mimeType: pdf.mimeType },
  }));

  const result = await googleAI.models.generateContentStream({
    model: modelId,
    contents: [
      ...(pdfParts.length > 0 ? [{ role: "user", parts: pdfParts }] : []),
      ...history,
      { role: "user", parts: [{ text: lastMsgText }] },
    ],
    config: { systemInstruction: systemPrompt },
  });

  for await (const chunk of result) {
    const text = chunk.text || "";
    if (text) yield text;
  }
}

async function* streamAnthropicResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  lastMsgText: string,
): AsyncGenerator<string> {
  const pdfBlocks = pdfs.map((pdf) => ({
    type: "document",
    source: { type: "base64", media_type: pdf.mimeType, data: pdf.data },
    cache_control: { type: "ephemeral" },
  }));

  const anthropicMessages = [
    ...(pdfBlocks.length > 0 ? [{ role: "user", content: pdfBlocks }] : []),
    ...messages.slice(0, -1).map((msg: any) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: extractTextContent(msg.content),
    })),
    { role: "user", content: lastMsgText },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8096,
      system: systemPrompt,
      messages: anthropicMessages,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.statusText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return;
      try {
        const parsed = JSON.parse(raw);
        const text = parsed?.delta?.text;
        if (text) yield text;
      } catch {}
    }
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
      giveDirectAnswer = true,
      examUrl,
      solutionUrl,
      courseCode,
      modelId = "gemini-2.5-pro",
    } = body as any;

    if (!examUrl || !messages?.length) {
      throw new HTTPException(400, { message: "Missing examUrl or messages" });
    }

    const { provider, modelId: resolvedModelId } = getModelConfig(modelId);
    const lastMsgText = extractTextContent(
      messages[messages.length - 1]?.content,
    );

    console.log(`
┌─ AI REQUEST: ${courseCode} ────────┐
│ Exam ID:  ${examId}
│ Provider: ${provider}
│ Model:    ${resolvedModelId}
│ PDF:      ${examUrl}
└──────────────────────────────────────┘`);

    logToDBAsync({
      anonymous_user_id: c.req.header("x-anonymous-user-id") || "unknown",
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

    const systemPrompt = [SYSTEM_PROMPT, !giveDirectAnswer ? HINT_MODE : ""]
      .filter(Boolean)
      .join("\n");

    const responseStream =
      provider === "anthropic"
        ? streamAnthropicResponse(
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
        anonymous_user_id: c.req.header("x-anonymous-user-id") || "unknown",
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
