import { extractImages, extractText, getDocumentProxy } from "unpdf";
import sharp from "sharp";

// Keep sharp/libvips from ballooning memory on Cloud Run: no operation cache,
// and one conversion at a time instead of one per vCPU.
sharp.cache(false);
sharp.concurrency(1);

export type GeminiPart =
  | { text: string }
  | {
      inlineData: { data: string; mimeType: "image/png" | "application/pdf" };
    };

const SCANNED_TEXT_THRESHOLD = 500;
const MAX_IMAGES_PER_PDF = 20;
const MAX_IMAGE_WIDTH = 1024;

function getPdfLabelText(label: "tenta" | "facit"): string {
  return label === "tenta"
    ? "Bifogad PDF: tentan med uppgifterna. Lös endast det användaren uttryckligen ber om."
    : "Bifogad PDF: facit. Använd endast som referens när användaren frågar om en specifik uppgift, och redovisa aldrig lösningar oombedd.";
}

async function fetchPdfBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch PDF at ${url}: ${response.statusText}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (error) {
    console.error(`Network error fetching PDF at ${url}:`, error);
    return null;
  }
}

async function extractPdfImageParts(
  pdf: any,
  totalPages: number,
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  let imageCount = 0;

  for (let page = 1; page <= totalPages; page++) {
    if (imageCount >= MAX_IMAGES_PER_PDF) break;

    let images: Awaited<ReturnType<typeof extractImages>>;
    try {
      images = await extractImages(pdf, page);
    } catch (error) {
      console.error(`Failed to extract images from page ${page}:`, error);
      continue;
    }

    for (const img of images) {
      if (imageCount >= MAX_IMAGES_PER_PDF) break;

      let png: Buffer;
      try {
        png = await sharp(Buffer.from(img.data), {
          raw: {
            width: img.width,
            height: img.height,
            channels: img.channels,
          },
        })
          .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
          .png()
          .toBuffer();
      } catch (error) {
        console.error(
          `Failed to convert image ${img.key} on page ${page}:`,
          error,
        );
        continue;
      }

      parts.push({ text: `Sida ${page}, bild ${img.key}` });
      parts.push({
        inlineData: {
          data: png.toString("base64"),
          mimeType: "image/png",
        },
      });
      imageCount++;
    }
  }

  return parts;
}

async function pdfToGeminiParts(
  url: string,
  label: "tenta" | "facit",
): Promise<GeminiPart[]> {
  const bytes = await fetchPdfBytes(url);
  if (!bytes) return [];

  // pdf.js detaches the buffer it's given, so hand it a copy and keep `bytes`
  // readable for the raw-PDF fallback below.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: true });

    const cleanText = text.trim();
    const isScanned = cleanText.length < SCANNED_TEXT_THRESHOLD;
    console.log(isScanned);
    console.log(cleanText);

    const parts: GeminiPart[] = [];
    parts.push({ text: getPdfLabelText(label) });

    if (!isScanned) {
      parts.push({ text: cleanText });

      const imageParts = await extractPdfImageParts(pdf, totalPages);
      parts.push(...imageParts);

      console.log(
        `[pdf:${label}] pages=${totalPages} textLen=${cleanText.length} scanned=false images=${imageParts.length / 2}`,
      );
    } else {
      // No usable text: fall back to handing Gemini the raw PDF, like before.
      // Cheaper on memory than decoding + converting every page via sharp.
      parts.push({
        inlineData: {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: "application/pdf",
        },
      });

      console.log(
        `[pdf:${label}] pages=${totalPages} textLen=${cleanText.length} scanned=true (raw pdf fallback)`,
      );
    }

    return parts;
  } finally {
    // Release pdf.js buffers as soon as we're done with the document.
    await pdf.destroy?.();
  }
}

export { fetchPdfBytes, pdfToGeminiParts, extractPdfImageParts };
