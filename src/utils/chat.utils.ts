import { GoogleGenAI } from "@google/genai";

export interface PdfData {
  data: string;
  mimeType: "application/pdf";
  label: "tenta" | "facit";
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

function getPdfLabelText(label: "tenta" | "facit"): string {
  return label === "tenta"
    ? "FÖLJANDE PDF ÄR TENTAN MED UPPGIFTERNA DU SKA LÖSA:"
    : "FÖLJANDE PDF ÄR FACIT — ANVÄND ENDAST FÖR VERIFIERING, HÄRLED ALLTID LÖSNINGEN SJÄLV:";
}

const googleAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
});

async function* streamGoogleResponse(
  systemPrompt: string,
  messages: any[],
  modelId: string,
  pdfs: PdfData[],
  lastMsgText: string,
  selectionContext?: string,
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

  const pdfParts = pdfs.flatMap((pdf) => [
    { text: getPdfLabelText(pdf.label) },
    { inlineData: { data: pdf.data, mimeType: pdf.mimeType } },
  ]);

  const lastMsgWithContext = selectionContext
    ? `[Användaren hänvisar till följande markerade text:\n"${selectionContext}"]\n\n${lastMsgText}`
    : lastMsgText;

  const result = await googleAI.models.generateContentStream({
    model: modelId,
    contents: [
      ...(pdfParts.length > 0 ? [{ role: "user", parts: pdfParts }] : []),
      ...history,
      { role: "user", parts: [{ text: lastMsgWithContext }] },
    ],
    config: { systemInstruction: systemPrompt },
  });

  for await (const chunk of result) {
    const text = chunk.text || "";
    if (text) yield text;
  }
}

export { streamGoogleResponse };
