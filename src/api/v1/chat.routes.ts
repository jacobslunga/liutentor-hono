import { GoogleGenAI } from '@google/genai';
import { HINT_MODE, SYSTEM_PROMPT } from '~/utils/prompts';
import { chatMessageSchema, examIdSchema } from './chat.schemas';
import { bodyLimit } from 'hono/body-limit';
import { timeout } from 'hono/timeout';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { supabase } from '~/db/supabase';

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
});

const getGoogleModelId = (modelId: string) => {
  const map: Record<string, string> = {
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'gemini-3.1-pro': 'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite-preview',
  };
  return map[modelId] || 'gemini-2.5-pro';
};

function logToDBAsync(payload: any) {
  supabase
    .from('ai_chat_logs')
    .insert(payload)
    .then(({ error }) => {
      if (error) console.error('DB Log Error:', error.message);
    });
}

function extractTextContent(content: unknown): string {
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part: any) => part?.type === 'text' && typeof part?.text === 'string',
    );
    return textPart?.text || '';
  }
  return typeof content === 'string' ? content : '';
}

function mapHistoryMessage(message: any) {
  const role = message?.role === 'assistant' ? 'model' : 'user';

  if (Array.isArray(message?.content)) {
    return {
      role,
      parts: message.content
        .filter(
          (part: any) =>
            part?.type === 'text' && typeof part?.text === 'string',
        )
        .map((part: any) => ({ text: part.text })),
    };
  }

  return {
    role,
    parts: [
      { text: typeof message?.content === 'string' ? message.content : '' },
    ],
  };
}

// NEW HELPER: Fetch PDF from Supabase and convert to Base64
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

const chat = new Hono().basePath('/v1/chat');

chat.post(
  '/completion/:examId',
  zValidator('param', examIdSchema),
  zValidator('json', chatMessageSchema),
  bodyLimit({ maxSize: 20 * 1024 * 1024 }), // Increased slightly to handle base64 overhead
  timeout(120000),
  async (c) => {
    const { examId } = c.req.valid('param');
    const body = c.req.valid('json');

    const {
      messages,
      giveDirectAnswer = true,
      examUrl,
      solutionUrl,
      courseCode,
      modelId = 'gemini-2.5-pro',
    } = body as any;

    console.log(`
┌─ AI REQUEST: ${courseCode} ────────┐
│ Exam ID:  ${examId}
│ Model:    ${modelId}
│ PDF:      ${examUrl}
└──────────────────────────────────────┘`);

    if (!examUrl || !messages?.length) {
      throw new HTTPException(400, {
        message: 'Missing examUrl or messages',
      });
    }

    const last = messages[messages.length - 1];
    const lastMsgText = extractTextContent(last?.content);

    if (last?.role === 'user') {
      logToDBAsync({
        anonymous_user_id: c.req.header('x-anonymous-user-id') || 'unknown',
        course_code: courseCode,
        exam_id: examId,
        role: 'user',
        content: lastMsgText,
        model: modelId,
      });
    }

    // Fetch PDFs concurrently and convert them directly to base64
    const [examBase64, solutionBase64] = await Promise.all([
      fetchPdfAsBase64(examUrl),
      solutionUrl ? fetchPdfAsBase64(solutionUrl) : Promise.resolve(null),
    ]);

    const shouldGiveDirectAnswer = giveDirectAnswer ?? true;
    const systemPrompt = [
      SYSTEM_PROMPT,
      !shouldGiveDirectAnswer ? HINT_MODE : '',
    ]
      .filter(Boolean)
      .join('\n');

    const model = getGoogleModelId(modelId);

    const history = messages
      .slice(0, -1)
      .map(mapHistoryMessage)
      .filter((msg: any) => Array.isArray(msg.parts) && msg.parts.length > 0);

    // Build the PDF parts using inlineData instead of URIs
    const pdfParts: any[] = [];
    if (examBase64) {
      pdfParts.push({
        inlineData: { data: examBase64, mimeType: 'application/pdf' },
      });
    }
    if (solutionBase64) {
      pdfParts.push({
        inlineData: { data: solutionBase64, mimeType: 'application/pdf' },
      });
    }

    let result;
    try {
      result = await ai.models.generateContentStream({
        model,
        contents: [
          // INJECT PDFs AT THE VERY BEGINNING OF THE HISTORY
          ...(pdfParts.length > 0 ? [{ role: 'user', parts: pdfParts }] : []),
          ...history,
          {
            role: 'user',
            parts: [{ text: lastMsgText }],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
        },
      });
    } catch (error: any) {
      console.error('Gemini stream error:', error);
      throw new HTTPException(500, {
        message: 'Failed to generate response',
      });
    }

    return stream(c, async (s) => {
      c.header('Content-Type', 'text/plain; charset=utf-8');
      c.header('Transfer-Encoding', 'chunked');

      let fullResponse = '';

      try {
        for await (const chunk of result) {
          const text = chunk.text || '';
          if (!text) continue;

          fullResponse += text;
          await s.write(text);
        }
      } catch (error: any) {
        console.error('Streaming error:', error);
        throw new HTTPException(500, {
          message: 'Failed while streaming response',
        });
      }

      logToDBAsync({
        anonymous_user_id: c.req.header('x-anonymous-user-id') || 'unknown',
        course_code: courseCode,
        exam_id: examId,
        role: 'assistant',
        content: fullResponse,
        model,
      });
    });
  },
);

export default chat;
