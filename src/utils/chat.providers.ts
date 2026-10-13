import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import type { ValidatedChatAttachment } from "~/api/v1/chat.attachments";
import type { Provider, ReasoningEffort } from "~/api/v1/chat.models";
import {
  getPdfLabelText,
  getUserAttachmentLabelText,
  streamOpenAIResponse,
  toTextHistory,
  withSelectionContext,
  type ChatSource,
  type ChatStreamEvent,
  type ChatTools,
  type PdfData,
} from "./chat.utils";

export interface ChatModelRequest {
  systemPrompt: string;
  messages: any[];
  modelId: string;
  pdfs: PdfData[];
  userAttachments: ValidatedChatAttachment[];
  lastMsgText: string;
  selectionContext?: string;
  cacheKey?: string;
  tools?: ChatTools;
  effort: ReasoningEffort;
}

const MAX_OUTPUT_TOKENS = 16000;
const MAX_PAUSE_TURNS = 3;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

const google = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
});

/** Streams a reply from whichever provider serves the requested model. */
export function streamChatModel(
  provider: Provider,
  request: ChatModelRequest,
): AsyncGenerator<ChatStreamEvent> {
  switch (provider) {
    case "anthropic":
      return streamAnthropicResponse(request);
    case "google":
      return streamGoogleResponse(request);
    case "openai":
      return streamOpenAIResponse(
        request.systemPrompt,
        request.messages,
        request.modelId,
        request.pdfs,
        request.userAttachments,
        request.lastMsgText,
        request.selectionContext,
        request.cacheKey,
        request.tools,
        request.effort,
      );
  }
}

export function buildAnthropicMessages({
  messages,
  pdfs,
  userAttachments,
  lastMsgText,
  selectionContext,
}: Pick<
  ChatModelRequest,
  "messages" | "pdfs" | "userAttachments" | "lastMsgText" | "selectionContext"
>): Anthropic.MessageParam[] {
  // The conversation has to open with a user turn.
  const history = toTextHistory(messages);
  while (history[0]?.role === "assistant") history.shift();

  const attachmentBlocks: Anthropic.ContentBlockParam[] = userAttachments.flatMap(
    (attachment) => [
      {
        type: "text" as const,
        text: getUserAttachmentLabelText(attachment.filename),
      },
      attachment.mediaType === "application/pdf"
        ? {
            type: "document" as const,
            title: attachment.filename,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: attachment.data,
            },
          }
        : {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: attachment.mediaType,
              data: attachment.data,
            },
          },
    ],
  );

  const lastTurn: Anthropic.MessageParam = {
    role: "user",
    content: [
      ...attachmentBlocks,
      { type: "text", text: withSelectionContext(lastMsgText, selectionContext) },
    ],
  };

  const reference: Anthropic.MessageParam[] = pdfs.length
    ? [
        {
          role: "user",
          content: pdfs.flatMap((pdf, i): Anthropic.ContentBlockParam[] => [
            { type: "text", text: getPdfLabelText(pdf.label) },
            {
              type: "document",
              title: `${pdf.label}.pdf`,
              source: {
                type: "base64",
                media_type: pdf.mimeType,
                data: pdf.data,
              },
              // The exam PDFs are reused every turn, so cache up to the last one.
              ...(i === pdfs.length - 1
                ? { cache_control: { type: "ephemeral" as const } }
                : {}),
            },
          ]),
        },
      ]
    : [];

  return [...reference, ...history, lastTurn];
}

async function* streamAnthropicResponse(
  request: ChatModelRequest,
): AsyncGenerator<ChatStreamEvent> {
  const { webSearch = false, signal } = request.tools ?? {};
  const messages = buildAnthropicMessages(request);
  const sources = new Map<string, ChatSource>();
  const addSource = (url: string, title?: string | null) => {
    if (!sources.has(url)) sources.set(url, { title: title || url, url });
  };
  let searching = false;

  for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
    const stream = anthropic.messages.stream(
      {
        model: request.modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort },
        ...(webSearch
          ? {
              tools: [
                {
                  type: "web_search_20250305" as const,
                  name: "web_search" as const,
                  max_uses: 3,
                },
              ],
            }
          : {}),
      },
      signal ? { signal } : undefined,
    );

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use" && block.name === "web_search") {
          if (!searching) {
            searching = true;
            yield {
              type: "status",
              step: "searching",
              message: "Söker på webben",
            };
          }
        } else if (block.type === "web_search_tool_result") {
          searching = false;
          yield { type: "status", step: "search_done", message: "Läser källor" };
          // An error comes back as a single object instead of a result list.
          if (Array.isArray(block.content)) {
            for (const result of block.content) addSource(result.url, result.title);
          }
        }
      } else if (event.type === "content_block_delta") {
        const { delta } = event;
        if (delta.type === "text_delta") {
          if (delta.text) yield { type: "text", delta: delta.text };
        } else if (
          delta.type === "citations_delta" &&
          delta.citation.type === "web_search_result_location"
        ) {
          addSource(delta.citation.url, delta.citation.title);
        }
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason !== "pause_turn") break;
    // A long server-side search pauses the turn; resend it to let it finish.
    messages.push({ role: "assistant", content: final.content });
  }

  if (searching) yield { type: "status", step: "search_done", message: "" };
  if (sources.size > 0) yield { type: "sources", items: [...sources.values()] };
}

const GEMINI_THINKING_LEVELS = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} satisfies Record<ReasoningEffort, ThinkingLevel>;

export function buildGeminiContents({
  messages,
  pdfs,
  userAttachments,
  lastMsgText,
  selectionContext,
}: Pick<
  ChatModelRequest,
  "messages" | "pdfs" | "userAttachments" | "lastMsgText" | "selectionContext"
>): Content[] {
  const history = toTextHistory(messages);
  while (history[0]?.role === "assistant") history.shift();

  const reference: Content[] = pdfs.length
    ? [
        {
          role: "user",
          parts: pdfs.flatMap((pdf): Part[] => [
            { text: getPdfLabelText(pdf.label) },
            { inlineData: { mimeType: pdf.mimeType, data: pdf.data } },
          ]),
        },
      ]
    : [];

  const lastParts: Part[] = [
    ...userAttachments.flatMap((attachment): Part[] => [
      { text: getUserAttachmentLabelText(attachment.filename) },
      { inlineData: { mimeType: attachment.mediaType, data: attachment.data } },
    ]),
    { text: withSelectionContext(lastMsgText, selectionContext) },
  ];

  return [
    ...reference,
    ...history.map(
      (turn): Content => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.content }],
      }),
    ),
    { role: "user", parts: lastParts },
  ];
}

async function* streamGoogleResponse(
  request: ChatModelRequest,
): AsyncGenerator<ChatStreamEvent> {
  const { webSearch = false, signal } = request.tools ?? {};
  const sources = new Map<string, ChatSource>();

  const stream = await google.models.generateContentStream({
    model: request.modelId,
    contents: buildGeminiContents(request),
    config: {
      systemInstruction: request.systemPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVELS[request.effort] },
      ...(webSearch ? { tools: [{ googleSearch: {} }] } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    },
  });

  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield { type: "text", delta: text };

    for (const item of chunk.candidates?.[0]?.groundingMetadata
      ?.groundingChunks ?? []) {
      const url = item.web?.uri;
      if (url && !sources.has(url)) {
        sources.set(url, { title: item.web?.title || url, url });
      }
    }
  }

  if (sources.size > 0) yield { type: "sources", items: [...sources.values()] };
}
