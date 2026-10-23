import * as pdfjs from 'pdfjs-dist';
import { extractPdfPages, type PdfJsApi } from './pdf';
import type { PDFPageProxy } from 'pdfjs-dist';

declare global {
  interface Window { documentPdf: { receive: (listener: (id: string, bytes: Uint8Array, kind: 'pdf' | 'image') => void) => void; complete: (id: string, result: unknown) => void } }
}
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf-assets/pdf.worker.mjs', location.href).href;
window.documentPdf.receive(async (id, bytes, kind) => {
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const canvas = document.createElement('canvas');
      try {
        if (bitmap.width <= 0 || bitmap.height <= 0 || Math.max(bitmap.width, bitmap.height) > 8192 || bitmap.width * bitmap.height > 16_000_000) throw new Error('Image dimensions exceed limit');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); if (!context) throw new Error('No image canvas');
        context.drawImage(bitmap, 0, 0);
        window.documentPdf.complete(id, { status: 'ready', warnings: [], parts: [{ locator: '图片', text: '', imageDataUrl: canvas.toDataURL('image/png') }] });
      } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
      return;
    }
    const result = await extractPdfPages(pdfjs as unknown as PdfJsApi, bytes, {
    cMapUrl: new URL('./pdf-assets/cmaps/', location.href).href,
    standardFontDataUrl: new URL('./pdf-assets/standard_fonts/', location.href).href,
    wasmUrl: new URL('./pdf-assets/wasm/', location.href).href,
    renderPage: async (page, scale) => {
      const pdfPage = page as PDFPageProxy, viewport = pdfPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('No page canvas');
      try {
        await pdfPage.render({ canvas, canvasContext: context, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
        return canvas.toDataURL('image/png');
      } finally { canvas.width = 0; canvas.height = 0; }
    },
  });
    window.documentPdf.complete(id, result);
  } catch { window.documentPdf.complete(id, { status: 'failed', parts: [], warnings: ['PDF 页面解析失败，需手动查看'] }); }
});
