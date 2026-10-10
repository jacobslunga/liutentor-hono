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
  const perPosition = Math.floor(questionCount / 4);
  const remainder = questionCount % 4;
  const bonusPositions = shuffleArray([0, 1, 2, 3]).slice(0, remainder);

  const targets: number[] = [];
  for (let position = 0; position < 4; position++) {
    const count = perPosition + (bonusPositions.includes(position) ? 1 : 0);
    for (let i = 0; i < count; i++) targets.push(position);
  }

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

export function measureCorrectAnswerLengthBias(quiz: MultipleChoiceQuiz): {
  questionCount: number;
  longestCount: number;
  longestShare: number;
  meanLengthRatio: number;
} {
  const questions = quiz.quiz.questions;
  if (questions.length === 0) {
    return {
      questionCount: 0,
      longestCount: 0,
      longestShare: 0,
      meanLengthRatio: 1,
    };
  }

  let longestCount = 0;
  let ratioSum = 0;

  for (const question of questions) {
    const lengths = question.options.map((option) => option.trim().length);
    const correctLength = lengths[question.answer] ?? 0;
    const others = lengths.filter((_, index) => index !== question.answer);
    const otherMean =
      others.reduce((sum, length) => sum + length, 0) / others.length;

    if (others.every((length) => correctLength > length)) longestCount += 1;
    ratioSum += otherMean > 0 ? correctLength / otherMean : 1;
  }

  return {
    questionCount: questions.length,
    longestCount,
    longestShare: longestCount / questions.length,
    meanLengthRatio: ratioSum / questions.length,
  };
}
