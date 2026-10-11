import { describe, expect, it, mock } from "bun:test";
import {
  CHAT_MODEL_IDS,
  MODEL_MAP,
  LUNA_CHAT_MODEL_ID,
  getModelConfig,
  getModelLogId,
} from "../src/api/v1/chat.models";
import {
  chatMessageSchema,
  learnMessageSchema,
} from "../src/api/v1/chat.schemas";
import {
  buildOpenAIInput,
  generateConversationTitle,
  streamOpenAIResponse,
  type PdfData,
} from "../src/utils/chat.utils";

describe("chat model routing", () => {
  it("routes Luna to fast or thinking by effort", () => {
    expect(getModelConfig(LUNA_CHAT_MODEL_ID)).toEqual(MODEL_MAP.fast);
    expect(getModelConfig(LUNA_CHAT_MODEL_ID, "high")).toEqual(MODEL_MAP.thinking);
    expect(MODEL_MAP.thinking.requiresAuth).toBe(true);
  });

  it("validates effort for both routes and defaults older requests to low", () => {
    for (const schema of [chatMessageSchema, learnMessageSchema]) {
      const body = {
        messages: [{ role: "user", content: "Hej" }],
        examUrl: "https://example.com/exam.pdf",
        courseCode: "TATA41",
        modelId: LUNA_CHAT_MODEL_ID,
      };
      expect(schema.parse(body).effort).toBe("low");
      expect(schema.parse({ ...body, effort: "high" }).effort).toBe("high");
      expect(schema.safeParse({ ...body, effort: "medium" }).success).toBe(false);
    }
  });

  it("rejects missing, unknown, alias, and incorrectly cased IDs in both routes", () => {
    for (const schema of [chatMessageSchema, learnMessageSchema]) {
      const body = {
        messages: [{ role: "user", content: "Hej" }],
        examUrl: "https://example.com/exam.pdf",
        courseCode: "TATA41",
      };
      for (const modelId of CHAT_MODEL_IDS) {
        expect(schema.safeParse({ ...body, modelId }).success).toBe(true);
      }
      for (const modelId of [
        undefined,
        "",
        "unknown-model",
        "fast",
        "thinking",
        "gpt-6-sol",
        "GPT-6-LUNA",
        "gpt-6-luna-low",
      ]) {
        expect(schema.safeParse({ ...body, modelId }).success).toBe(false);
      }
    }
  });

  it("marks both models as searchable and includes effort in logs", () => {
    for (const id of CHAT_MODEL_IDS) {
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
    // Reference material must not fabricate an assistant turn before history.
    expect(input.slice(1, -1)).toEqual([
      { role: "user", content: "Tidigare fråga" },
      { role: "assistant", content: "Tidigare svar" },
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

  it("preserves the student's question without a language-bearing wrapper", () => {
    for (const question of ["Explain eigenvalues", "Förklara egenvärden", "5"]) {
      expect(buildOpenAIInput([], [], [], question)).toEqual([
        { role: "user", content: question },
      ]);
    }
  });

  it("keeps selected reference text separate from the actual question", () => {
    const input = buildOpenAIInput(
      [], [], [], "Why is this true?", "Varje bas har lika många vektorer.",
    );
    const content = (input[0] as any).content as string;
    expect(content).toContain("Varje bas har lika många vektorer.");
    expect(content).toEndWith("Student's question: Why is this true?");
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
      {},
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

  it("searches course material and cites files", async () => {
    const create = mock(async (_request: any) =>
      (async function* () {
        yield { type: "response.file_search_call.searching" };
        yield { type: "response.file_search_call.completed" };
        yield {
          type: "response.output_text.annotation.added",
          annotation: {
            type: "file_citation",
            file_id: "file-abc",
            filename: "Föreläsning 3.pdf",
            index: 0,
          },
        };
        yield {
          type: "response.output_text.annotation.added",
          annotation: {
            type: "file_citation",
            file_id: "file-abc",
            filename: "Föreläsning 3.pdf",
            index: 1,
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
      { vectorStoreId: "vs_123" },
      "medium",
      { responses: { create } } as any,
    )) {
      events.push(event);
    }

    const request = create.mock.calls[0]![0] as any;
    expect(request.tools).toEqual([
      { type: "file_search", vector_store_ids: ["vs_123"], max_num_results: 8 },
    ]);
    expect(events).toEqual([
      { type: "status", step: "searching", message: "Söker i kursmaterialet" },
      { type: "status", step: "search_done", message: "Läser material" },
      { type: "text", delta: "Svar" },
      {
        type: "sources",
        items: [
          { type: "file", title: "Föreläsning 3.pdf", fileId: "file-abc" },
        ],
      },
    ]);
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
      { webSearch: true },
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

describe("conversation title generation", () => {
  it("uses the fast model with course, question, and answer context", async () => {
    const create = mock(async (_request: any) => ({
      status: "completed",
      output_text: '  "Lösning av uppgift 3"  ',
    }));

    const title = await generateConversationTitle(
      "TSFS12",
      "Hur löser man fråga 3?",
      "Vi börjar med att Laplacetransformera systemet.",
      { responses: { create } } as any,
    );

    expect(title).toBe("Lösning av uppgift 3");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: LUNA_CHAT_MODEL_ID,
        max_output_tokens: 256,
        reasoning: { effort: "low" },
        store: false,
      }),
    );
    const request = create.mock.calls[0]![0] as any;
    expect(request.input).toContain("TSFS12");
    expect(request.input).toContain("Hur löser man fråga 3?");
    expect(request.input).toContain("Laplacetransformera");
  });

  it("normalizes whitespace and caps overly long titles", async () => {
    const create = mock(async (_request: any) => ({
      status: "completed",
      output_text: `  ${"väldigt lång titel ".repeat(8)}  `,
    }));

    const title = await generateConversationTitle("TDDD01", "Fråga", "Svar", {
      responses: { create },
    } as any);

    expect(title?.length).toBeLessThanOrEqual(60);
    expect(title?.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("rejects truncated responses instead of saving a partial title", async () => {
    const create = mock(async (_request: any) => ({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "Lös",
    }));

    const title = await generateConversationTitle("TSRT22", "Fråga", "Svar", {
      responses: { create },
    } as any);

    expect(title).toBeNull();
  });

  it("rejects implausibly short titles even from completed responses", async () => {
    const create = mock(async (_request: any) => ({
      status: "completed",
      output_text: "Lös",
    }));

    const title = await generateConversationTitle("TSRT22", "Fråga", "Svar", {
      responses: { create },
    } as any);

    expect(title).toBeNull();
  });
});
