import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { LRUCache } from "lru-cache";
import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { ValidatedChatAttachment } from "~/api/v1/chat.attachments";

export interface PdfData {
  data: string;
  mimeType: "application/pdf";
  label: "tenta" | "facit";
}

export interface ChatSource {
  title: string;
  url: string;
}

/**
 * The provider generators used to yield plain strings, which left no room to say
 * anything about a turn other than its text. Web search means a turn now does
 * visible work before it answers, so they yield framed events instead and the
 * route decides how to put them on the wire.
 */
export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "status"; step: "searching" | "search_done"; message: string }
  | { type: "sources"; items: ChatSource[] };

function getPdfLabelText(label: "tenta" | "facit"): string {
  return label === "tenta"
    ? "Bifogad PDF: tentan med uppgifterna. Lös endast det användaren uttryckligen ber om."
    : "Bifogad PDF: facit. Använd endast som referens när användaren frågar om en specifik uppgift, och redovisa aldrig lösningar oombedd.";
}

function getUserAttachmentLabelText(filename: string): string {
  return `Material som användaren själv har bifogat (${filename}). Använd det som kontext för den aktuella frågan.`;
}

export function buildAnthropicLastUserContent(
  userAttachments: ValidatedChatAttachment[],
  text: string,
): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const attachment of userAttachments) {
    content.push({
      type: "text",
      text: getUserAttachmentLabelText(attachment.filename),
    });
    if (attachment.mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: attachment.data,
        },
      });
    } else {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: attachment.data,
        },
      });
    }
  }
  content.push({ type: "text", text });
  return content;
}

