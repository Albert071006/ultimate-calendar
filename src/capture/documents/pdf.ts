import { DOCUMENT_LIMITS, DocumentError, assertActive, type DocumentExtraction, type DocumentPart } from './types';

// Structural types keep this helper usable in the isolated browser worker without importing Node or PDF.js in the main process.
export type PdfPage = {
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  getViewport(options: { scale: number }): { width: number; height: number };
  cleanup(): void;
};
type PdfDocument = { numPages: number; getPage(number: number): Promise<PdfPage> };
export type PdfJsApi = {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
  OPS: Record<string, number>;
};
export type PdfPageOptions = {
  renderPage?: (page: PdfPage, scale: number, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
};

/** Run in the application's sandboxed PDF renderer, with PDF.js worker/resources served only from packaged files. */
export async function extractPdfPages(pdfjs: PdfJsApi, bytes: Uint8Array, options: PdfPageOptions = {}): Promise<DocumentExtraction> {
  if (bytes.byteLength > DOCUMENT_LIMITS.inputBytes) throw new DocumentError('PDF 超过 25 MB 自动处理限额', 'needs-review');
  assertActive(options.signal);
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false,
    useWorkerFetch: false, maxImageSize: 16_000_000, stopAtErrors: true, verbosity: 0,
    ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
    ...(options.standardFontDataUrl ? { standardFontDataUrl: options.standardFontDataUrl } : {}),
    ...(options.wasmUrl ? { wasmUrl: options.wasmUrl } : {}),
  });
  const abort = () => { void loading.destroy().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  let document: PdfDocument | undefined;
  const parts: DocumentPart[] = [], warnings: string[] = [];
  try {
    document = await loading.promise;
    if (document.numPages > DOCUMENT_LIMITS.pdfPages) throw new DocumentError('PDF 超过 500 页自动处理限额', 'needs-review');
    let textCharacters = 0, imageBytes = 0;
    const imageOps = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'].map(name => pdfjs.OPS[name]).filter((value): value is number => value !== undefined));
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      assertActive(options.signal);
      const page = await document.getPage(pageNumber), locator = `PDF/第 ${pageNumber} 页`;
      try {
        let text = '', textFailed = false, images = false;
        try {
          const content = await page.getTextContent();
          text = content.items.map(item => {
            if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string') return '';
            return item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ');
          }).join('').trim();
          const malformed = (text.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length;
          textFailed = malformed > 0 && malformed / Math.max(text.length, 1) > 0.02;
          if (textFailed) warnings.push(`${locator}：文字编码异常，不能依赖提取文本`);
        } catch { textFailed = true; warnings.push(`${locator}：文字层读取失败`); }
        try { images = (await page.getOperatorList()).fnArray.some(op => imageOps.has(op)); }
        catch { images = true; warnings.push(`${locator}：页面绘图信息不完整，需核对`); }
        textCharacters += text.length;
        if (textCharacters > DOCUMENT_LIMITS.textCharacters) throw new DocumentError('PDF 正文超过自动处理限额', 'needs-review');
        if (text && !textFailed) parts.push({ locator: `${locator}/文字层`, text });
        if (!text || images || textFailed) {
          if (!options.renderPage) { warnings.push(`${locator}：需要图片识别，但 PDF 页面渲染组件不可用`); continue; }
          const viewport = page.getViewport({ scale: 1 });
          if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) { warnings.push(`${locator}：页面尺寸异常，无法渲染`); continue; }
          const scale = Math.min(2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)), 4096 / Math.max(viewport.width, viewport.height));
          try {
            const imageDataUrl = await options.renderPage(page, scale, options.signal);
            const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(imageDataUrl);
            if (!match) throw new Error('Invalid page image');
            const size = Math.ceil(match[2]!.length * 3 / 4);
            if (size > DOCUMENT_LIMITS.imageBytes || imageBytes + size > DOCUMENT_LIMITS.imageTotalBytes) { warnings.push(`${locator}：页图超过自动识别限额`); continue; }
            imageBytes += size; parts.push({ locator: `${locator}/页面图（待视觉识别）`, text: '', imageDataUrl });
          } catch { assertActive(options.signal); warnings.push(`${locator}：页面转图片失败，需手动查看`); }
        }
      } finally { page.cleanup(); }
    }
    if (!parts.length) warnings.push('PDF 没有可读取的正文或页图，需手动查看');
    return { parts, warnings, status: warnings.length ? 'needs-review' : 'ready' };
  } catch (error) {
    if (error instanceof DocumentError) return { parts, warnings: [...warnings, error.message], status: error.status };
    if (error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException') return { parts: [], warnings: ['PDF 已加密，需先手动解密'], status: 'encrypted' };
    assertActive(options.signal);
    return { parts, warnings: [...warnings, 'PDF 损坏或无法解析，需手动查看'], status: 'failed' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await loading.destroy().catch(() => {});
  }
}
