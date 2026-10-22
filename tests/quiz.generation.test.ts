import { describe, expect, it, mock } from "bun:test";
import {
  generateQuizFromGemini,
  QUIZ_MODEL,
  QUIZ_REASONING_EFFORT,
} from "../src/api/v1/quiz.route";
import {
  QUIZ_DIFFICULTY_PROMPTS,
  QUIZ_MULTIPLE_CHOICE_PROMPT,
} from "../src/utils/prompts";
import { quizDifficultySchema } from "../src/api/v1/quiz.schemas";

describe("Gemini quiz generation", () => {
  it("uses PDF input, structured JSON, and medium thinking", async () => {
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
    const generateContent = mock(async (_request: any) => ({
      text: JSON.stringify(quiz),
    }));

    const result = await generateQuizFromGemini(
      [{ data: "pdf-data", mimeType: "application/pdf" }],
      "Skapa ett quiz för TATA41",
      { models: { generateContent } } as any,
    );

    expect(result).toEqual(quiz);
    const request = generateContent.mock.calls[0]![0] as any;
    expect(request).toMatchObject({
      model: QUIZ_MODEL,
      config: {
        thinkingConfig: { thinkingLevel: "MEDIUM" },
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
      },
    });
    expect(QUIZ_MODEL).toBe("gemini-3.1-flash-lite");
    expect(QUIZ_REASONING_EFFORT).toBe("medium");
    expect(request.config.responseJsonSchema).toBeDefined();
    expect(request.contents[0].parts).toEqual([
      { text: "Tentamensunderlag 1:" },
      { inlineData: { mimeType: "application/pdf", data: "pdf-data" } },
      { text: expect.stringContaining("Skapa ett quiz för TATA41") },
    ]);
  });

  it("rejects empty or invalid model output", async () => {
    const empty = { models: { generateContent: async () => ({ text: "" }) } };
    await expect(
      generateQuizFromGemini([], "Prompt", empty as any),
    ).rejects.toThrow("Gemini returned empty response");

    const invalid = {
      models: { generateContent: async () => ({ text: '{"quiz":{}}' }) },
    };
    await expect(
      generateQuizFromGemini([], "Prompt", invalid as any),
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
