import { extractImages, extractText, getDocumentProxy } from "unpdf";
import sharp from "sharp";

export type GeminiPart =
  | { text: string }
  | { inlineData: { data: string; mimeType: "image/png" } };

const SCANNED_TEXT_THRESHOLD = 500;
const MAX_IMAGES_PER_PDF = 20;
const MAX_IMAGE_WIDTH = 1600;

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

  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });

  const cleanText = text.trim();
  const isScanned = cleanText.length < SCANNED_TEXT_THRESHOLD;

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
    parts.push({
      text: "Denna PDF verkar vara inskannad och innehåller lite eller ingen extraherbar text. Sidorna bifogas som bilder.",
    });

    const imageParts = await extractPdfImageParts(pdf, totalPages);

    if (imageParts.length === 0) {
      throw new Error("PDF looked scanned, but no images could be extracted");
    }

    parts.push(...imageParts);

    console.log(
      `[pdf:${label}] pages=${totalPages} textLen=${cleanText.length} scanned=true images=${imageParts.length / 2}`,
    );
  }

  return parts;
}

export { fetchPdfBytes, pdfToGeminiParts, extractPdfImageParts };
