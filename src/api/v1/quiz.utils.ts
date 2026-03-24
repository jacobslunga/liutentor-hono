import type { MultipleChoiceQuiz } from "./quiz.schemas";

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildTargetAnswerPositions(questionCount: number): number[] {
  const targets = Array.from(
    { length: questionCount },
    (_, index) => index % 4,
  );
  return shuffleArray(targets);
}

export function rebalanceQuizAnswerDistribution(
  quiz: MultipleChoiceQuiz,
): MultipleChoiceQuiz {
  const questions = quiz.quiz.questions;
  const targetPositions = buildTargetAnswerPositions(questions.length);

  return {
    quiz: {
      questions: questions.map((question, index) => {
        const currentAnswer = question.answer;
        const correctOption = question.options[currentAnswer] ?? "";
        const distractors = question.options.filter(
          (_, optionIndex) => optionIndex !== currentAnswer,
        );

        const shuffledDistractors = shuffleArray(distractors);
        const targetAnswer = targetPositions[index];
        const rebalancedOptions = new Array<string>(4);

        let distractorIndex = 0;
        for (let optionIndex = 0; optionIndex < 4; optionIndex++) {
          if (optionIndex === targetAnswer) {
            rebalancedOptions[optionIndex] = correctOption;
            continue;
          }
          rebalancedOptions[optionIndex] =
            shuffledDistractors[distractorIndex++];
        }

        return {
          ...question,
          options: rebalancedOptions,
          answer: targetAnswer,
        };
      }),
    },
  };
}
