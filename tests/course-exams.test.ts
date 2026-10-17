import { describe, expect, it } from "bun:test";
import {
  courseExamPrompt,
  loadCourseExamContext,
  type CourseExam,
  type CourseExamRepository,
  type ExamAnalysis,
} from "../src/utils/course-exams";
import { streamExamChat } from "../src/utils/course-exams-chat";
import type { ChatModelRequest } from "../src/utils/chat.providers";
import type { ChatStreamEvent } from "../src/utils/chat.utils";
import { CHAT_MODEL_IDS } from "../src/api/v1/chat.models";
import { chatMessageSchema } from "../src/api/v1/chat.schemas";

const exam = (id: number): CourseExam => ({
  id,
  course_code: "TATA41",
  exam_date: `2025-01-${String(id).padStart(2, "0")}`,
  exam_name: "TEN1",
  pdf_url: `https://example.com/${id}.pdf`,
});
const analysis: ExamAnalysis = {
  readable: true,
  overview: "Integraler",
  questions: [
    {
      reference: "1",
      description: "Integrera",
      topics: ["Integration by parts"],
    },
    {
      reference: "2",
      description: "Integrera igen",
      topics: ["integration by parts"],
    },
  ],
};
const signal = () => new AbortController().signal;
const request: ChatModelRequest = {
  systemPrompt: "Tutor",
  messages: [{ role: "user", content: "Help" }],
  lastMsgText: "Help",
  modelId: CHAT_MODEL_IDS[0],
  pdfs: [],
  userAttachments: [],
  effort: "low",
};
const collect = async (stream: AsyncGenerator<ChatStreamEvent>) => {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

describe("course exam evidence", () => {
  it("defaults to off and rejects malformed enabled course codes", () => {
    const payload = {
      ...request,
      courseCode: "TATA41",
      examUrl: "https://example.com/1.pdf",
    };
    expect(chatMessageSchema.parse(payload).courseExams).toBe(false);
    expect(
      chatMessageSchema.safeParse({ ...payload, courseExams: "true" }).success,
    ).toBe(false);
    expect(
      chatMessageSchema.safeParse({
        ...payload,
        courseExams: true,
        courseCode: "../other",
      }).success,
    ).toBe(false);
  });

  it("includes cached exams and bounds new work without counting duplicate URLs", async () => {
    const attempted: number[] = [];
    let active = 0;
    let peak = 0;
    const exams = Array.from({ length: 9 }, (_, i) => exam(i + 1));
    exams.push({ ...exam(10), pdf_url: exams[0].pdf_url });
    const repository: CourseExamRepository = {
      list: async () => exams,
      cached: async () => [{ exam: exams[0], analysis }],
      analyse: async (item) => {
        attempted.push(item.id);
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return analysis;
      },
    };
    const context = await loadCourseExamContext("TATA41", repository, signal());
    expect(context.total).toBe(9);
    expect(attempted).toEqual([2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(context.analysed.map(({ exam }) => exam.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(context.missing).toEqual([6, 7, 8, 9]);
  });

  it("does not count unreadable exams as evidence", async () => {
    const context = await loadCourseExamContext(
      "TATA41",
      {
        list: async () => [exam(1), exam(2)],
        cached: async () => [],
        analyse: async (item) =>
          item.id === 1
            ? { readable: false, overview: "", questions: [] }
            : analysis,
      },
      signal(),
    );
    expect(context.analysed.length).toBe(1);
    expect(context.missing).toEqual([1]);
  });

  it("skips recently failed records so older exams can still be analysed", async () => {
    const attempted: number[] = [];
    const context = await loadCourseExamContext(
      "TATA41",
      {
        list: async () => [exam(1), exam(2)],
        cached: async () => [
          {
            exam: exam(1),
            analysis: { readable: false, overview: "", questions: [] },
          },
        ],
        analyse: async (item) => {
          attempted.push(item.id);
          return analysis;
        },
      },
      signal(),
      undefined,
      1,
    );
    expect(attempted).toEqual([2]);
    expect(context.missing).toEqual([1]);
    expect(context.analysed.map(({ exam }) => exam.id)).toEqual([2]);
  });

  it("counts distinct exams and discloses context truncation", () => {
    const context = {
      courseCode: "TATA41",
      total: 3,
      missing: [3],
      analysed: [1, 2].map((id) => ({ exam: exam(id), analysis })),
    };
    const full = courseExamPrompt(context);
    expect(full.prompt).toContain(
      '"topic":"integration by parts","count":2,"examIds":[1,2]',
    );
    expect(full.prompt).toContain("2 of 3");
    const limited = courseExamPrompt(context, 700);
    expect(limited.included.length).toBe(1);
    expect(limited.prompt).toContain("1 analysed exams were omitted");
    expect(limited.prompt).toContain('"count":1,"examIds":[1]');
  });

  it("honours cancellation before any work", async () => {
    let queried = false;
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCourseExamContext(
        "TATA41",
        {
          list: async () => {
            queried = true;
            return [];
          },
          cached: async () => [],
          analyse: async () => analysis,
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(queried).toBe(false);
  });

  it("stops running extraction and starts no more exams when cancelled", async () => {
    const controller = new AbortController();
    const attempted: number[] = [];
    await expect(
      loadCourseExamContext(
        "TATA41",
        {
          list: async () => [exam(1), exam(2), exam(3)],
          cached: async () => [],
          analyse: async (item, activeSignal) => {
            attempted.push(item.id);
            controller.abort();
            activeSignal.throwIfAborted();
            return analysis;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(attempted).toEqual([1]);
  });

  it("does no retrieval or extraction when disabled, across providers", async () => {
    for (const provider of ["openai", "anthropic", "google"] as const) {
      let queried = false;
      const logs = {};
      const events = await collect(
        streamExamChat(provider, request, {
          enabled: false,
          courseCode: "TATA41",
          logFields: logs,
          repository: {
            list: async () => {
              queried = true;
              throw new Error("Must not query");
            },
            cached: async () => [],
            analyse: async () => {
              throw new Error("Must not extract");
            },
          },
          streamModel: async function* (actualProvider, actualRequest) {
            expect(actualProvider).toBe(provider);
            expect(actualRequest).toBe(request);
            yield { type: "text", delta: "Normal answer" };
          },
        }),
      );
      expect(queried).toBe(false);
      expect(logs).toEqual({});
      expect(events).toEqual([{ type: "text", delta: "Normal answer" }]);
    }
  });

  it("adds evidence only when enabled, merges sources and logs coverage", async () => {
    const logs: Record<string, unknown> = {};
    const events = await collect(
      streamExamChat("google", request, {
        enabled: true,
        courseCode: "TATA41",
        logFields: logs,
        repository: {
          list: async () => [exam(1)],
          cached: async () => [{ exam: exam(1), analysis }],
          analyse: async () => {
            throw new Error("Cache hit");
          },
        },
        streamModel: async function* (_, enriched) {
          expect(enriched.systemPrompt).toContain("1 of 1");
          yield { type: "text", delta: "Course answer" };
          yield {
            type: "sources",
            items: [{ title: "Syllabus", url: "https://example.com/syllabus" }],
          };
        },
      }),
    );
    expect(logs.course_exam_context).toMatchObject({
      total: 1,
      analysed: 1,
      included: [1],
      missing: [],
    });
    const sources = events.filter((event) => event.type === "sources");
    expect(sources.length).toBe(1);
    expect(sources[0].items).toHaveLength(2);
    expect(request.systemPrompt).toBe("Tutor");
  });

  it("keeps selected-exam chat available when course retrieval fails", async () => {
    const logs: Record<string, unknown> = {};
    const events = await collect(
      streamExamChat("openai", request, {
        enabled: true,
        courseCode: "TATA41",
        logFields: logs,
        repository: {
          list: async () => {
            throw new Error("Test database unavailable");
          },
          cached: async () => [],
          analyse: async () => analysis,
        },
        streamModel: async function* (_, enriched) {
          expect(enriched.systemPrompt).toContain("exam retrieval failed");
          expect(enriched.pdfs).toBe(request.pdfs);
          yield { type: "text", delta: "Course analysis unavailable" };
        },
      }),
    );
    expect(logs.course_exam_context).toEqual({ error: "unavailable" });
    expect(events.some((event) => event.type === "text")).toBe(true);
  });
});
