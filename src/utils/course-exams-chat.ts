import { supabase } from "~/db/supabase";
import type { Provider } from "~/api/v1/chat.models";
import { streamChatModel, type ChatModelRequest } from "./chat.providers";
import type { ChatSource, ChatStreamEvent } from "./chat.utils";
import {
  COURSE_CODE_PATTERN,
  EXAM_ANALYSIS_VERSION,
  EXAM_EXTRACTION_PROMPT,
  courseExamPrompt,
  examAnalysisSchema,
  loadCourseExamContext,
  type AnalysedExam,
  type CourseExam,
  type CourseExamRepository,
} from "./course-exams";

const PAGE_SIZE = 500;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
// Avoid paying for duplicate extraction requests within this API process.
const extracting = new Set<string>();

async function downloadExam(exam: CourseExam, signal: AbortSignal) {
  const url = new URL(exam.pdf_url);
  if (url.protocol !== "https:") throw new Error("Exam PDF must use HTTPS");
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error("Exam PDF unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_PDF_BYTES) throw new Error("Exam PDF exceeds 10 MB");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Invalid exam PDF");
  return bytes.toString("base64");
}

export function courseExamRepository(
  provider: Provider,
  modelId: string,
  analysisTimeoutMs = 30_000,
): CourseExamRepository {
  return {
    async list(courseCode, signal) {
      const exams: CourseExam[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("exams")
          .select("id, course_code, exam_date, exam_name, pdf_url")
          .eq("course_code", courseCode)
          .eq("university", "LIU")
          .order("exam_date", { ascending: false })
          .order("id")
          .range(offset, offset + PAGE_SIZE - 1)
          .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        if (error)
          throw new Error("Could not list course exams", { cause: error });
        exams.push(
          ...(data ?? []).filter(
            (exam) =>
              typeof exam.pdf_url === "string" && exam.pdf_url.length > 0,
          ),
        );
        if ((data?.length ?? 0) < PAGE_SIZE) return exams;
      }
    },
    async cached(exams, signal) {
      const found: AnalysedExam[] = [];
      for (let offset = 0; offset < exams.length; offset += PAGE_SIZE) {
        const batch = exams.slice(offset, offset + PAGE_SIZE);
        const { data, error } = await supabase
          .from("exam_content_analyses")
          .select("exam_id, pdf_url, analysis, analysed_at")
          .eq("version", EXAM_ANALYSIS_VERSION)
          .in(
            "exam_id",
            batch.map((exam) => exam.id),
          )
          .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        // Fail before any paid extraction if the cache migration is missing.
        if (error)
          throw new Error(
            "Could not read exam analysis cache; apply migrations",
            { cause: error },
          );
        const byId = new Map(batch.map((exam) => [exam.id, exam]));
        for (const row of data ?? []) {
          const exam = byId.get(row.exam_id);
          const parsed = examAnalysisSchema.safeParse(row.analysis);
          const recentFailure =
            Date.parse(row.analysed_at) > Date.now() - 15 * 60_000;
          if (
            exam &&
            exam.pdf_url === row.pdf_url &&
            parsed.success &&
            ((parsed.data.readable && parsed.data.questions.length) ||
              recentFailure)
          ) {
            found.push({ exam, analysis: parsed.data });
          }
        }
      }
      return found;
    },
    async analyse(exam, parentSignal) {
      const key = `${exam.id}:${exam.pdf_url}`;
      if (extracting.has(key))
        throw new Error("Exam is already being analysed");
      extracting.add(key);
      try {
        const signal = AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(analysisTimeoutMs),
        ]);
        const data = await downloadExam(exam, signal);
        let output = "";
        for await (const event of streamChatModel(provider, {
          systemPrompt: EXAM_EXTRACTION_PROMPT,
          messages: [
            {
              role: "user",
              content: "Extract the exam question outline as JSON.",
            },
          ],
          lastMsgText: "Extract the exam question outline as JSON.",
          modelId,
          pdfs: [{ data, mimeType: "application/pdf", label: "tenta" }],
          userAttachments: [],
          effort: "low",
          tools: { signal },
        })) {
          if (event.type === "text") output += event.delta;
          if (output.length > 32_000)
            throw new Error("Exam analysis too large");
        }
        const analysis = examAnalysisSchema.parse(
          JSON.parse(
            output
              .trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/, ""),
          ),
        );
        const { error } = await supabase
          .from("exam_content_analyses")
          .upsert(
            {
              exam_id: exam.id,
              pdf_url: exam.pdf_url,
              version: EXAM_ANALYSIS_VERSION,
              analysis,
              model: modelId,
              analysed_at: new Date().toISOString(),
            },
            { onConflict: "exam_id" },
          )
          .abortSignal(signal);
        if (error)
          throw new Error("Could not save exam analysis", { cause: error });
        return analysis;
      } catch (error) {
        // Briefly remember failures so four broken PDFs cannot starve older exams.
        // Cancellation belongs to this user turn and must not poison the cache.
        if (!parentSignal.aborted) {
          const { error: cacheError } = await supabase
            .from("exam_content_analyses")
            .upsert(
              {
                exam_id: exam.id,
                pdf_url: exam.pdf_url,
                version: EXAM_ANALYSIS_VERSION,
                analysis: { readable: false, overview: "", questions: [] },
                model: modelId,
                analysed_at: new Date().toISOString(),
              },
              { onConflict: "exam_id" },
            )
            .abortSignal(
              AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]),
            );
          if (cacheError)
            console.error(
              "Could not cache failed exam analysis",
              cacheError.message,
            );
        }
        throw error;
      } finally {
        extracting.delete(key);
      }
    },
  };
}

