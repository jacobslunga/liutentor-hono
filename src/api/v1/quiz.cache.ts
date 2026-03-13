import { supabase } from '~/db/supabase';
import type { MultipleChoiceQuiz } from './quiz.schemas';

type QuizLogRow = {
  id: string;
  course_code: string;
  quiz_type: string;
  quiz: MultipleChoiceQuiz;
  source_exam_ids: number[];
  source_count: number;
  model: string;
  created_at: string;
};

async function hashQuiz(quiz: MultipleChoiceQuiz): Promise<string> {
  const normalized = quiz.quiz.questions
    .map(
      (q) =>
        `${q.question.trim().toLowerCase()}|${q.options
          .map((o) => o.trim().toLowerCase())
          .sort()
          .join('|')}`,
    )
    .sort()
    .join('||');
  const encoded = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getRandomCachedQuiz(
  courseCode: string,
): Promise<
  | (MultipleChoiceQuiz & {
      meta: {
        courseCode: string;
        sourceExamIds: number[];
        sourceCount: number;
      };
    })
  | null
> {
  const { data, error } = await supabase
    .from('ai_quiz_logs')
    .select('quiz, source_exam_ids, source_count')
    .eq('course_code', courseCode)
    .eq('quiz_type', 'multiple_choice')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data || data.length === 0) return null;

  const row = data[Math.floor(Math.random() * data.length)] as Pick<
    QuizLogRow,
    'quiz' | 'source_exam_ids' | 'source_count'
  >;

  return {
    ...row.quiz,
    meta: {
      courseCode,
      sourceExamIds: row.source_exam_ids,
      sourceCount: row.source_count,
    },
  };
}

export async function insertQuizIfNotDuplicate(payload: {
  anonymous_user_id: string;
  course_code: string;
  quiz_type: string;
  quiz: MultipleChoiceQuiz;
  source_exam_ids: number[];
  source_count: number;
  model: string;
}): Promise<void> {
  const incomingHash = await hashQuiz(payload.quiz);

  const { data: existing, error: fetchError } = await supabase
    .from('ai_quiz_logs')
    .select('id, quiz')
    .eq('course_code', payload.course_code)
    .eq('quiz_type', payload.quiz_type);

  if (fetchError) {
    console.error('Quiz cache fetch error:', fetchError.message);
    return;
  }

  const isDuplicate = (
    await Promise.all(
      (existing ?? []).map(async (row) => {
        try {
          return (
            (await hashQuiz(row.quiz as MultipleChoiceQuiz)) === incomingHash
          );
        } catch {
          return false;
        }
      }),
    )
  ).some(Boolean);

  if (isDuplicate) {
    console.log(
      `[quiz-cache] Duplicate quiz detected for ${payload.course_code}, skipping insert.`,
    );
    return;
  }

  supabase
    .from('ai_quiz_logs')
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error('Quiz DB Log Error:', error.message);
    });
}
