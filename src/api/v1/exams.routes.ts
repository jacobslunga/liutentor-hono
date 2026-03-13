import { Hono, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  getExamService,
  getExamsService,
  VALID_UNIVERSITIES,
  type University,
} from '~/api/services/exams.service';
import { success } from '~/utils/response';

const exams = new Hono().basePath('/v1/exams');

exams.get('/:university/:courseCode', async (c: Context) => {
  const supabase = c.get('supabase');

  const { courseCode, university } = c.req.param();

  if (!courseCode) {
    throw new HTTPException(400, {
      message: 'Missing courseCode',
    });
  }

  if (!university) {
    throw new HTTPException(400, {
      message: 'Missing university',
    });
  }

  if (!VALID_UNIVERSITIES.includes(university as University)) {
    throw new HTTPException(400, {
      message: 'Invalid university',
    });
  }

  const result = await getExamsService(
    courseCode,
    university as University,
    supabase,
  );

  return c.json(success(result, 'Exams fetched successfully'));
});

exams.get('/:examId', async (c) => {
  const supabase = c.get('supabase');

  const { examId } = c.req.param();

  if (!examId) {
    throw new HTTPException(400, {
      message: 'Missing examId',
    });
  }

  const result = await getExamService(examId, supabase);

  return c.json(success(result, 'Exam fetched successfully'));
});

export default exams;
