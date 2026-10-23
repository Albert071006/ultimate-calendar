import { BrowserWindow, app, ipcMain, session, nativeImage } from 'electron';
import { join, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { createLibreOfficeConverter, type LibreOfficeConfig } from './libreoffice';
import { detectLibreOffice } from './libreoffice-discovery';
import { DOCUMENT_LIMITS, DocumentError, type DocumentInput, type DocumentExtraction } from './types';
import { imageDimensions } from './image-dimensions';

const resultSchema = z.object({ status: z.enum(['ready', 'needs-review', 'unsupported', 'encrypted', 'failed']),
  warnings: z.array(z.string().max(2000)).max(20_000), parts: z.array(z.object({ locator: z.string().max(2000), text: z.string().max(DOCUMENT_LIMITS.textCharacters), imageDataUrl: z.string().max(14_000_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/).optional() }).strict()).max(DOCUMENT_LIMITS.parts),
}).strict();
const failure = (message: string): DocumentExtraction => ({ parts: [], warnings: [message], status: 'needs-review' });

async function normalizeImages(result: DocumentExtraction, convert: (bytes: Buffer) => Promise<string | null>, signal: AbortSignal): Promise<DocumentExtraction> {
  const warnings = [...result.warnings], parts: DocumentExtraction['parts'] = []; let total = 0;
  for (const part of result.parts) {
    if (signal.aborted) { warnings.push('图片处理已取消或超时，剩余图片需稍后重试'); break; }
    if (!part.imageDataUrl) { parts.push(part); continue; }
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.imageDataUrl);
    const bytes = match ? Buffer.from(match[2]!, 'base64') : Buffer.alloc(0), dimensions = imageDimensions(bytes);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || Math.max(dimensions.width, dimensions.height) > 8192 || dimensions.width * dimensions.height > 16_000_000 || bytes.length > DOCUMENT_LIMITS.imageBytes) {
      warnings.push(`${part.locator}：图片格式、尺寸或大小超出安全识别范围`); if (part.text) parts.push({ locator: part.locator, text: part.text }); continue;
    }
    let converted = bytes;
    if (['gif', 'webp'].includes(match![1]!)) {
      const png = await convert(bytes);
      if (!png || !/^data:image\/png;base64,/.test(png)) { warnings.push(`${part.locator}：图片转换失败，需手动查看`); continue; }
      converted = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
    }
    const image = nativeImage.createFromBuffer(converted);
    if (image.isEmpty()) { warnings.push(`${part.locator}：图片数据无法解码`); if (part.text) parts.push({ locator: part.locator, text: part.text }); continue; }
    if (converted.length > DOCUMENT_LIMITS.imageBytes || total + converted.length > DOCUMENT_LIMITS.imageTotalBytes) { warnings.push(`${part.locator}：转换后图片超过自动识别限额`); continue; }
    total += converted.length;
    if (match![1] === 'gif') warnings.push(`${part.locator}：动图仅识别首帧，后续画面需手动查看`);
    parts.push({ ...part, imageDataUrl: ['gif', 'webp'].includes(match![1]!) ? `data:image/png;base64,${converted.toString('base64')}` : part.imageDataUrl });
  }
  return { ...result, parts, warnings, status: warnings.length > result.warnings.length && result.status === 'ready' ? 'needs-review' : result.status };
}