/** The opt-in is enforced here; ordinary turns never query exams or invoke extraction. */
export async function* streamExamChat(
  provider: Provider,
  request: ChatModelRequest,
  options: {
    enabled: boolean;
    courseCode: string;
    logFields: Record<string, unknown>;
    repository?: CourseExamRepository;
    streamModel?: typeof streamChatModel;
  },
): AsyncGenerator<ChatStreamEvent> {
  const streamModel = options.streamModel ?? streamChatModel;
  if (!options.enabled) {
    yield* streamModel(provider, request);
    return;
  }
  const signal = request.tools?.signal ?? new AbortController().signal;
  const sources = new Map<string, ChatSource>();
  yield { type: "status", step: "searching", message: "Hämtar kursens tentor" };
  // Progress is emitted as workers finish, with a heartbeat while PDF models run.
  let progress = "Läser tidigare analyser";
  const work = loadCourseExamContext(
    options.courseCode,
    options.repository ?? courseExamRepository(provider, request.modelId),
    signal,
    (message) => {
      progress = message;
    },
  );
  let context: Awaited<typeof work>;
  try {
    // Keep rejection handled while awaiting the race/heartbeat.
    const result = work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        result,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 2000);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === null) {
        yield { type: "status", step: "searching", message: progress };
        continue;
      }
      if ("error" in outcome) throw outcome.error;
      context = outcome.value;
      break;
    }
    const evidence = courseExamPrompt(context);
    request = {
      ...request,
      systemPrompt: request.systemPrompt + evidence.prompt,
    };
    for (const { exam } of evidence.included) {
      sources.set(exam.pdf_url, {
        title: `${options.courseCode} ${exam.exam_date ?? exam.exam_name ?? exam.id}`,
        url: exam.pdf_url,
      });
    }
    options.logFields.course_exam_context = {
      total: context.total,
      analysed: context.analysed.length,
      included: evidence.included.map(({ exam }) => exam.id),
      missing: context.missing,
      version: EXAM_ANALYSIS_VERSION,
    };
    console.info("Course exam context", {
      courseCode: options.courseCode,
      ...(options.logFields.course_exam_context as object),
    });
  } catch (error) {
    signal.throwIfAborted();
    console.error("Course exam context unavailable", error);
    options.logFields.course_exam_context = { error: "unavailable" };
    request = {
      ...request,
      systemPrompt:
        request.systemPrompt +
        "\nThe student requested course-wide exam analysis, but exam retrieval failed. Clearly say this is unavailable. Do not invent course-wide trends or frequencies; only the selected exam is available.",
    };
  }
  yield {
    type: "status",
    step: "search_done",
    message: "Läser tentaunderlaget",
  };
  for await (const event of streamModel(provider, request)) {
    if (event.type === "sources") {
      for (const item of event.items)
        sources.set(
          item.type === "file" ? `file:${item.fileId}` : item.url,
          item,
        );
    } else {
      yield event;
    }
  }
  if (sources.size) yield { type: "sources", items: [...sources.values()] };
}

export function validateCourseCode(code: string) {
  if (!COURSE_CODE_PATTERN.test(code))
    throw new Error("Expected a LiU course code, e.g. TATA41");
  return code;
}
