import { describe, expect, it, mock } from "bun:test";
import {
  CHAT_TIER_IDS,
  DEFAULT_MODEL_ID,
  LUNA_CHAT_MODEL_ID,
  TERRA_CHAT_MODEL_ID,
  getModelConfig,
  getModelLogId,
} from "../src/api/v1/chat.models";
import {
  buildOpenAIInput,
  streamOpenAIResponse,
  type PdfData,
} from "../src/utils/chat.utils";

describe("chat model routing", () => {
  it("uses Luna/default, Luna/high, and Terra/high for the three tiers", () => {
    expect(getModelConfig(CHAT_TIER_IDS.low)).toMatchObject({
      provider: "openai",
      modelId: LUNA_CHAT_MODEL_ID,
      effort: "medium",
    });
    expect(getModelConfig(CHAT_TIER_IDS.balanced)).toMatchObject({
      provider: "openai",
      modelId: LUNA_CHAT_MODEL_ID,
      effort: "high",
    });
    expect(getModelConfig(CHAT_TIER_IDS.deep)).toMatchObject({
      provider: "openai",
      modelId: TERRA_CHAT_MODEL_ID,
      effort: "high",
      requiresAuth: true,
    });
  });

  it("falls back to the base tier for omitted, empty, or unknown IDs", () => {
    expect(DEFAULT_MODEL_ID).toBe(CHAT_TIER_IDS.low);
    for (const id of [undefined, "", "unknown-model"]) {
      expect(getModelConfig(id)).toMatchObject({
        provider: "openai",
        modelId: LUNA_CHAT_MODEL_ID,
        effort: "medium",
      });
    }
  });

  it("keeps old clients compatible while preserving deep-tier auth", () => {
    expect(getModelConfig("gemini-flash-lite-minimal").effort).toBe("medium");
    expect(getModelConfig("gemini-flash-lite-medium").effort).toBe("high");
    expect(getModelConfig("gemini-flash-lite-high")).toMatchObject({
      modelId: TERRA_CHAT_MODEL_ID,
      effort: "high",
      requiresAuth: true,
    });
    expect(getModelConfig("gpt-5.6-luna").effort).toBe("high");
    expect(getModelConfig("gpt-5.6-terra").requiresAuth).toBe(true);
  });

  it("marks every tier as searchable and includes effort in logs", () => {
    for (const id of Object.values(CHAT_TIER_IDS)) {
      const config = getModelConfig(id);
      expect(config.supportsWebSearch).toBe(true);
      expect(getModelLogId(config)).toBe(`${config.modelId}:${config.effort}`);
    }
  });
});

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

  it("builds native OpenAI input for PDFs, images, and history", () => {
    const input = buildOpenAIInput(
      [
        { role: "user", content: "Tidigare fråga" },
        { role: "assistant", content: "Tidigare svar" },
        { role: "user", content: "Ny fråga" },
      ],
      pdfs,
      userAttachments,
      "Ny fråga",
      "markerad text",
    );

    expect((input[0] as any).content).toEqual([
      expect.objectContaining({ type: "input_text" }),
      expect.objectContaining({ type: "input_file", filename: "tenta.pdf" }),
      expect.objectContaining({ type: "input_text" }),
      expect.objectContaining({ type: "input_file", filename: "facit.pdf" }),
    ]);
    expect((input.at(-1) as any).content).toEqual([
      expect.objectContaining({
        type: "input_text",
        text: expect.stringContaining("anteckningar.pdf"),
      }),
      expect.objectContaining({ type: "input_file" }),
      expect.objectContaining({
        type: "input_text",
        text: expect.stringContaining("figur.png"),
      }),
      expect.objectContaining({ type: "input_image" }),
      expect.objectContaining({
        type: "input_text",
        text: expect.stringContaining("markerad text"),
      }),
    ]);
  });

  it("passes the selected effort and streams text deltas", async () => {
    const create = mock(async (_request: any) =>
      (async function* () {
        yield { type: "response.output_text.delta", delta: "Hej" };
        yield { type: "response.output_text.delta", delta: " världen" };
        yield { type: "response.completed" };
      })(),
    );

    const chunks: string[] = [];
    for await (const event of streamOpenAIResponse(
      "Systemprompt",
      [{ role: "user", content: "Fråga" }],
      LUNA_CHAT_MODEL_ID,
      [],
      [],
      "Fråga",
      undefined,
      "exam:solution",
      false,
      "high",
      { responses: { create } } as any,
    )) {
      if (event.type === "text") chunks.push(event.delta);
    }

    expect(chunks).toEqual(["Hej", " världen"]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: LUNA_CHAT_MODEL_ID,
        instructions: "Systemprompt",
        reasoning: { effort: "high" },
        store: false,
        stream: true,
      }),
    );
    const request = create.mock.calls[0]![0] as any;
    expect(request.prompt_cache_key.length).toBeLessThanOrEqual(64);
    expect(request).not.toHaveProperty("tools");
  });

  it("adds web search only when requested and emits status and sources", async () => {
    const create = mock(async (_request: any) =>
      (async function* () {
        yield { type: "response.web_search_call.searching" };
        yield { type: "response.web_search_call.completed" };
        yield {
          type: "response.output_text.annotation.added",
          annotation: {
            type: "url_citation",
            url: "https://liu.se/tenta",
            title: "Tentaperioder",
          },
        };
        yield { type: "response.output_text.delta", delta: "Svar" };
      })(),
    );

    const events: any[] = [];
    for await (const event of streamOpenAIResponse(
      "Systemprompt",
      [{ role: "user", content: "Fråga" }],
      LUNA_CHAT_MODEL_ID,
      [],
      [],
      "Fråga",
      undefined,
      undefined,
      true,
      "medium",
      { responses: { create } } as any,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", step: "searching", message: "Söker på webben" },
      { type: "status", step: "search_done", message: "Läser källor" },
      { type: "text", delta: "Svar" },
      {
        type: "sources",
        items: [{ title: "Tentaperioder", url: "https://liu.se/tenta" }],
      },
    ]);
    expect((create.mock.calls[0]![0] as any).tools).toEqual([
      { type: "web_search", search_context_size: "low" },
    ]);
  });
});
