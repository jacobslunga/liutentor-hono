import { z } from "zod";
import { CHAT_EFFORTS, CHAT_MODEL_IDS } from "./chat.models";

const messagesSchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.union([
        z.string(),
        z.array(
          z.union([
            z.object({
              type: z.literal("text"),
              text: z.string(),
            }),
            z.object({
              type: z.literal("file"),
              data: z.any(),
              mediaType: z.string(),
            }),
          ]),
        ),
      ]),
    }),
  )
  .min(1, "At least one message is required")
  .max(100, "Too many messages in conversation");

export const chatMessageSchema = z.object({
  messages: messagesSchema,
  examUrl: z.url(),
  solutionUrl: z.url().optional(),
  courseCode: z.string(),
  isFirstMessage: z.boolean().optional(),
  modelId: z.enum(CHAT_MODEL_IDS),
  effort: z.enum(CHAT_EFFORTS).default("low"),
  conversationId: z.uuid().optional().nullable(),
  selectionContext: z.string().max(200_000).optional(),
  webSearch: z.boolean().optional(),
  /** Lets the app stop this turn with POST /turns/:turnId/cancel. */
  turnId: z.uuid().optional(),
});

export const learnMessageSchema = z.object({
  messages: messagesSchema,
  courses: z
    .array(
      z.object({
        code: z.string().regex(/^[A-Z0-9]{5,6}$/, "Invalid course code"),
        name: z.string().max(200).optional(),
      }),
    )
    .max(3, "Too many courses")
    .optional(),
  courseId: z.uuid().optional().nullable(),
  isFirstMessage: z.boolean().optional(),
  modelId: z.enum(CHAT_MODEL_IDS),
  effort: z.enum(CHAT_EFFORTS).default("low"),
  conversationId: z.uuid().optional().nullable(),
  selectionContext: z.string().max(200_000).optional(),
  webSearch: z.boolean().optional(),
  turnId: z.uuid().optional(),
});

export const examIdSchema = z.object({
  examId: z
    .string()
    .min(1, "Exam ID is required")
    .regex(/^\d+$/, "Exam ID must be a number"),
});
