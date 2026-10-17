import { describe, expect, it } from "bun:test";
import {
  chatMessageSchema,
  learnMessageSchema,
} from "../src/api/v1/chat.schemas";
import { CHAT_MODEL_IDS } from "../src/api/v1/chat.models";

const base = {
  messages: [{ role: "user", content: "x".repeat(200_000) }],
  modelId: CHAT_MODEL_IDS[0],
  examUrl: "https://example.com/exam.pdf",
  courseCode: "TAOP88",
};

describe("large chat contexts", () => {
  for (const [name, schema] of [
    ["exam", chatMessageSchema],
    ["learn", learnMessageSchema],
  ] as const) {
    it(`${name} accepts a 200,000-character message and selection`, () => {
      expect(
        schema.safeParse({ ...base, selectionContext: "x".repeat(200_000) })
          .success,
      ).toBe(true);
    });
    it(`${name} rejects selections over the limit`, () => {
      expect(
        schema.safeParse({ ...base, selectionContext: "x".repeat(200_001) })
          .success,
      ).toBe(false);
    });
  }
});
