import Anthropic from "@anthropic-ai/sdk";

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

  const lastMsgWithContext = selectionContext
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\n${lastMsgText}`
    : lastMsgText;

  // Adaptive thinking exists on Claude 4.6+; Haiku 4.5 rejects it.
  const supportsAdaptiveThinking = !modelId.startsWith("claude-haiku");

  const stream = anthropic.messages.stream({
    model: modelId,
    max_tokens: 16000,
    system: systemPrompt,
    ...(supportsAdaptiveThinking
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    messages: [
      ...history,
      {
        role: "user",
        content: [
          ...pdfBlocks,
          { type: "text", text: lastMsgWithContext },
        ],
      },
    ],
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

export { streamAnthropicResponse };
