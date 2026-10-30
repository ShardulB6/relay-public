import { beforeAll, describe, expect, test } from "vite-plus/test";

import { prepareDocument } from "./documents.ts";

// Without Workers, pdf.js runs its worker on this thread, from the module given here.
beforeAll(async () => {
  // @ts-expect-error pdf.js ships no types for its worker.
  const worker: unknown = await import("pdfjs-dist/build/pdf.worker.mjs");
  Object.assign(globalThis, { pdfjsWorker: worker });
});

/** A two-page PDF reading "Hello Relay" and "Second page". */
const PDF =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MiA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDE1MCBUZCAoSGVsbG8gUmVsYXkpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAyMDBdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcgMCBSID4+ID4+IC9Db250ZW50cyA2IDAgUiA+PgplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDQyID4+CnN0cmVhbQpCVCAvRjEgMTIgVGYgMjAgMTUwIFRkIChTZWNvbmQgcGFnZSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzMzkgMDAwMDAgbiAKMDAwMDAwMDQ2NSAwMDAwMCBuIAowMDAwMDAwNTU3IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjI3CiUlRU9GCg==";

function pdfFile(name = "notes.pdf") {
  return new File([Uint8Array.from(atob(PDF), (char) => char.charCodeAt(0))], name, {
    type: "application/pdf",
  });
}

describe("prepareDocument", () => {
  test("reads a PDF's text page by page", async () => {
    const file = pdfFile();
    expect(await prepareDocument(file, undefined)).toEqual({
      name: "notes.pdf",
      pages: 2,
      text: "[Page 1]\nHello Relay\n\n[Page 2]\nSecond page",
      file,
    });
  });

  test("refuses a PDF too long for the model", async () => {
    const model = { contextWindow: 4 } as Parameters<typeof prepareDocument>[1];
    await expect(prepareDocument(pdfFile(), model)).rejects.toThrow(
      "notes.pdf is too long for the selected model.",
    );
  });

  test("refuses files that are not PDFs", async () => {
    const file = new File(["hi"], "notes.txt", { type: "text/plain" });
    await expect(prepareDocument(file, undefined)).rejects.toThrow("Unsupported file type");
  });
});
