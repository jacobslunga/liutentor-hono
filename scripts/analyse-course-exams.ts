import {
  CHAT_MODEL_IDS,
  getModelConfig,
  LUNA_CHAT_MODEL_ID,
} from "../src/api/v1/chat.models";
import {
  courseExamRepository,
  validateCourseCode,
} from "../src/utils/course-exams-chat";
import { loadCourseExamContext } from "../src/utils/course-exams";

// Operator-run prewarming, not a web endpoint. Never run automatically at startup.
const code = validateCourseCode((process.argv[2] ?? "").toUpperCase());
const model = process.argv[3] ?? LUNA_CHAT_MODEL_ID;
if (!CHAT_MODEL_IDS.includes(model as (typeof CHAT_MODEL_IDS)[number])) {
  throw new Error(`Supported models: ${CHAT_MODEL_IDS.join(", ")}`);
}
const config = getModelConfig(model as (typeof CHAT_MODEL_IDS)[number], "low");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
const context = await loadCourseExamContext(
  code,
  courseExamRepository(config.provider, config.modelId, 120_000),
  controller.signal,
  console.info,
  Infinity,
);
console.info(
  JSON.stringify({
    courseCode: code,
    total: context.total,
    analysed: context.analysed.length,
    missing: context.missing,
  }),
);
// A subsequent run reuses successful records and retries missing exams only.
if (context.missing.length) process.exitCode = 1;
