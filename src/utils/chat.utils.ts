import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { LRUCache } from "lru-cache";

export interface PdfData {
  data: string;
  mimeType: "application/pdf";
  label: "tenta" | "facit";
}

function getPdfLabelText(label: "tenta" | "facit"): string {
  return label === "tenta"
    ? "Bifogad PDF: tentan med uppgifterna. Lös endast det användaren uttryckligen ber om."
    : "Bifogad PDF: facit. Använd endast som referens när användaren frågar om en specifik uppgift, och redovisa aldrig lösningar oombedd.";
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

const googleAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
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
  lastMsgText: string,
  selectionContext?: string,
): AsyncGenerator<string> {
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
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\n${lastMsgText}`
    : lastMsgText;

  const conversationMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: lastMsgWithContext },
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
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    messages: requestMessages,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      event.delta.text
    ) {
      yield event.delta.text;
    }
  }
}

async function* streamGeminiResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  lastMsgText: string,
  selectionContext?: string,
  cacheKey?: string,
): AsyncGenerator<string> {
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
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\n${lastMsgText}`
    : lastMsgText;

  const lastUserTurn = {
    role: "user",
    parts: [{ text: lastMsgWithContext }],
  };

  let cachedContentName: string | undefined = undefined;

  if (pdfs.length > 0 && cacheKey) {
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
    },
  });

  for await (const chunk of responseStream) {
    if (chunk.text) {
      yield chunk.text;
    }
  }
}

export { streamAnthropicResponse, streamGeminiResponse };
