import { describe, expect, it } from "bun:test";
import {
  MAX_CHAT_ATTACHMENT_SIZE,
  validateChatAttachments,
} from "../src/api/v1/chat.attachments";

const SIGNATURES = {
  "application/pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
  "image/png": new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]),
  "image/webp": new TextEncoder().encode("RIFF0000WEBP"),
  "image/gif": new TextEncoder().encode("GIF89a"),
} as const;

function attachment(
  name: string,
  type: keyof typeof SIGNATURES,
  size?: number,
) {
  const signature = SIGNATURES[type];
  const padding = size
    ? new Uint8Array(Math.max(0, size - signature.length))
    : [];
  return new File([signature, padding], name, { type });
}

describe("chat attachment validation", () => {
  it("accepts every supported file signature", async () => {
    const files = [
      attachment("notes.pdf", "application/pdf"),
      attachment("photo.jpg", "image/jpeg"),
      attachment("plot.png", "image/png"),
      attachment("scan.webp", "image/webp"),
      attachment("animation.gif", "image/gif"),
    ];

    const result = await validateChatAttachments(files);

    expect(result.map((item) => item.mediaType)).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
    expect(result.every((item) => item.data.length > 0)).toBe(true);
  });

  it("rejects empty, unsupported, MIME-spoofed, and extension-spoofed files", async () => {
    await expect(
      validateChatAttachments([
        new File([], "empty.pdf", { type: "application/pdf" }),
      ]),
    ).rejects.toThrow("cannot be empty");
    await expect(
      validateChatAttachments([
        new File(["plain text"], "notes.txt", { type: "text/plain" }),
      ]),
    ).rejects.toThrow("Unsupported or invalid");
    await expect(
      validateChatAttachments([
        new File([SIGNATURES["image/png"]], "image.jpg", {
          type: "image/jpeg",
        }),
      ]),
    ).rejects.toThrow("declared media type");
    await expect(
      validateChatAttachments([
        new File([SIGNATURES["image/png"]], "image.jpg", {
          type: "image/png",
        }),
      ]),
    ).rejects.toThrow("extension");
  });

  it("enforces per-file, count, and combined-size limits", async () => {
    await expect(
      validateChatAttachments([
        attachment(
          "large.pdf",
          "application/pdf",
          MAX_CHAT_ATTACHMENT_SIZE + 1,
        ),
      ]),
    ).rejects.toThrow("5 MB");

    await expect(
      validateChatAttachments(
        Array.from({ length: 6 }, (_, index) =>
          attachment(`${index}.pdf`, "application/pdf"),
        ),
      ),
    ).rejects.toThrow("maximum of 5");

    await expect(
      validateChatAttachments(
        Array.from({ length: 5 }, (_, index) =>
          attachment(
            `${index}.pdf`,
            "application/pdf",
            4 * 1024 * 1024 + 1,
          ),
        ),
      ),
    ).rejects.toThrow("20 MB");
  });
});
