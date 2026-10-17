import {
  LEARN_SYSTEM_PROMPT,
  LEARN_WEB_SEARCH_PROMPT,
  SYSTEM_PROMPT,
  WEB_SEARCH_PROMPT,
  courseContextPrompt,
  studyCoursePrompt,
} from "~/utils/prompts";
import { courseChatContext } from "~/utils/course-material";
import {
  chatMessageSchema,
  examIdSchema,
  learnMessageSchema,
} from "./chat.schemas";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { PdfData } from "~/utils/chat.utils";
import { streamChatModel } from "~/utils/chat.providers";
import { streamExamChat } from "~/utils/course-exams-chat";
import {
  LUNA_CHAT_MODEL_ID,
  getModelConfig,
  getModelLogId,
  type ChatModelId,
  type ReasoningEffort,
} from "./chat.models";
import { fetchPdfAsBase64 } from "~/utils/pdf";
import { rateLimitByIdentity } from "~/utils/rate.limit";
import {
  cancelTurn,
  extractTextContent,
  logToDBAsync,
  readChatForm,
  resolveChatIdentity,
  startTurn,
  streamChatResponse,
  turnOwner,
} from "./chat.handler";
import { getAuthenticatedUserId } from "~/utils/auth";
import { z } from "zod";

const chat = new Hono().basePath("/v1/chat");

const chatRateLimit = () =>
  rateLimitByIdentity({ windowMs: 60_000, max: 12, name: "chat" });

function resolveModel(
  modelId: ChatModelId,
  effort: ReasoningEffort,
  userId: string | null,
  // Course material lives in an OpenAI vector store that only Luna can search.
  needsFileSearch = false,
) {
  const modelConfig = getModelConfig(
    needsFileSearch ? LUNA_CHAT_MODEL_ID : modelId,
    effort,
  );
  if (modelConfig.requiresAuth && !userId) {
    throw new HTTPException(403, {
      message: "Den här tankenivån kräver att du är inloggad",
    });
  }
  return { modelConfig, modelLogId: getModelLogId(modelConfig) };
}

function logRequest(rows: [string, string][]) {
  const cyan = "\x1b[36m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(
    `${cyan}┌─ CHAT REQUEST ${"─".repeat(35)}\n` +
      rows
        .map(
          ([label, value], i) =>
            `${i ? `${cyan}│` : "│"}${reset}  ${bold}${label.padEnd(width)}${reset} ${dim}→${reset}  ${value}\n`,
        )
        .join("") +
      `${cyan}└${"─".repeat(50)}${reset}`,
  );
}

chat.post(
  "/completion/:examId",
  chatRateLimit(),
  zValidator("param", examIdSchema),
  bodyLimit({ maxSize: 22 * 1024 * 1024 }),
  timeout(120000),
  async (c) => {
    const { examId } = c.req.valid("param");
    const { body, attachments: userAttachments } = await readChatForm(
      c,
      chatMessageSchema,
    );

    const {
      messages,
      examUrl,
      solutionUrl,
      courseCode,
      courseExams,
      conversationId,
      isFirstMessage,
      modelId,
      effort: requestedEffort,
      selectionContext,
      webSearch: requestedWebSearch,
      turnId,
    } = body;

    if (!examUrl || !messages?.length) {
      throw new HTTPException(400, { message: "Missing examUrl or messages" });
    }

    const identity = await resolveChatIdentity(c, {
      conversationId,
      isFirstMessage,
      messageCount: messages.length,
    });
    const { userId, anonymousUserId } = identity;

    const { modelConfig, modelLogId } = resolveModel(
      modelId,
      requestedEffort,
      userId,
    );
    const { provider, modelId: resolvedModelId, effort } = modelConfig;
    const webSearch = !!requestedWebSearch && !!modelConfig.supportsWebSearch;

    const lastMsgText = extractTextContent(
      messages[messages.length - 1]?.content,
    );

    logToDBAsync({
      user_id: userId,
      conversation_id: conversationId || null,
      anonymous_user_id: anonymousUserId,
      course_code: courseCode,
      exam_id: examId,
      role: "user",
      content: lastMsgText,
      model: modelLogId,
      selection_context: selectionContext || null,
      web_search: webSearch,
      course_exams_requested: courseExams,
    });

    const [examBase64, solutionBase64] = await Promise.all([
      fetchPdfAsBase64(examUrl),
      solutionUrl ? fetchPdfAsBase64(solutionUrl) : Promise.resolve(null),
    ]);

    logRequest([
      ["Course", courseCode ?? "unknown"],
      ["Exam ID", examId],
      ["Model", `${resolvedModelId}  (${provider}, ${effort})`],
      ["Messages", String(messages.length)],
      ["Facit", solutionUrl ? "yes" : "no"],
      ["Files", String(userAttachments.length)],
      ["Webb", webSearch ? "on" : "off"],
      ["User", userId ?? `anon:${anonymousUserId}`],
    ]);

    const pdfs: PdfData[] = [];
    if (examBase64) {
      pdfs.push({
        data: examBase64,
        mimeType: "application/pdf",
        label: "tenta",
      });
    }
    if (solutionBase64) {
      pdfs.push({
        data: solutionBase64,
        mimeType: "application/pdf",
        label: "facit",
      });
    }

    let systemPrompt = SYSTEM_PROMPT;
    if (webSearch) systemPrompt += WEB_SEARCH_PROMPT;

    const modelLastMsgText =
      lastMsgText.trim() ||
      "Hjälp mig att förstå och arbeta med det bifogade materialet.";

    const cacheKey = `${examUrl}:${solutionUrl || ""}`;
    const examTurn = startTurn(turnId, turnOwner(identity));
    const logFields: Record<string, unknown> = {
      user_id: userId,
      conversation_id: conversationId || null,
      anonymous_user_id: anonymousUserId,
      course_code: courseCode,
      exam_id: examId,
      model: modelLogId,
      course_exams_requested: courseExams,
    };

    return streamChatResponse(c, {
      responseStream: streamExamChat(
        provider,
        {
          systemPrompt,
          messages,
          modelId: resolvedModelId,
          pdfs,
          userAttachments,
          lastMsgText: modelLastMsgText,
          selectionContext,
          cacheKey,
          tools: { webSearch, signal: examTurn.signal },
          effort,
        },
        { enabled: courseExams, courseCode, logFields },
      ),
      identity,
      turn: examTurn,
      conversationId,
      titleCourseCode: courseCode,
      lastMsgText,
      logFields,
    });
  },
);

