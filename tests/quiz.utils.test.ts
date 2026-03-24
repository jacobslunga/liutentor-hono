import { describe, expect, it } from "bun:test";
import { rebalanceQuizAnswerDistribution } from "../src/api/v1/quiz.utils";
import type { MultipleChoiceQuiz } from "../src/api/v1/quiz.schemas";

function makeQuestion(id: number, answer: number) {
  return {
    id,
    question: `Fraga ${id}`,
    options: [
      `Q${id} Option A`,
      `Q${id} Option B`,
      `Q${id} Option C`,
      `Q${id} Option D`,
    ],
    answer,
  };
}

describe("rebalanceQuizAnswerDistribution", () => {
  it("should keep the same correct option text per question", () => {
    const quiz: MultipleChoiceQuiz = {
      quiz: {
        questions: Array.from({ length: 10 }, (_, i) => makeQuestion(i + 1, 0)),
      },
    };

    const originalCorrectOptions = quiz.quiz.questions.map(
      (q) => q.options[q.answer],
    );

    const rebalanced = rebalanceQuizAnswerDistribution(quiz);

    rebalanced.quiz.questions.forEach((question, index) => {
      expect(question.options[question.answer]).toBe(
        originalCorrectOptions[index],
      );
    });
  });

  it("should spread answer indices instead of concentrating one index", () => {
    const quiz: MultipleChoiceQuiz = {
      quiz: {
        questions: Array.from({ length: 10 }, (_, i) => makeQuestion(i + 1, 0)),
      },
    };

    const rebalanced = rebalanceQuizAnswerDistribution(quiz);

    const counts = [0, 0, 0, 0];
    for (const question of rebalanced.quiz.questions) {
      counts[question.answer] += 1;
    }

    // For 10 questions distributed over 4 slots, max concentration should be 3.
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
  });
});