export function buildGeminiAttachmentParts(
  userAttachments: ValidatedChatAttachment[],
) {
  return userAttachments.flatMap((attachment) => [
    { text: getUserAttachmentLabelText(attachment.filename) },
    {
      inlineData: {
        mimeType: attachment.mediaType,
        data: attachment.data,
      },
    },
  ]);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

const googleAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const geminiCacheStore = new LRUCache<string, string>({
  max: 100,
  ttl: 55 * 60 * 1000,
});

async function* streamAnthropicResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  userAttachments: ValidatedChatAttachment[],
  lastMsgText: string,
  selectionContext?: string,
): AsyncGenerator<ChatStreamEvent> {
  const history: Anthropic.MessageParam[] = messages
    .slice(0, -1)
    .map((message: any) => {
      const role: "user" | "assistant" =
        message?.role === "assistant" ? "assistant" : "user";
      if (Array.isArray(message?.content)) {
        const text = message.content
          .filter(
            (part: any) =>
              part?.type === "text" && typeof part?.text === "string",
          )
          .map((part: any) => part.text)
          .join("\n");
        return { role, content: text };
      }
      return {
        role,
        content: typeof message?.content === "string" ? message.content : "",
      };
    })
    .filter((msg) => typeof msg.content === "string" && msg.content.length > 0);

  const lastMsgWithContext = selectionContext
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\nAnvändarens fråga: ${lastMsgText}`
    : `Användarens fråga: ${lastMsgText}`;

  const lastUserContent = buildAnthropicLastUserContent(
    userAttachments,
    lastMsgWithContext,
  );

  const conversationMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: lastUserContent },
  ];

  let requestMessages = conversationMessages;

  if (pdfs.length > 0) {
    const pdfBlocks: Anthropic.ContentBlockParam[] = pdfs.flatMap((pdf) => [
      { type: "text" as const, text: getPdfLabelText(pdf.label) },
      {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: pdf.data,
        },
      },
    ]);
    (pdfBlocks[pdfBlocks.length - 1] as any).cache_control = {
      type: "ephemeral",
      ttl: "1h",
    };
    requestMessages = [
      { role: "user", content: pdfBlocks },
      {
        role: "assistant",
        content: "Jag har läst igenom de bifogade filerna.",
      },
      ...conversationMessages,
    ];
  }

  const supportsAdaptiveThinking = !modelId.startsWith("claude-haiku");

  const stream = anthropic.messages.stream({
    model: modelId,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    ...(supportsAdaptiveThinking
      ? {
          thinking: { type: "adaptive" as const },
          // Default effort is "high", which on a $15/MTok output tier buys more
          // reasoning than tenta-help needs. Medium keeps adaptive thinking on
          // while pulling the token spend back.
          output_config: { effort: "medium" as const },
        }
      : {}),
    messages: requestMessages,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      event.delta.text
    ) {
      yield { type: "text", delta: event.delta.text };
    }
  }
}

async function* streamGeminiResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  userAttachments: ValidatedChatAttachment[],
  lastMsgText: string,
  selectionContext?: string,
  cacheKey?: string,
  webSearch = false,
): AsyncGenerator<ChatStreamEvent> {
  const history = messages
    .slice(0, -1)
    .map((message: any) => {
      const role = message?.role === "assistant" ? "model" : "user";
      let text = "";
      if (Array.isArray(message?.content)) {
        text = message.content
          .filter(
            (part: any) =>
              part?.type === "text" && typeof part?.text === "string",
          )
          .map((part: any) => part.text)
          .join("\n");
      } else if (typeof message?.content === "string") {
        text = message.content;
      }
      return {
        role,
        parts: [{ text }],
      };
    })
    .filter((msg) => msg.parts[0]?.text.length > 0);

  const lastMsgWithContext = selectionContext
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\nAnvändarens fråga: ${lastMsgText}`
    : `Användarens fråga: ${lastMsgText}`;

  const attachmentParts = buildGeminiAttachmentParts(userAttachments);

  const lastUserTurn = {
    role: "user",
    parts: [...attachmentParts, { text: lastMsgWithContext }],
  };

  let cachedContentName: string | undefined = undefined;

  // An explicit cache fixes its tool set at creation time, so a cached entry
  // built without googleSearch cannot be reused for a grounded turn. Search-on
  // turns are the rare case, so they inline the PDFs instead of forcing a second
  // cache variant keyed by search.
  if (pdfs.length > 0 && cacheKey && !webSearch) {
    const fullCacheKey = `${modelId}:${cacheKey}`;
    const cached = geminiCacheStore.get(fullCacheKey);
    if (cached) {
      cachedContentName = cached;
    } else {
      try {
        const pdfParts = pdfs.flatMap((pdf) => [
          { text: getPdfLabelText(pdf.label) },
          {
            inlineData: {
              mimeType: pdf.mimeType,
              data: pdf.data,
            },
          },
        ]);
        const createdCache = await googleAi.caches.create({
          model: modelId,
          contents: [
            {
              role: "user",
              parts: pdfParts,
            },
          ],
          config: {
            systemInstruction: systemPrompt,
            contents: [
              {
                role: "user",
                parts: pdfParts,
              },
            ],
            ttl: "3600s",
          },
        });
        if (createdCache?.name) {
          cachedContentName = createdCache.name;
          geminiCacheStore.set(fullCacheKey, cachedContentName);
        }
      } catch (err: any) {
        console.debug("Gemini context caching fallback:", err?.message || err);
      }
    }
  }

  let contents: any[] = [];
  if (!cachedContentName && pdfs.length > 0) {
    const pdfParts = pdfs.flatMap((pdf) => [
      { text: getPdfLabelText(pdf.label) },
      {
        inlineData: {
          mimeType: pdf.mimeType,
          data: pdf.data,
        },
      },
    ]);
    contents = [
      {
        role: "user",
        parts: pdfParts,
      },
      {
        role: "model",
        parts: [{ text: "Jag har läst igenom de bifogade filerna." }],
      },
      ...history,
      lastUserTurn,
    ];
  } else {
    contents = [...history, lastUserTurn];
  }

  const responseStream = await googleAi.models.generateContentStream({
    model: modelId,
    contents,
    config: {
      ...(cachedContentName
        ? { cachedContent: cachedContentName }
        : { systemInstruction: systemPrompt }),
      ...(webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    },
  });

  // Unlike OpenAI, Gemini gives no in-progress signal: the search runs server
  // side and only surfaces in groundingMetadata, often on a late chunk. So this
  // status is optimistic — we say "searching" the moment the request is out, then
  // either refine it with the real query or clear it when text starts arriving.
  if (webSearch) {
    yield { type: "status", step: "searching", message: "Söker på webben" };
  }

  const sources = new Map<string, ChatSource>();
  let searching = webSearch;

  for await (const chunk of responseStream) {
    const grounding = chunk.candidates?.[0]?.groundingMetadata;

    if (grounding) {
      for (const groundingChunk of grounding.groundingChunks ?? []) {
        const url = groundingChunk.web?.uri;
        if (url && !sources.has(url)) {
          sources.set(url, { title: groundingChunk.web?.title || url, url });
        }
      }
    }

    if (chunk.text) {
      if (searching) {
        searching = false;
        yield { type: "status", step: "search_done", message: "Läser källor" };
      }
      yield { type: "text", delta: chunk.text };
    }
  }

  if (searching) {
    yield { type: "status", step: "search_done", message: "" };
  }
  if (sources.size > 0) {
    yield { type: "sources", items: [...sources.values()] };
  }
}

export function buildOpenAIInput(
  messages: any[],
  pdfs: PdfData[],
  userAttachments: ValidatedChatAttachment[],
  lastMsgText: string,
  selectionContext?: string,
): ResponseInput {
  const history: ResponseInput = messages
    .slice(0, -1)
    .map((message: any) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      let content = "";

      if (Array.isArray(message?.content)) {
        content = message.content
          .filter(
            (part: any) =>
              part?.type === "text" && typeof part?.text === "string",
          )
          .map((part: any) => part.text)
          .join("\n");
      } else if (typeof message?.content === "string") {
        content = message.content;
      }

      return { role, content };
    })
    .filter(
      (message) =>
        typeof message.content === "string" && message.content.length > 0,
    );

  const lastMsgWithContext = selectionContext
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\nAnvändarens fråga: ${lastMsgText}`
    : `Användarens fråga: ${lastMsgText}`;

  const userAttachmentParts = userAttachments.flatMap((attachment) => [
    {
      type: "input_text" as const,
      text: getUserAttachmentLabelText(attachment.filename),
    },
    attachment.mediaType === "application/pdf"
      ? {
          type: "input_file" as const,
          filename: attachment.filename,
          file_data: `data:${attachment.mediaType};base64,${attachment.data}`,
        }
      : {
          type: "input_image" as const,
          image_url: `data:${attachment.mediaType};base64,${attachment.data}`,
          detail: "auto" as const,
        },
  ]);

  const conversationMessages: ResponseInput = [
    ...history,
    {
      role: "user",
      content:
        userAttachmentParts.length > 0
          ? [
              ...userAttachmentParts,
              { type: "input_text", text: lastMsgWithContext },
            ]
          : lastMsgWithContext,
    },
  ];

  if (pdfs.length === 0) return conversationMessages;

  return [
    {
      role: "user",
      content: pdfs.flatMap((pdf) => [
        { type: "input_text" as const, text: getPdfLabelText(pdf.label) },
        {
          type: "input_file" as const,
          filename: `${pdf.label}.pdf`,
          file_data: `data:${pdf.mimeType};base64,${pdf.data}`,
          detail: "auto" as const,
        },
      ]),
    },
    {
      role: "assistant",
      content: "Jag har läst igenom de bifogade filerna.",
    },
    ...conversationMessages,
  ];
}

/**
 * OpenAI caps `prompt_cache_key` at 64 characters, and the conversation cache key
 * is a pair of full storage URLs. Hashing keeps it stable per exam+facit — which
 * is all the routing hint needs — while fitting the limit. Callers keep the long
 * key, since the Gemini cache store wants the unambiguous form.
 */
function toPromptCacheKey(cacheKey: string): string {
  return createHash("sha256").update(cacheKey).digest("hex").slice(0, 32);
}

/**
 * The tier a student picks is meant to buy more thinking, not just a bigger
 * model. Without this the deep tier would reason exactly as briefly as the
 * balanced one and only cost more.
 */
function reasoningEffortFor(modelId: string): "low" | "medium" {
  return modelId === "gpt-5.6-terra" ? "medium" : "low";
}

async function* streamOpenAIResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  userAttachments: ValidatedChatAttachment[],
  lastMsgText: string,
  selectionContext?: string,
  cacheKey?: string,
  webSearch = false,
  client: Pick<OpenAI, "responses"> = openai,
): AsyncGenerator<ChatStreamEvent> {
  const responseStream = await client.responses.create({
    model: modelId,
    instructions: systemPrompt,
    input: buildOpenAIInput(
      messages,
      pdfs,
      userAttachments,
      lastMsgText,
      selectionContext,
    ),
    max_output_tokens: 16000,
    reasoning: { effort: reasoningEffortFor(modelId) },
    // Automatic prompt caching keys off the prefix, but the hit rate depends on
    // same-prefix requests routing together. The exam PDFs are that prefix, so
    // their cache key is the right routing hint.
    ...(cacheKey ? { prompt_cache_key: toPromptCacheKey(cacheKey) } : {}),
    // "low" context keeps the search-content block that gets billed into the
    // prompt small. A tenta question needs a fact, not a literature review.
    ...(webSearch
      ? {
          tools: [
            { type: "web_search" as const, search_context_size: "low" as const },
          ],
        }
      : {}),
    store: false,
    stream: true,
  });

  const sources = new Map<string, ChatSource>();
  let searching = false;

  for await (const event of responseStream) {
    switch (event.type) {
      // OpenAI does not reveal the query until the search has already finished
      // (the item carries `action.query` only on output_item.done, after
      // .completed), so there is no honest way to name it while it runs. The
      // status stays generic here; Gemini is the one that can be specific.
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
        if (searching) break;
        searching = true;
        yield { type: "status", step: "searching", message: "Söker på webben" };
        break;

      case "response.web_search_call.completed":
        searching = false;
        yield { type: "status", step: "search_done", message: "Läser källor" };
        break;

      case "response.output_text.annotation.added": {
        const annotation = event.annotation as any;
        if (annotation?.type !== "url_citation" || !annotation.url) break;
        if (!sources.has(annotation.url)) {
          sources.set(annotation.url, {
            title: annotation.title || annotation.url,
            url: annotation.url,
          });
        }
        break;
      }

      case "response.output_text.delta":
        if (event.delta) yield { type: "text", delta: event.delta };
        break;
    }
  }

  if (searching) {
    yield { type: "status", step: "search_done", message: "" };
  }
  if (sources.size > 0) {
    yield { type: "sources", items: [...sources.values()] };
  }
}

export {
  streamAnthropicResponse,
  streamGeminiResponse,
  streamOpenAIResponse,
};
