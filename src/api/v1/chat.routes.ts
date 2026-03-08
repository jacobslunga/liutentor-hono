import { GoogleGenerativeAI } from '@google/generative-ai';
import { getCachedFileUri } from '~/utils/google-file-manager';
import {
  MATH_FORMATTING,
  CONCISE,
  DIRECT_MODE,
  HINT_MODE,
  NO_DIAGRAMS,
  SYSTEM_CTX,
} from '~/utils/prompts';
import { chatMessageSchema, examIdSchema } from './chat.schemas';
import { bodyLimit } from 'hono/body-limit';
import { timeout } from 'hono/timeout';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { supabase } from '~/db/supabase';

const genAI = new GoogleGenerativeAI(
  process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
);

const getGoogleModel = (modelId: string) => {
  const map: Record<string, string> = {
    'gemini-2.5-flash': 'gemini-2.5-flash',
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'gemini-3-pro': 'gemini-3-pro-preview',
  };
  return genAI.getGenerativeModel({
    model: map[modelId] || 'gemini-2.0-flash',
  });
};

function logMemory(tag: string) {
  const m = process.memoryUsage();
  console.log(
    `[MEM ${tag.padEnd(15)}] RSS: ${Math.round(
      m.rss / 1024 / 1024,
    )}MB | Heap: ${Math.round(m.heapUsed / 1024 / 1024)}MB`,
  );
}

function logToDBAsync(payload: any) {
  supabase
    .from('ai_chat_logs')
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error('DB Log Error:', error.message);
    });
}

const chat = new Hono().basePath('/v1/chat');

chat.post(
  '/completion/:examId',
  zValidator('param', examIdSchema),
  zValidator('json', chatMessageSchema),
  bodyLimit({ maxSize: 2 * 1024 * 1024 }),
  timeout(120000),
  async (c) => {
    logMemory('REQUEST_START');

    const { examId } = c.req.param();
    const body = c.req.valid('json');
    const {
      messages,
      giveDirectAnswer = true,
      examUrl,
      solutionUrl,
      courseCode,
      modelId = 'gemini-2.5-flash',
    } = body as any;

    console.log(`
┌─ AI REQUEST: ${courseCode} ────────┐
│ Exam ID:  ${examId}
│ Model:    ${modelId}
│ PDF:      ${examUrl}
└──────────────────────────────────────┘`);

    if (!examUrl || !messages?.length) throw new HTTPException(400);

    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      const text = Array.isArray(last.content)
        ? last.content.find((p: any) => p.type === 'text')?.text || ''
        : last.content;

      logToDBAsync({
        anonymous_user_id: c.req.header('x-anonymous-user-id') || 'unknown',
        course_code: courseCode,
        exam_id: examId,
        role: 'user',
        content: text,
        model: modelId,
      });
    }

    const [finalExamUri, finalSolutionUri] = await Promise.all([
      getCachedFileUri('exam', examId as string, examUrl),
      solutionUrl
        ? getCachedFileUri('solution', examId as string, solutionUrl)
        : Promise.resolve(null),
    ]);

    const shouldGiveDirectAnswer = giveDirectAnswer ?? true;
    const systemPrompt = [
      SYSTEM_CTX,
      CONCISE,
      MATH_FORMATTING,
      NO_DIAGRAMS,
      shouldGiveDirectAnswer ? DIRECT_MODE : HINT_MODE,
    ].join('\n');

    logMemory('BEFORE_AI_STREAM');

    const model = getGoogleModel(modelId);

    const history = messages.slice(0, -1).map((m: any) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.content)
        ? m.content.map((c: any) =>
            c.type === 'text' ? { text: c.text } : { text: '' },
          )
        : [{ text: m.content }],
    }));

    const lastMsgContent = last?.content;
    const lastMsgText = Array.isArray(lastMsgContent)
      ? lastMsgContent.find((c: any) => c.type === 'text')?.text || ''
      : lastMsgContent;

    const currentParts: any[] = [];

    if (finalExamUri) {
      currentParts.push({
        fileData: { mimeType: 'application/pdf', fileUri: finalExamUri },
      });
    }
    if (finalSolutionUri) {
      currentParts.push({
        fileData: { mimeType: 'application/pdf', fileUri: finalSolutionUri },
      });
    }

    currentParts.push({ text: lastMsgText });

    const result = await model.generateContentStream({
      contents: [...history, { role: 'user', parts: currentParts }],
      systemInstruction: systemPrompt,
    });

    return stream(c, async (s) => {
      c.header('Content-Type', 'text/plain; charset=utf-8');
      c.header('Transfer-Encoding', 'chunked');

      let fullResponse = '';

      for await (const chunk of result.stream) {
        const text = chunk.text();
        fullResponse += text;
        await s.write(text);
      }

      logMemory('AFTER_AI_STREAM');
      logToDBAsync({
        anonymous_user_id: c.req.header('x-anonymous-user-id') || 'unknown',
        course_code: courseCode,
        exam_id: examId,
        role: 'assistant',
        content: fullResponse,
        model: modelId,
      });
    });
  },
);

export default chat;
