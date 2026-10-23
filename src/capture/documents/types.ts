export type DocumentPart = { locator: string; text: string; imageDataUrl?: string };
export type DocumentExtraction = {
  parts: DocumentPart[];
  warnings: string[];
  status: 'ready' | 'needs-review' | 'unsupported' | 'encrypted' | 'failed';
};
export type DocumentInput = { bytes: Buffer; name: string; mime?: string };
export type LegacyConverter = (input: DocumentInput, signal?: AbortSignal) => Promise<{ bytes: Buffer; name: string }>;
export type PdfExtractor = (bytes: Uint8Array, signal?: AbortSignal) => Promise<DocumentExtraction>;
export type DocumentOptions = { pdf?: PdfExtractor; legacyConverter?: LegacyConverter; signal?: AbortSignal };

export const DOCUMENT_LIMITS = Object.freeze({
  inputBytes: 25 * 1024 * 1024,
  expandedBytes: 200 * 1024 * 1024,
  xmlBytes: 32 * 1024 * 1024,
  zipEntries: 20_000,
  parts: 20_000,
  textCharacters: 5_000_000,
  imageBytes: 10 * 1024 * 1024,
  imageTotalBytes: 80 * 1024 * 1024,
  pdfPages: 500,
  timeoutMs: 60_000,
});
export const EXTRACTOR_VERSION = 'qq-documents-1';

export class DocumentError extends Error {
  constructor(message: string, readonly status: DocumentExtraction['status'] = 'failed') { super(message); }
}
export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DocumentError('文档处理已取消或超时', 'needs-review');
}