chat.post(
  "/learn",
  chatRateLimit(),
  bodyLimit({ maxSize: 22 * 1024 * 1024 }),
  timeout(120000),
  async (c) => {
    const { body, attachments: userAttachments } = await readChatForm(
      c,
      learnMessageSchema,
    );

    const {
      messages,
      courses = [],
      courseId,
      conversationId,
      isFirstMessage,
      modelId,
      effort: requestedEffort,
      selectionContext,
      webSearch: requestedWebSearch,
      turnId,
    } = body;

    const identity = await resolveChatIdentity(c, {
      conversationId,
      isFirstMessage,
      messageCount: messages.length,
    });
    const { userId, anonymousUserId } = identity;

    if (courseId && !userId) {
      throw new HTTPException(401, {
        message: "Logga in för att använda kurser",
      });
    }
    const studyCourse =
      courseId && userId ? await courseChatContext(courseId, userId) : null;

    const vectorStoreId = studyCourse?.vectorStoreId ?? null;
    const { modelConfig, modelLogId } = resolveModel(
      modelId,
      requestedEffort,
      userId,
      !!vectorStoreId,
    );
    const { provider, modelId: resolvedModelId, effort } = modelConfig;
    const webSearch =
      (!!requestedWebSearch || courses.length > 0) &&
      !!modelConfig.supportsWebSearch;

    const courseCode = courses.map((course) => course.code).join(",");
    const lastMsgText = extractTextContent(
      messages[messages.length - 1]?.content,
    );

    logToDBAsync({
      user_id: userId,
      conversation_id: conversationId || null,
      anonymous_user_id: anonymousUserId,
      course_code: courseCode || null,
      exam_id: null,
      role: "user",
      content: lastMsgText,
      model: modelLogId,
      selection_context: selectionContext || null,
      web_search: webSearch,
    });

    logRequest([
      ["Kind", "learn"],
      ["Courses", courseCode || "none"],
      [
        "Study",
        studyCourse
          ? `${studyCourse.name}${vectorStoreId ? " (material)" : ""}`
          : "none",
      ],
      ["Model", `${resolvedModelId}  (${provider}, ${effort})`],
      ["Messages", String(messages.length)],
      ["Files", String(userAttachments.length)],
      ["Webb", webSearch ? "on" : "off"],
      ["User", userId ?? `anon:${anonymousUserId}`],
    ]);

    let systemPrompt = LEARN_SYSTEM_PROMPT;
    if (webSearch) systemPrompt += LEARN_WEB_SEARCH_PROMPT;
    systemPrompt += courseContextPrompt(courses);
    if (studyCourse) {
      systemPrompt += studyCoursePrompt(studyCourse.name, !!vectorStoreId);
    }

    const modelLastMsgText =
      lastMsgText.trim() ||
      "Hjälp mig att förstå och arbeta med det bifogade materialet.";
    const learnTurn = startTurn(turnId, turnOwner(identity));

    return streamChatResponse(c, {
      responseStream: streamChatModel(provider, {
        systemPrompt,
        messages,
        modelId: resolvedModelId,
        pdfs: [],
        userAttachments,
        lastMsgText: modelLastMsgText,
        selectionContext,
        tools: { webSearch, vectorStoreId, signal: learnTurn.signal },
        effort,
      }),
      identity,
      turn: learnTurn,
      conversationId,
      titleCourseCode: courseCode,
      lastMsgText,
      logFields: {
        user_id: userId,
        conversation_id: conversationId || null,
        anonymous_user_id: anonymousUserId,
        course_code: courseCode || null,
        exam_id: null,
        model: modelLogId,
      },
    });
  },
);

chat.post(
  "/turns/:turnId/cancel",
  zValidator("param", z.object({ turnId: z.uuid() })),
  async (c) => {
    const userId = await getAuthenticatedUserId(c.req.header("Authorization"));
    const anonymousUserId = c.req.header("x-anonymous-user-id") || "unknown";
    const cancelled = cancelTurn(
      c.req.valid("param").turnId,
      turnOwner({ userId, anonymousUserId }),
    );
    return c.json({ success: true, message: "OK", payload: { cancelled } });
  },
);

export default chat;
