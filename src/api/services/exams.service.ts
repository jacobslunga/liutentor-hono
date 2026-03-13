import type { SupabaseClient } from '@supabase/supabase-js';
import { HTTPException } from 'hono/http-exception';
import type { ExamReturn } from '../../../types/exams';

export type University = 'LIU' | 'KTH' | 'CTH' | 'LTH';

export const VALID_UNIVERSITIES: University[] = ['LIU', 'KTH', 'CTH', 'LTH'];

export async function getExamsService(
  courseCode: string,
  university: University,
  supabase: SupabaseClient,
): Promise<ExamReturn> {
  const { data: examsData, error: examsError } = await supabase
    .from('exams')
    .select(
      'id, course_code, exam_date, pdf_url, exam_name, solutions(exam_id)',
    )
    .eq('course_code', courseCode)
    .eq('university', university)
    .order('exam_date', { ascending: false });

  if (examsError) {
    console.error('Failed to fetch exams:', examsError);
    throw new HTTPException(500, {
      message: 'Failed to fetch exams',
    });
  }

  if (!examsData || examsData.length === 0) {
    throw new HTTPException(404, {
      message: 'No exam documents found for this course',
    });
  }

  // Fetch stats separately - if this fails, we still return exams without stats
  const { data: statsData, error: statsError } = await supabase
    .from('exam_stats')
    .select('exam_date, statistics, pass_rate, course_name_swe')
    .eq('course_code', courseCode);

  if (statsError) {
    console.warn(
      'Failed to fetch exam stats (continuing without stats):',
      statsError,
    );
  }

  const statsMap = new Map<
    string,
    { statistics?: unknown; pass_rate?: number }
  >();

  let courseName = '';

  if (statsData) {
    for (const stat of statsData) {
      statsMap.set(stat.exam_date, {
        statistics: stat.statistics,
        pass_rate: stat.pass_rate,
      });

      if (stat.course_name_swe) {
        courseName = stat.course_name_swe;
      }
    }
  }

  const examsList = examsData.map((exam) => {
    const stats = statsMap.get(exam.exam_date);

    return {
      ...exam,
      has_solution: Boolean(exam.solutions?.length),
      statistics: stats?.statistics,
      pass_rate: stats?.pass_rate,
    };
  });

  return {
    courseCode,
    courseName,
    exams: examsList,
  };
}

export async function getExamService(examId: string, supabase: SupabaseClient) {
  const id = Number(examId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, {
      message: 'examId must be a positive integer',
    });
  }

  const { data, error } = await supabase
    .from('exams')
    .select('id, course_code, exam_date, pdf_url, solutions(*)')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw new HTTPException(404, {
      message: 'Exam not found',
    });
  }

  const { solutions, ...exam } = data;

  return {
    exam,
    solution: solutions?.[0] ?? null,
  };
}
