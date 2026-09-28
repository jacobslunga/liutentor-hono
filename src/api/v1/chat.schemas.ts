import { z } from "zod";
import { SKILL_IDS } from "~/utils/skills";

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

/**
 * Schema for chat messages
 */
export const chatMessageSchema = z.object({
  messages: messagesSchema,
  examUrl: z.url(),
  solutionUrl: z.url().optional(),
  courseCode: z.string(),
  isFirstMessage: z.boolean().optional(),
  modelId: z.string().optional(),
  conversationId: z.uuid().optional().nullable(),
  selectionContext: z.string().max(2000).optional(),
  webSearch: z.boolean().optional(),
  skill: z.enum(SKILL_IDS).optional(),
});

/**
 * Schema for the standalone learning chat: no exam, but up to three LiU
 * courses the student referenced with "@TATA41".
 */
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
  isFirstMessage: z.boolean().optional(),
  modelId: z.string().optional(),
  conversationId: z.uuid().optional().nullable(),
  selectionContext: z.string().max(2000).optional(),
  webSearch: z.boolean().optional(),
});

/**
 * Schema for exam ID parameter
 */
export const examIdSchema = z.object({
  examId: z
    .string()
    .min(1, "Exam ID is required")
    .regex(/^\d+$/, "Exam ID must be a number"),
});
