import { supabase } from "~/db/supabase";
import type { MultipleChoiceQuiz, QuizDifficulty } from "./quiz.schemas";

export async function logQuizGeneration(payload: {
  user_id: string | null;
  anonymous_user_id: string;
  course_code: string;
  quiz_type: string;
  quiz: MultipleChoiceQuiz;
  source_exam_ids: number[];
  source_count: number;
  model: string;
  difficulty: QuizDifficulty;
}): Promise<void> {
  supabase
    .from("ai_quiz_logs")
    .insert({
      user_id: payload.user_id,
      anonymous_user_id: payload.anonymous_user_id,
      course_code: payload.course_code,
      quiz_type: payload.quiz_type,
      quiz: payload.quiz,
      source_exam_ids: payload.source_exam_ids,
      source_count: payload.source_count,
      model: payload.model,
      difficulty: payload.difficulty,
    })
    .then(({ error }) => {
      if (error) {
        console.error("Critical: Failed to log quiz to DB:", error.message);
      }
    });
}
