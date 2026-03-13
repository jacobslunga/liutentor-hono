import { z } from 'zod';

export const courseCodeSchema = z.object({
  courseCode: z.string().trim().min(2).max(32),
});

export const multipleChoiceQuestionSchema = z.object({
  id: z.number().int().positive(),
  question: z.string().min(4),
  options: z.array(z.string().min(1)).length(4),
  answer: z.number().int().min(0).max(3),
});

export const multipleChoiceQuizSchema = z.object({
  quiz: z.object({
    questions: z.array(multipleChoiceQuestionSchema).min(10),
  }),
});

export type MultipleChoiceQuiz = z.infer<typeof multipleChoiceQuizSchema>;
