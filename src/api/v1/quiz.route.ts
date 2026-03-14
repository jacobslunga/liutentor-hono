import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { timeout } from 'hono/timeout';
import { GoogleGenAI } from '@google/genai';

import { supabase } from '~/db/supabase';
import { success } from '~/utils/response';
import {
  courseCodeSchema,
  multipleChoiceQuizSchema,
  type MultipleChoiceQuiz,
} from './quiz.schemas';
import { QUIZ_MULTIPLE_CHOICE_PROMPT } from '~/utils/prompts';
import { insertQuizIfNotDuplicate } from './quiz.cache';

const quiz = new Hono().basePath('/v1/quiz');

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
});

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchPdfAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch PDF at ${url}: ${response.statusText}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (error) {
    console.error(`Network error fetching PDF at ${url}:`, error);
    return null;
  }
}

async function getRandomExamSources(courseCode: string) {
  const { data, error } = await supabase
    .from('exams')
    .select('id, course_code, exam_name, exam_date, pdf_url, university')
    .eq('course_code', courseCode)
    .not('pdf_url', 'is', null)
    .order('exam_date', { ascending: false })
    .limit(12);

  if (error) {
    throw new HTTPException(500, {
      message: `Failed to fetch exams: ${error.message}`,
    });
  }

  if (!data || data.length === 0) {
    throw new HTTPException(404, {
      message: `No exams with PDF found for course ${courseCode}`,
    });
  }

  const shuffled = shuffleArray(data);
  const takeCount = Math.min(
    shuffled.length <= 2 ? shuffled.length : Math.floor(Math.random() * 4) + 2,
    5,
  );

  return shuffled.slice(0, takeCount);
}

const multipleChoiceResponseSchema = {
  type: 'object',
  properties: {
    quiz: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 10,
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              question: { type: 'string' },
              options: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: { type: 'string' },
              },
              answer: {
                type: 'integer',
                minimum: 0,
                maximum: 3,
              },
            },
            required: ['id', 'question', 'options', 'answer'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['quiz'],
} as const;

quiz.post(
  '/multiple-choice/:courseCode',
  zValidator('param', courseCodeSchema),
  bodyLimit({ maxSize: 256 * 1024 }),
  timeout(120000),
  async (c) => {
    const { courseCode } = c.req.valid('param');
    const anonymousUserId = c.req.header('x-anonymous-user-id') || 'unknown';

    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new HTTPException(500, {
        message: 'Missing GOOGLE_GENERATIVE_AI_API_KEY',
      });
    }

    const sourceExams = await getRandomExamSources(courseCode);

    const examsWithBase64 = await Promise.all(
      sourceExams.map(async (exam) => {
        const base64Data = await fetchPdfAsBase64(exam.pdf_url);
        return {
          id: exam.id,
          exam_name: exam.exam_name,
          exam_date: exam.exam_date,
          university: exam.university,
          base64Data,
        };
      }),
    );

    const validExams = examsWithBase64.filter(
      (exam) => exam.base64Data !== null,
    );

    if (validExams.length === 0) {
      throw new HTTPException(500, {
        message: 'Failed to download PDF sources for this quiz.',
      });
    }

    const pdfParts = validExams.map((exam) => ({
      inlineData: { data: exam.base64Data!, mimeType: 'application/pdf' },
    }));

    let parsed: MultipleChoiceQuiz;

    const promptText = `
${QUIZ_MULTIPLE_CHOICE_PROMPT}

Kurskod: ${courseCode}
`.trim();

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [...pdfParts, { text: promptText }],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: multipleChoiceResponseSchema,
          temperature: 0.6,
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error('Gemini returned empty response');
      }

      const json = JSON.parse(text);
      parsed = multipleChoiceQuizSchema.parse(json);
    } catch (error: any) {
      console.error('Quiz generation failed:', error);
      throw new HTTPException(500, {
        message: 'Failed to generate multiple choice quiz',
      });
    }

    const sourceExamIds = validExams.map((x) => x.id);

    insertQuizIfNotDuplicate({
      anonymous_user_id: anonymousUserId,
      course_code: courseCode,
      quiz_type: 'multiple_choice',
      quiz: parsed,
      source_exam_ids: sourceExamIds,
      source_count: validExams.length,
      model: 'gemini-2.5-flash',
    });

    const resultPayload = {
      ...parsed,
      meta: {
        courseCode,
        sourceExamIds,
        sourceCount: validExams.length,
      },
    };

    return c.json(success(resultPayload, 'Quiz generated successfully'));
  },
);

export default quiz;
