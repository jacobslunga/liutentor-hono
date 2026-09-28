import {
  LEARN_SYSTEM_PROMPT,
  LEARN_WEB_SEARCH_PROMPT,
  SYSTEM_PROMPT,
  WEB_SEARCH_PROMPT,
  courseContextPrompt,
} from "~/utils/prompts";
import { SKILL_PROMPTS } from "~/utils/skills";
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
import { streamOpenAIResponse, PdfData } from "~/utils/chat.utils";
import { getModelConfig, getModelLogId } from "./chat.models";
import { fetchPdfAsBase64 } from "~/utils/pdf.cache";
import { rateLimitByIdentity } from "~/utils/rate.limit";
import {
  extractTextContent,
  logToDBAsync,
  readChatForm,
  resolveChatIdentity,
  streamChatResponse,
} from "./chat.handler";

const chat = new Hono().basePath("/v1/chat");

// ~12/min is roughly 10x the fastest real usage: the p25 gap between turns in
// a session is 54s, so even an intense student sits near 1/min. Both chat
// routes share the bucket, so a student gets the same budget either way.
const chatRateLimit = () =>
  rateLimitByIdentity({ windowMs: 60_000, max: 12, name: "chat" });

/** Resolves the tier and refuses the deep tier to anonymous users. */
function resolveModel(modelId: string | undefined, userId: string | null) {
  const modelConfig = getModelConfig(modelId);
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
      conversationId,
      isFirstMessage,
      modelId,
      selectionContext,
      webSearch: requestedWebSearch,
      skill,
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

    const { modelConfig, modelLogId } = resolveModel(modelId, userId);
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
      // Turns hur frågan ställdes till något admin kan läsa. `webSearch` är den
      // effektiva flaggan, efter modellgatingen på raden ovan — inte det klienten
      // bad om, eftersom det är den förra som faktiskt formade svaret.
      selection_context: selectionContext || null,
      skill: skill || null,
      web_search: webSearch,
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

    // Additivt, så att webbsökning och en vald färdighet kan gälla samtidigt.
    let systemPrompt = SYSTEM_PROMPT;
    if (webSearch) systemPrompt += WEB_SEARCH_PROMPT;
    if (skill && SKILL_PROMPTS[skill]) systemPrompt += SKILL_PROMPTS[skill];

    const modelLastMsgText =
      lastMsgText.trim() ||
      "Hjälp mig att förstå och arbeta med det bifogade materialet.";

    const cacheKey = `${examUrl}:${solutionUrl || ""}`;

    return streamChatResponse(c, {
      responseStream: streamOpenAIResponse(
        systemPrompt,
        messages,
        resolvedModelId,
        pdfs,
        userAttachments,
        modelLastMsgText,
        selectionContext,
        cacheKey,
        webSearch,
        effort,
      ),
      identity,
      conversationId,
      titleCourseCode: courseCode,
      lastMsgText,
      logFields: {
        user_id: userId,
        conversation_id: conversationId || null,
        anonymous_user_id: anonymousUserId,
        course_code: courseCode,
        exam_id: examId,
        model: modelLogId,
      },
    });
  },
);

/**
 * The standalone learning chat. No exam is attached; courses referenced with
 * "@TATA41" are named in the prompt and turn on web search so the model can
 * look up what the course covers.
 */
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
      conversationId,
      isFirstMessage,
      modelId,
      selectionContext,
      webSearch: requestedWebSearch,
    } = body;

    const identity = await resolveChatIdentity(c, {
      conversationId,
      isFirstMessage,
      messageCount: messages.length,
    });
    const { userId, anonymousUserId } = identity;

    const { modelConfig, modelLogId } = resolveModel(modelId, userId);
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
      ["Model", `${resolvedModelId}  (${provider}, ${effort})`],
      ["Messages", String(messages.length)],
      ["Files", String(userAttachments.length)],
      ["Webb", webSearch ? "on" : "off"],
      ["User", userId ?? `anon:${anonymousUserId}`],
    ]);

    let systemPrompt = LEARN_SYSTEM_PROMPT;
    if (webSearch) systemPrompt += LEARN_WEB_SEARCH_PROMPT;
    systemPrompt += courseContextPrompt(courses);

    const modelLastMsgText =
      lastMsgText.trim() ||
      "Hjälp mig att förstå och arbeta med det bifogade materialet.";

    return streamChatResponse(c, {
      responseStream: streamOpenAIResponse(
        systemPrompt,
        messages,
        resolvedModelId,
        [],
        userAttachments,
        modelLastMsgText,
        selectionContext,
        undefined,
        webSearch,
        effort,
      ),
      identity,
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

export default chat;
