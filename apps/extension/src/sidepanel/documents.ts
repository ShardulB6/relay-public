import type { Api, Model } from "@earendil-works/pi-ai";
import { getDocument, GlobalWorkerOptions, PasswordException } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { documentBudget, type AttachedDocument } from "../core/session.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

export const PDF_TYPE = "application/pdf";

/**
 * Read a PDF's text for the model. No supported provider takes PDFs themselves, so the model
 * gets the text only: no images, scans or layout.
 */
export async function prepareDocument(
  file: File,
  model: Model<Api> | undefined,
): Promise<AttachedDocument> {
  if (file.type !== PDF_TYPE) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}. Attach a PDF or an image.`);
  }
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // Bundled by the build (see vite.config.ts); fonts with predefined encodings need them.
    cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"),
    cMapPacked: true,
  });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      const text = items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      if (text) pages.push(`[Page ${number}]\n${text}`);
      page.cleanup();
    }
    const text = pages.join("\n\n");
    if (!text) {
      throw new Error(`${file.name} has no text to read; it may be a scan.`);
    }
    // Refused early, so a huge document is not kept around; the whole message is checked again
    // against the model it is sent with.
    if (text.length > documentBudget(model)) {
      throw new Error(`${file.name} is too long for the selected model.`);
    }
    return { name: file.name, pages: pdf.numPages, text };
  } catch (error) {
    if (error instanceof PasswordException) {
      throw new Error(`${file.name} is password-protected.`, { cause: error });
    }
    throw error;
  } finally {
    await task.destroy();
  }
}

/** PDF files from a paste or drop, in the order they were given. */
export function documentFiles(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) => file.type === PDF_TYPE);
}
