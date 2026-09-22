import { describe, expect, it, mock } from "bun:test";
import {
  generateQuizFromOpenAI,
  QUIZ_MODEL,
  QUIZ_REASONING_EFFORT,
} from "../src/api/v1/quiz.route";
import {
  QUIZ_DIFFICULTY_PROMPTS,
  QUIZ_MULTIPLE_CHOICE_PROMPT,
} from "../src/utils/prompts";
import { quizDifficultySchema } from "../src/api/v1/quiz.schemas";

describe("OpenAI quiz generation", () => {
  it("uses PDF input, structured JSON, and high thinking", async () => {
    const quiz = {
      quiz: {
        questions: Array.from({ length: 10 }, (_, index) => ({
          id: index + 1,
          question: `Vilket svar är korrekt för fråga ${index + 1}?`,
          options: ["A", "B", "C", "D"],
          answer: index % 4,
        })),
      },
    };
    const create = mock(async (_request: any) => ({
      output_text: JSON.stringify(quiz),
    }));

    const result = await generateQuizFromOpenAI(
      [{ data: "pdf-data", mimeType: "application/pdf" }],
      "Skapa ett quiz för TATA41",
      { responses: { create } } as any,
    );

    expect(result).toEqual(quiz);
    const request = create.mock.calls[0]![0] as any;
    expect(request).toMatchObject({
      model: QUIZ_MODEL,
      reasoning: { effort: QUIZ_REASONING_EFFORT },
      max_output_tokens: 8000,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "multiple_choice_quiz",
          strict: true,
        },
      },
    });
    expect(request.text.format.schema).toBeDefined();
    expect(request.input[0].content).toEqual([
      { type: "input_text", text: "Tentamensunderlag 1:" },
      {
        type: "input_file",
        filename: "tenta-1.pdf",
        file_data: "data:application/pdf;base64,pdf-data",
      },
      {
        type: "input_text",
        text: expect.stringContaining("Skapa ett quiz för TATA41"),
      },
    ]);
  });

  it("rejects empty or invalid model output", async () => {
    const empty = { responses: { create: async () => ({ output_text: "" }) } };
    await expect(
      generateQuizFromOpenAI([], "Prompt", empty as any),
    ).rejects.toThrow("OpenAI returned empty response");

    const invalid = {
      responses: { create: async () => ({ output_text: '{"quiz":{}}' }) },
    };
    await expect(
      generateQuizFromOpenAI([], "Prompt", invalid as any),
    ).rejects.toThrow();
  });
});

describe("quiz difficulty prompts", () => {
  const tiers = quizDifficultySchema.options;

  it("has a distinct block for every difficulty the API accepts", () => {
    const blocks = tiers.map((tier) => QUIZ_DIFFICULTY_PROMPTS[tier]);

    for (const block of blocks) {
      expect(block.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(blocks).size).toBe(tiers.length);
  });

  it("names its own level so the model cannot mix two tiers up", () => {
    expect(QUIZ_DIFFICULTY_PROMPTS.easy).toContain("Svårighetsnivå: lätt");
    expect(QUIZ_DIFFICULTY_PROMPTS.medium).toContain("Svårighetsnivå: medel");
    expect(QUIZ_DIFFICULTY_PROMPTS.hard).toContain("Svårighetsnivå: svår");
  });

  it("leaves option length and form to the base prompt only", () => {
    // Difficulty must change what is asked, never how the options look — the
    // parity rules are what stop a student guessing on shape, so a tier that
    // relaxed them would quietly bring the "longest answer wins" tell back.
    expect(QUIZ_MULTIPLE_CHOICE_PROMPT).toContain("### Längd");

    for (const tier of tiers) {
      expect(QUIZ_DIFFICULTY_PROMPTS[tier]).not.toContain("### Längd");
      expect(QUIZ_DIFFICULTY_PROMPTS[tier]).not.toMatch(/25 %/);
    }
  });
});
