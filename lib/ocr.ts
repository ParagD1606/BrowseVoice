import { createWorker } from "tesseract.js";

/** Recognize text embedded in a selected screenshot crop, independently of DOM text. */
export async function recognizeImageText(imageDataUrl: string, languages = "eng"): Promise<{ text: string; confidence: number }> {
  const extensionApi = (globalThis as typeof globalThis & { chrome?: { runtime?: { getURL(path: string): string } } }).chrome;
  const assetUrl = (path: string) => extensionApi?.runtime?.getURL(path) || path;
  const worker = await createWorker(languages, 1, {
    logger: () => undefined,
    workerPath: assetUrl("ocr/worker.min.js"),
    corePath: assetUrl("ocr/"),
    workerBlobURL: false,
    langPath: assetUrl("ocr/lang"),
    gzip: true,
  });
  try {
    const result = await worker.recognize(imageDataUrl);
    return { text: result.data.text.trim(), confidence: result.data.confidence };
  } finally {
    await worker.terminate();
  }
}
