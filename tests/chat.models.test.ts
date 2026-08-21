import { describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_MODEL_ID,
  getModelConfig,
} from "../src/api/v1/chat.models";
import {
  buildAnthropicLastUserContent,
  buildGeminiAttachmentParts,
  buildOpenAIInput,
  streamOpenAIResponse,
  type PdfData,
} from "../src/utils/chat.utils";

describe("chat model routing", () => {
  it("routes Terra and Luna through OpenAI", () => {
    expect(getModelConfig("gpt-5.6-terra")).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    });
    expect(getModelConfig("gpt-5.6-luna")).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    });
  });

  it("falls back to Luna for omitted, empty, or unknown model IDs", () => {
    for (const id of [undefined, "", "unknown-model"]) {
      expect(getModelConfig(id)).toEqual({
        provider: "openai",
        modelId: DEFAULT_MODEL_ID,
      });
    }
  });

  it("gates the deep tier behind auth and leaves the open tiers ungated", () => {
    expect(getModelConfig("gpt-5.6-terra")).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      requiresAuth: true,
    });
    expect(getModelConfig("gpt-5.6-luna").requiresAuth).toBeUndefined();
    expect(getModelConfig("gemini-3.1-flash-lite").requiresAuth).toBeUndefined();
  });

  it("no longer serves retired models, falling back to the default tier", () => {
    for (const retired of [
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "gemini-3.6-flash",
    ]) {
      expect(getModelConfig(retired)).toEqual({
        provider: "openai",
        modelId: DEFAULT_MODEL_ID,
      });
    }
  });
});

// Shaped like production: two full Supabase storage URLs, well past 64 chars.
const LONG_CACHE_KEY =
  "https://abcdefghijklmnop.supabase.co/storage/v1/object/public/exams/TATA41/TEN1-2020-06-03.pdf:" +
  "https://abcdefghijklmnop.supabase.co/storage/v1/object/public/exams/TATA41/TEN1-2020-06-03-solutions.pdf";

describe("OpenAI chat streaming", () => {
  const pdfs: PdfData[] = [
    { data: "exam-data", mimeType: "application/pdf", label: "tenta" },
    { data: "solution-data", mimeType: "application/pdf", label: "facit" },
  ];

  const userAttachments = [
    {
      data: "user-pdf",
      filename: "anteckningar.pdf",
      mediaType: "application/pdf" as const,
    },
    {
      data: "user-image",
      filename: "figur.png",
      mediaType: "image/png" as const,
    },
  ];

  it("builds native attachment blocks for all providers", () => {
    const anthropic = buildAnthropicLastUserContent(userAttachments, "Fråga");
    expect(anthropic).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "document" }),
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image" }),
      { type: "text", text: "Fråga" },
    ]);

    const gemini = buildGeminiAttachmentParts(userAttachments);
    expect(gemini).toEqual([
      expect.objectContaining({ text: expect.any(String) }),
      { inlineData: { mimeType: "application/pdf", data: "user-pdf" } },
      expect.objectContaining({ text: expect.any(String) }),
      { inlineData: { mimeType: "image/png", data: "user-image" } },
    ]);

    const openAI = buildOpenAIInput(
      [{ role: "user", content: "Fråga" }],
      [],
      userAttachments,
      "Fråga",
    );
    expect((openAI[0] as any).content).toEqual([
      expect.objectContaining({ type: "input_text" }),
      expect.objectContaining({ type: "input_file" }),
      expect.objectContaining({ type: "input_text" }),
      expect.objectContaining({ type: "input_image" }),
      { type: "input_text", text: "Användarens fråga: Fråga" },
    ]);
  });

  it("builds input with PDFs, history, and selection context", () => {
    const input = buildOpenAIInput(
      [
        { role: "user", content: "Tidigare fråga" },
        { role: "assistant", content: "Tidigare svar" },
        { role: "user", content: "Ny fråga" },
      ],
      pdfs,
      [],
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
      [],
      "Fråga",
      undefined,
      LONG_CACHE_KEY,
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

  it("hashes the cache key to fit OpenAI's 64-char cap, stably", async () => {
    const seen: any[] = [];
    const create = async (params: any) => {
      seen.push(params);
      return (async function* () {
        yield { type: "response.completed" };
      })();
    };
    const run = (key: string) =>
      (async () => {
        for await (const _ of streamOpenAIResponse(
          "S", [{ role: "user", content: "F" }], "gpt-5.6-luna", [], [], "F",
          undefined, key, { responses: { create } } as any,
        )) { /* drained */ }
      })();

    expect(LONG_CACHE_KEY.length).toBeGreaterThan(64);
    await run(LONG_CACHE_KEY);
    await run(LONG_CACHE_KEY);
    await run(LONG_CACHE_KEY + "-other");

    expect(seen[0].prompt_cache_key.length).toBeLessThanOrEqual(64);
    // Same exam must route to the same cache, or the hint is worthless.
    expect(seen[1].prompt_cache_key).toBe(seen[0].prompt_cache_key);
    // Different exam must not collide onto it.
    expect(seen[2].prompt_cache_key).not.toBe(seen[0].prompt_cache_key);
  });

  it("gives the deep tier more reasoning effort than the balanced tier", async () => {
    const calls: any[] = [];
    const create = async (params: any) => {
      calls.push(params);
      return (async function* () {
        yield { type: "response.completed" };
      })();
    };

    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
      for await (const _ of streamOpenAIResponse(
        "Systemprompt",
        [{ role: "user", content: "Fråga" }],
        model,
        [],
        [],
        "Fråga",
        undefined,
        undefined,
        { responses: { create } } as any,
      )) {
        // drained for its side effect on `calls`
      }
    }

    expect(calls[0].reasoning).toEqual({ effort: "low" });
    expect(calls[1].reasoning).toEqual({ effort: "medium" });
  });

  it("omits the prompt cache key when there is none to pin on", async () => {
    const create = mock(async () =>
      (async function* () {
        yield { type: "response.completed" };
      })(),
    );

    for await (const _ of streamOpenAIResponse(
      "Systemprompt",
      [{ role: "user", content: "Fråga" }],
      "gpt-5.6-luna",
      [],
      [],
      "Fråga",
      undefined,
      undefined,
      { responses: { create } } as any,
    )) {
      // drained for its side effect on `create`
    }

    expect(create.mock.calls[0]![0]).not.toHaveProperty("prompt_cache_key");
  });
});
