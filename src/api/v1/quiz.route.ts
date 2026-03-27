import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { stream } from "hono/streaming";
import { GoogleGenAI } from "@google/genai";

import { supabase } from "~/db/supabase";
import {
  courseCodeSchema,
  multipleChoiceQuizSchema,
  type MultipleChoiceQuiz,
} from "./quiz.schemas";
import { QUIZ_MULTIPLE_CHOICE_PROMPT } from "~/utils/prompts";
import { insertQuizIfNotDuplicate } from "./quiz.cache";
import { rebalanceQuizAnswerDistribution } from "./quiz.utils";

const quiz = new Hono().basePath("/v1/quiz");

const GOOGLE_MODEL = "gemini-2.5-flash";

const googleAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
});

const QUIZ_JSON_INSTRUCTION = `
Du MÅSTE svara med ENBART giltig JSON som matchar denna exakta struktur, ingen markdown, ingen inledning, ingen förklaring:
{
  "quiz": {
    "questions": [
      {
        "id": 1,
        "question": "...",
        "options": ["A", "B", "C", "D"],
        "answer": 0
      }
    ]
  }
}
Regler:
- Generera exakt 10 frågor.
- Varje fråga har exakt 4 svarsalternativ.
- "answer" är det 0-baserade indexet för det korrekta alternativet (0, 1, 2 eller 3).
- Alla frågor och svarsalternativ MÅSTE vara skrivna på svenska.
- Om tentafrågorna är på engelska, översätt till svenska.
- Matematiska formler och notation ska behållas som de är (t.ex. LaTeX).
- Svara med enbart rå JSON. Ingen wrapping, inga backticks, ingen extra text.
`;

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
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (error) {
    console.error(`Network error fetching PDF at ${url}:`, error);
    return null;
  }
}

async function getRandomExamSources(courseCode: string) {
  const { data, error } = await supabase
    .from("exams")
    .select("id, course_code, exam_name, exam_date, pdf_url, university")
    .eq("course_code", courseCode)
    .not("pdf_url", "is", null)
    .order("exam_date", { ascending: false })
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

async function generateQuizFromGoogle(
  pdfs: { data: string; mimeType: string }[],
  promptText: string,
): Promise<MultipleChoiceQuiz> {
  const pdfParts = pdfs.map((pdf) => ({
    inlineData: {
      data: pdf.data,
      mimeType: pdf.mimeType,
    },
  }));

  const result = await googleAI.models.generateContent({
    model: GOOGLE_MODEL,
    contents: [
      {
        role: "user",
        parts: [...pdfParts, { text: promptText }],
      },
    ],
    config: {
      systemInstruction: QUIZ_JSON_INSTRUCTION,
    },
  });

  const text = result.text ?? "";

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  const cleaned = text
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  return multipleChoiceQuizSchema.parse(JSON.parse(cleaned));
}

quiz.post(
  "/multiple-choice/:courseCode",
  zValidator("param", courseCodeSchema),
  bodyLimit({ maxSize: 256 * 1024 }),
  timeout(120000),
  async (c) => {
    const { courseCode } = c.req.valid("param");
    const anonymousUserId = c.req.header("x-anonymous-user-id") || "unknown";

    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new HTTPException(500, {
        message: "Missing GOOGLE_GENERATIVE_AI_API_KEY",
      });
    }

    console.log(`
┌─ QUIZ REQUEST: ${courseCode} ──────┐
│ Model: ${GOOGLE_MODEL}
└──────────────────────────────────────┘`);

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const sendEvent = async (
        type: "status" | "result" | "error",
        data: unknown,
      ) => {
        await s.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        await sendEvent("status", {
          step: "fetching_exams",
          message: `Hämtar tentor för ${courseCode}`,
        });

        const sourceExams = await getRandomExamSources(courseCode);

        await sendEvent("status", {
          step: "downloading_pdfs",
          message: `Laddar ner ${sourceExams.length} tenta-PDF${sourceExams.length > 1 ? ":er" : ""}`,
          total: sourceExams.length,
        });

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
          await sendEvent("error", {
            message: "Kunde inte ladda ner några tenta-PDF:er",
          });
          return;
        }

        await sendEvent("status", {
          step: "generating",
          message: `Genererar frågor från ${validExams.length} tent${validExams.length > 1 ? "or" : "a"}`,
          sources: validExams.length,
        });

        const promptText = `
${QUIZ_MULTIPLE_CHOICE_PROMPT}

Kurskod: ${courseCode}
`.trim();

        const pdfs = validExams.map((exam) => ({
          data: exam.base64Data!,
          mimeType: "application/pdf" as const,
        }));

        const parsed = await generateQuizFromGoogle(pdfs, promptText);
        const normalizedQuiz = multipleChoiceQuizSchema.parse(
          rebalanceQuizAnswerDistribution(parsed),
        );

        await sendEvent("status", {
          step: "finalizing",
          message: "Färdigställer quizet",
        });

        const sourceExamIds = validExams.map((x) => x.id);

        insertQuizIfNotDuplicate({
          anonymous_user_id: anonymousUserId,
          course_code: courseCode,
          quiz_type: "multiple_choice",
          quiz: normalizedQuiz,
          source_exam_ids: sourceExamIds,
          source_count: validExams.length,
          model: GOOGLE_MODEL,
        });

        const resultPayload = {
          ...normalizedQuiz,
          meta: {
            courseCode,
            sourceExamIds,
            sourceCount: validExams.length,
            model: GOOGLE_MODEL,
          },
        };

        await sendEvent("result", resultPayload);
      } catch (error: any) {
        console.error("Quiz generation failed:", error);
        await sendEvent("error", {
          message: error?.message || "Kunde inte generera quizet",
        });
      }
    });
  },
);

export default quiz;
