import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export async function extractPdf(bytes, wordLimit) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument({
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  });
  const document = await task.promise;
  const words = [];
  try {
    for (
      let pageNumber = 1;
      pageNumber <= document.numPages && words.length < wordLimit;
      pageNumber += 1
    ) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      words.push(
        ...content.items.flatMap((item) => String(item.str || "").match(/\S+/gu) || []),
      );
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return words.slice(0, wordLimit).join(" ");
}
