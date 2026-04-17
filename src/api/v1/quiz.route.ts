import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { stream } from "hono/streaming";
import OpenAI from "openai";
import { z } from "zod";

import { supabase } from "~/db/supabase";
import {
  courseCodeSchema,
  multipleChoiceQuizSchema,
  type MultipleChoiceQuiz,
} from "./quiz.schemas";
import { QUIZ_MULTIPLE_CHOICE_PROMPT } from "~/utils/prompts";
import { rebalanceQuizAnswerDistribution } from "./quiz.utils";
import { insertQuizIfNotDuplicate } from "./quiz.cache";

const quiz = new Hono().basePath("/v1/quiz");

const OPENAI_MODEL = "gpt-5.4-nano";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const multipleChoiceBodySchema = z.object({
  examIds: z
    .array(z.number().int().positive())
    .min(1, "Select at least one exam")
    .max(5, "Maximum 5 exams allowed")
    .optional(),
  customPrompt: z
    .string()
    .max(300, "Custom prompt must be 300 characters or less")
    .trim()
    .optional(),
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

async function getExamSources(courseCode: string, examIds?: number[]) {
  if (examIds && examIds.length > 0) {
    const { data, error } = await supabase
      .from("exams")
      .select("id, course_code, exam_name, exam_date, pdf_url, university")
      .eq("course_code", courseCode)
      .in("id", examIds)
      .not("pdf_url", "is", null);

    if (error) {
      throw new HTTPException(500, {
        message: `Failed to fetch exams: ${error.message}`,
      });
    }

    if (!data || data.length === 0) {
      throw new HTTPException(404, {
        message: `No exams with PDF found for the provided exam IDs`,
      });
    }

    return data;
  }

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

async function generateQuizFromOpenAI(
  pdfs: { data: string; mimeType: string }[],
  promptText: string,
): Promise<MultipleChoiceQuiz> {
  const pdfContents = pdfs.map((pdf) => ({
    type: "file" as const,
    file: {
      filename: "exam.pdf",
      file_data: `data:application/pdf;base64,${pdf.data}`,
    },
  }));

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content: QUIZ_JSON_INSTRUCTION,
      },
      {
        role: "user",
        content: [...pdfContents, { type: "text" as const, text: promptText }],
      },
    ],
    response_format: { type: "json_object" },
  });

  const text = response.choices[0]?.message?.content ?? "";
  if (!text) throw new Error("OpenAI returned empty response");

  return multipleChoiceQuizSchema.parse(JSON.parse(text));
}

quiz.post(
  "/multiple-choice/:courseCode",
  zValidator("param", courseCodeSchema),
  zValidator("json", multipleChoiceBodySchema),
  bodyLimit({ maxSize: 256 * 1024 }),
  timeout(120000),
  async (c) => {
    const { courseCode } = c.req.valid("param");
    const { examIds, customPrompt } = c.req.valid("json");
    const anonymousUserId = c.req.header("x-anonymous-user-id") || "unknown";

    if (!process.env.OPENAI_API_KEY) {
      throw new HTTPException(500, { message: "Missing OPENAI_API_KEY" });
    }

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

      const cyan = "\x1b[36m";
      const dim = "\x1b[2m";
      const reset = "\x1b[0m";
      const bold = "\x1b[1m";
      console.log(
        `${cyan}┌─ QUIZ REQUEST ${"─".repeat(35)}\n` +
          `│${reset}  ${bold}Course${reset}   ${dim}→${reset}  ${courseCode}\n` +
          `${cyan}│${reset}  ${bold}Model${reset}    ${dim}→${reset}  ${OPENAI_MODEL}\n` +
          `${cyan}│${reset}  ${bold}Exams${reset}    ${dim}→${reset}  ${examIds ? examIds.join(", ") : "random"}\n` +
          `${cyan}│${reset}  ${bold}Custom${reset}   ${dim}→${reset}  ${customPrompt ? `"${customPrompt.slice(0, 40)}${customPrompt.length > 40 ? "…" : ""}"` : "none"}\n` +
          `${cyan}│${reset}  ${bold}User${reset}     ${dim}→${reset}  ${dim}${anonymousUserId}${reset}\n` +
          `${cyan}└${"─".repeat(50)}${reset}`,
      );

      try {
        await sendEvent("status", {
          step: "fetching_exams",
          message: `Hämtar tentor för ${courseCode}`,
        });

        const sourceExams = await getExamSources(courseCode, examIds);

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

        const promptParts = [
          QUIZ_MULTIPLE_CHOICE_PROMPT,
          `Kurskod: ${courseCode}`,
        ];

        if (customPrompt) {
          promptParts.push(`Användarens instruktioner: ${customPrompt}`);
        }

        const promptText = promptParts.join("\n\n").trim();

        const pdfs = validExams.map((exam) => ({
          data: exam.base64Data!,
          mimeType: "application/pdf" as const,
        }));

        const parsed = await generateQuizFromOpenAI(pdfs, promptText);
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
          model: OPENAI_MODEL,
        });

        await sendEvent("result", {
          ...normalizedQuiz,
          meta: {
            courseCode,
            sourceExamIds,
            sourceCount: validExams.length,
            model: OPENAI_MODEL,
          },
        });
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
