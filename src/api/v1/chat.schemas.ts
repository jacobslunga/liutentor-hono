import { z } from "zod";

/**
 * Schema for chat messages
 */
export const chatMessageSchema = z.object({
  messages: z
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
    .max(100, "Too many messages in conversation"),
  giveDirectAnswer: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Whether to give direct answers or challenge the student to think",
    ),
  examUrl: z.url(),
  solutionUrl: z.url().optional(),
  courseCode: z.string(),
  isFirstMessage: z.boolean().optional(),
  modelId: z.string().optional(),
  conversationId: z.uuid().optional().nullable(),
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
