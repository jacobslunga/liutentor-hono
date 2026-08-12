import { describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_MODEL_ID,
  getModelConfig,
} from "../src/api/v1/chat.models";
import {
  buildOpenAIInput,
  streamOpenAIResponse,
  type PdfData,
} from "../src/utils/chat.utils";

describe("chat model routing", () => {
  it("routes Terra and Luna through OpenAI", () => {
    expect(getModelConfig("gpt-5.6-terra")).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    });
    expect(getModelConfig("gpt-5.6-luna")).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    });
  });

  it("falls back to Luna for omitted or unknown model IDs", () => {
    expect(getModelConfig()).toEqual({
      provider: "openai",
      modelId: DEFAULT_MODEL_ID,
    });
    expect(getModelConfig("unknown-model")).toEqual({
      provider: "openai",
      modelId: DEFAULT_MODEL_ID,
    });
  });
});

describe("OpenAI chat streaming", () => {
  const pdfs: PdfData[] = [
    { data: "exam-data", mimeType: "application/pdf", label: "tenta" },
    { data: "solution-data", mimeType: "application/pdf", label: "facit" },
  ];

  it("builds input with PDFs, history, and selection context", () => {
    const input = buildOpenAIInput(
      [
        { role: "user", content: "Tidigare fråga" },
        { role: "assistant", content: "Tidigare svar" },
        { role: "user", content: "Ny fråga" },
      ],
      pdfs,
      "Ny fråga",
      "markerad text",
    );

    expect(input[0]).toMatchObject({ role: "user" });
    expect((input[0] as any).content).toEqual([
      expect.objectContaining({ type: "input_text" }),
      {
        type: "input_file",
        filename: "tenta.pdf",
        file_data: "data:application/pdf;base64,exam-data",
        detail: "auto",
      },
      expect.objectContaining({ type: "input_text" }),
      {
        type: "input_file",
        filename: "facit.pdf",
        file_data: "data:application/pdf;base64,solution-data",
        detail: "auto",
      },
    ]);
    expect(input.slice(1)).toEqual([
      { role: "assistant", content: "Jag har läst igenom de bifogade filerna." },
      { role: "user", content: "Tidigare fråga" },
      { role: "assistant", content: "Tidigare svar" },
      {
        role: "user",
        content:
          '[Användaren hänvisar till följande markerade text:\n"markerad text"]\n\nAnvändarens fråga: Ny fråga',
      },
    ]);
  });

  it("requests low-effort streaming and yields only text deltas", async () => {
    const create = mock(async () =>
      (async function* () {
        yield { type: "response.created" };
        yield { type: "response.output_text.delta", delta: "Hej" };
        yield { type: "response.output_text.delta", delta: " världen" };
        yield { type: "response.completed" };
      })(),
    );
    const client = { responses: { create } } as any;

    const chunks: string[] = [];
    for await (const chunk of streamOpenAIResponse(
      "Systemprompt",
      [{ role: "user", content: "Fråga" }],
      "gpt-5.6-luna",
      [],
      "Fråga",
      undefined,
      client,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hej", " världen"]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-luna",
        instructions: "Systemprompt",
        max_output_tokens: 16000,
        reasoning: { effort: "low" },
        store: false,
        stream: true,
      }),
    );
  });
});
