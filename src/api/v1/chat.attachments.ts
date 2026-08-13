import { HTTPException } from "hono/http-exception";

export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_SIZE = 5 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_TOTAL_SIZE = 20 * 1024 * 1024;

export type ChatAttachmentMediaType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export interface ValidatedChatAttachment {
  data: string;
  filename: string;
  mediaType: ChatAttachmentMediaType;
}

const EXTENSIONS_BY_MEDIA_TYPE: Record<ChatAttachmentMediaType, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

function fail(message: string): never {
  throw new HTTPException(400, { message });
}

function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || "attachment";
  const sanitized = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const safeName = sanitized || "attachment";
  if (safeName.length <= 255) return safeName;

  const extensionStart = safeName.lastIndexOf(".");
  const extension =
    extensionStart > 0 ? safeName.slice(extensionStart).slice(0, 20) : "";
  return `${safeName.slice(0, 255 - extension.length)}${extension}`;
}

export function detectChatAttachmentMediaType(
  bytes: Uint8Array,
): ChatAttachmentMediaType | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }

  return null;
}

export async function validateChatAttachments(
  files: File[],
): Promise<ValidatedChatAttachment[]> {
  if (files.length > MAX_CHAT_ATTACHMENTS) {
    fail(`A maximum of ${MAX_CHAT_ATTACHMENTS} attachments is allowed`);
  }

  let totalSize = 0;
  const validated: ValidatedChatAttachment[] = [];

  for (const file of files) {
    if (file.size === 0) fail("Attachments cannot be empty");
    if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
      fail("Each attachment must be 5 MB or smaller");
    }

    totalSize += file.size;
    if (totalSize > MAX_CHAT_ATTACHMENTS_TOTAL_SIZE) {
      fail("Attachments must be 20 MB or smaller in total");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detectedMediaType = detectChatAttachmentMediaType(bytes);
    if (!detectedMediaType) fail("Unsupported or invalid attachment type");
    if (file.type !== detectedMediaType) {
      fail("Attachment content does not match its declared media type");
    }

    const filename = sanitizeFilename(file.name);
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!EXTENSIONS_BY_MEDIA_TYPE[detectedMediaType].includes(extension)) {
      fail("Attachment extension does not match its content");
    }

    validated.push({
      data: Buffer.from(bytes).toString("base64"),
      filename,
      mediaType: detectedMediaType,
    });
  }

  return validated;
}
