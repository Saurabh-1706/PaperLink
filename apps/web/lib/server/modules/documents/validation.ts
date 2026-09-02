/**
 * Upload validation. Never trust the declared content type.
 * Port of backend/app/modules/documents/validation.py.
 */
import { createHash } from "crypto";
import { settings } from "@/lib/server/config";
import { FileTooLargeError, UnsupportedFileError, CorruptDocumentError } from "@/lib/server/errors";
import { imagesToPdf, inspectPdf } from "./pdf";

const PDF_MAGIC = Buffer.from("%PDF-");
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ValidatedUpload {
  checksum: string;
  size: number;
  pageCount: number;
  mime: string;
}

export function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function looksLikeImage(data: Buffer): boolean {
  return data.subarray(0, 3).equals(JPEG_MAGIC) || data.subarray(0, 8).equals(PNG_MAGIC);
}

/** Accepts one PDF, or one-or-more JPEG/PNG images (one per page, in order), and
 * returns `(pdfBytes, mime)` ready for validatePdf. A mixed batch is rejected
 * outright rather than guessed at. */
export async function normalizeUploadToPdf(
  uploads: Array<{ filename: string; data: Buffer }>
): Promise<{ data: Buffer; mime: string }> {
  if (uploads.length === 0) throw new UnsupportedFileError("No file was uploaded.");
  if (uploads.length === 1 && uploads[0].data.subarray(0, 5).equals(PDF_MAGIC)) {
    return { data: uploads[0].data, mime: "application/pdf" };
  }

  const images: Buffer[] = [];
  for (const { filename, data } of uploads) {
    if (!looksLikeImage(data)) {
      throw new UnsupportedFileError(
        "Upload a single PDF, or one or more JPEG/PNG images (one per page).",
        { filename }
      );
    }
    images.push(data);
  }

  try {
    return { data: await imagesToPdf(images), mime: "application/pdf" };
  } catch (err) {
    if (err instanceof UnsupportedFileError) throw err;
    throw new CorruptDocumentError(String((err as Error)?.message ?? err));
  }
}

export async function validatePdf(data: Buffer): Promise<ValidatedUpload> {
  if (data.length === 0) throw new UnsupportedFileError("The uploaded file is empty.");
  if (data.length > settings.maxUploadBytes) {
    throw new FileTooLargeError("The uploaded file exceeds the size cap.", {
      size: data.length,
      cap: settings.maxUploadBytes,
    });
  }
  if (!data.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new UnsupportedFileError("The uploaded file is not a PDF.");
  }

  const { pageCount } = await inspectPdf(data);

  return {
    checksum: computeChecksum(data),
    size: data.length,
    pageCount,
    mime: "application/pdf",
  };
}