/** Main-process owner for isolated PDF pages and bounded Node parsing workers. */
export function createDocumentExtractor(options: { runtimeDirectory?: string; libreOffice?: LibreOfficeConfig } = {}) {
  const directory = options.runtimeDirectory ?? join(app.getAppPath(), 'dist-electron');
  const windows = new Set<BrowserWindow>(), workers = new Set<Worker>(); let disposed = false;
  let legacyConfig: Promise<LibreOfficeConfig | null> | undefined;
  const controllers = new Set<AbortController>();

  async function parseSandbox(input: DocumentInput, signal: AbortSignal, kind: 'pdf' | 'image' = 'pdf'): Promise<DocumentExtraction> {
    if (signal.aborted) return failure('文档处理已取消或超时');
    if (kind === 'pdf' && !input.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return failure('文件不是有效 PDF');
    const isolated = session.fromPartition(`calendar-pdf-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try { if (details.url.startsWith('file:')) { const path = relative(directory, fileURLToPath(details.url)); allowed = !!path && !path.startsWith('..') && !isAbsolute(path); } } catch { /* Disallow unknown origins. */ }
      callback({ cancel: !allowed });
    });
    const window = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { preload: join(directory, 'pdf-preload.cjs'), session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
    windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const id = randomUUID();
    return await new Promise<DocumentExtraction>(resolveResult => {
      let completed = false;
      const finish = (result: DocumentExtraction) => {
        if (completed) return; completed = true;
        signal.removeEventListener('abort', abort); ipcMain.removeListener('calendar:pdf:complete', onResult);
        windows.delete(window); if (!window.isDestroyed()) window.destroy();
        resolveResult(result);
      };
      const abort = () => finish(failure('PDF 处理已取消或超过 60 秒限额'));
      const onResult = (event: Electron.IpcMainEvent, resultId: unknown, value: unknown) => {
        if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || resultId !== id) return;
        const result = resultSchema.safeParse(value);
        if (!result.success) return finish(failure('PDF 解析结果异常，需手动查看'));
        const totalText = result.data.parts.reduce((sum, part) => sum + part.text.length, 0), totalImages = result.data.parts.reduce((sum, part) => sum + (part.imageDataUrl?.length ?? 0), 0);
        finish(totalText > DOCUMENT_LIMITS.textCharacters || totalImages > DOCUMENT_LIMITS.imageTotalBytes * 1.4 ? failure('PDF 解析结果超过处理限额') : result.data);
      };
      signal.addEventListener('abort', abort, { once: true });
      ipcMain.on('calendar:pdf:complete', onResult);
      window.webContents.once('render-process-gone', () => finish(failure('PDF 解析进程退出，需稍后重试')));
      window.once('closed', () => finish(failure('PDF 解析窗口已关闭')));
      void window.loadFile(join(directory, 'pdf.html')).then(() => {
        if (!completed) window.webContents.send('calendar:pdf:extract', id, new Uint8Array(input.bytes), kind);
      }).catch(() => finish(failure('PDF 解析组件加载失败')));
      if (signal.aborted) abort();
    });
  }
  async function parseWorker(input: DocumentInput, signal: AbortSignal): Promise<DocumentExtraction> {
    const worker = new Worker(join(directory, 'document-worker.cjs'), { workerData: { ...input, bytes: new Uint8Array(input.bytes) }, resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 } });
    workers.add(worker);
    return await new Promise<DocumentExtraction>(resolveResult => {
      let done = false;
      const finish = (result: DocumentExtraction) => { if (done) return; done = true; signal.removeEventListener('abort', abort); workers.delete(worker); void worker.terminate(); resolveResult(result); };
      const abort = () => finish(failure('文档处理已取消或超过 60 秒限额'));
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (value: unknown) => { const result = resultSchema.safeParse(value); finish(result.success ? result.data : failure('文档解析结果异常')); });
      worker.once('error', () => finish(failure('文档解析失败或超过内存限额')));
      worker.once('exit', () => finish(failure('文档解析进程已退出')));
      if (signal.aborted) abort();
    });
  }
  return {
    async extract(input: DocumentInput, incomingSignal?: AbortSignal): Promise<DocumentExtraction> {
      if (disposed) return failure('文档解析服务已停止');
      if (input.bytes.length > DOCUMENT_LIMITS.inputBytes) return failure('文件超过 25 MB 自动处理限额');
      const controller = new AbortController(); controllers.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DOCUMENT_LIMITS.timeoutMs), ...(incomingSignal ? [incomingSignal] : [])]);
      const normalize = (result: DocumentExtraction) => normalizeImages(result, async bytes => (await parseSandbox({ name: 'image', bytes }, signal, 'image')).parts[0]?.imageDataUrl ?? null, signal);
      try {
        const extension = extname(input.name).slice(1).toLowerCase();
        if (extension === 'pdf') return await normalize(await parseSandbox(input, signal));
        if (['doc', 'ppt'].includes(extension)) {
          if (!input.bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return failure('旧版 Office 文件头无效，需手动查看');
          if (input.bytes.includes(Buffer.from('EncryptedPackage', 'utf16le')) || input.bytes.includes(Buffer.from('EncryptionInfo', 'utf16le'))) return { parts: [], warnings: ['Office 文档已加密，需先手动解密'], status: 'encrypted' };
          legacyConfig ??= options.libreOffice ? Promise.resolve(options.libreOffice) : detectLibreOffice();
          const config = await legacyConfig;
          if (!config) return failure('LibreOffice 转换组件未安装或其 Python 不可用，旧版 Office 文件需手动查看');
          const converted = await createLibreOfficeConverter(config)(input, signal);
          const result = await parseWorker(converted, signal);
          return await normalize({ ...result, parts: result.parts.map(part => ({ ...part, locator: `旧版文档转换/${part.locator}` })) });
        }
        return await normalize(await parseWorker(input, signal));
      } catch (error) { return error instanceof DocumentError ? { parts: [], warnings: [error.message], status: error.status } : failure('文档解析或转换失败，需手动查看'); }
      finally { controllers.delete(controller); }
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); for (const window of windows) if (!window.isDestroyed()) window.destroy(); for (const worker of workers) void worker.terminate(); windows.clear(); workers.clear(); },
  };
}
