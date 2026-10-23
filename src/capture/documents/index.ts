import { extname } from 'node:path';
import { extractOffice, imageMime } from './ooxml';
import { extractXls } from './xls';
import { DOCUMENT_LIMITS, DocumentError, assertActive, type DocumentExtraction, type DocumentInput, type DocumentOptions } from './types';
export * from './types';
export { extractPdfPages } from './pdf';
export type { PdfJsApi, PdfPage, PdfPageOptions } from './pdf';
export { createLibreOfficeConverter } from './libreoffice';

function decodeText(bytes: Buffer): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let encoding: string = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch {
    encoding = 'gb18030';
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); warnings.push('文本编码按 GB18030 解码，请核对中文字与符号'); }
    catch { throw new DocumentError('文本编码无法识别或文件损坏，需手动查看', 'needs-review'); }
  }
  if (text.includes('\0') || /[\u0001-\u0008\u000B\u000E-\u001F]/.test(text)) throw new DocumentError('文本包含二进制内容或异常控制字符，需手动查看', 'needs-review');
  if (text.length > DOCUMENT_LIMITS.textCharacters) throw new DocumentError('文本超过自动处理字符限额', 'needs-review');
  return { text: text.replace(/^\uFEFF/, ''), warnings };
}

/** Only parses bytes supplied by the validated attachment downloader. Never reads filenames as filesystem paths. */
export async function extractDocument(input: DocumentInput, options: DocumentOptions = {}): Promise<DocumentExtraction> {
  const timer = AbortSignal.timeout(DOCUMENT_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
  try {
    assertActive(signal);
    if (input.bytes.byteLength > DOCUMENT_LIMITS.inputBytes) throw new DocumentError('文件超过 25 MB 自动处理限额', 'needs-review');
    if (!input.bytes.byteLength) throw new DocumentError('文件为空，需手动查看', 'needs-review');
    const extension = extname(input.name).slice(1).toLowerCase();
    if (['txt', 'csv', 'md', 'markdown', 'log'].includes(extension)) {
      const { text, warnings } = decodeText(input.bytes);
      const lines = text.split(/\r\n?|\n/), parts = [];
      for (let i = 0; i < lines.length; i += 50) {
        const chunk = lines.slice(i, i + 50).join('\n');
        if (chunk.trim()) parts.push({ locator: `第 ${i + 1}–${Math.min(i + 50, lines.length)} 行`, text: chunk });
      }
      if (!parts.length) warnings.push('文件没有可读文字，需手动查看');
      return { parts, warnings, status: warnings.length ? 'needs-review' : 'ready' };
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg'].includes(extension)) {
      const mime = imageMime(input.bytes);
      if (!mime) return { parts: [], warnings: ['图片格式无法直接识别，需手动查看或转成 PNG/JPEG'], status: 'unsupported' };
      if (input.bytes.length > DOCUMENT_LIMITS.imageBytes) throw new DocumentError('单张图片超过 10 MB 自动识别限额', 'needs-review');
      return { parts: [{ locator: '图片（待视觉识别）', text: '', imageDataUrl: `data:${mime};base64,${input.bytes.toString('base64')}` }], warnings: [], status: 'ready' };
    }
    const ole = input.bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (ole && (input.bytes.includes(Buffer.from('EncryptedPackage', 'utf16le')) || input.bytes.includes(Buffer.from('EncryptionInfo', 'utf16le')))) return { parts: [], warnings: ['Office 文档已加密，需先手动解密'], status: 'encrypted' };
    if (extension === 'pdf') {
      if (!input.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new DocumentError('文件不是有效的 PDF 文档');
      if (!options.pdf) return { parts: [], warnings: ['PDF 解析组件不可用，需稍后重试'], status: 'needs-review' };
      return await options.pdf(new Uint8Array(input.bytes), signal);
    }
    if (extension === 'docx' || extension === 'xlsx' || extension === 'pptx') return extractOffice(input.bytes, extension);
    if (extension === 'xls') {
      if (!ole) throw new DocumentError('旧版 Excel 文件头无效，需手动查看');
      return extractXls(input.bytes);
    }
    if (['doc', 'ppt'].includes(extension)) {
      if (!ole) throw new DocumentError('旧版 Office 文件头无效，需手动查看');
      if (!options.legacyConverter) return { parts: [], warnings: ['旧版 Office 转换组件不可用，需安装 LibreOffice 或手动另存为新版格式'], status: 'needs-review' };
      const converted = await options.legacyConverter(input, signal);
      assertActive(signal);
      const expected = `${extension}x`;
      if (extname(converted.name).slice(1).toLowerCase() !== expected || converted.bytes.length > DOCUMENT_LIMITS.inputBytes) throw new DocumentError('旧版 Office 转换结果格式或大小不符合要求', 'needs-review');
      const extracted = extractOffice(converted.bytes, expected as 'docx' | 'xlsx' | 'pptx');
      return { ...extracted, parts: extracted.parts.map(part => ({ ...part, locator: `旧版文档转换/${part.locator}` })) };
    }
    return { parts: [], warnings: [/^(zip|rar|7z|tar|gz)$/.test(extension) ? '压缩包不自动展开，请手动查看' : '此文件格式暂不自动分析'], status: 'unsupported' };
  } catch (error) {
    return { parts: [], warnings: [error instanceof DocumentError ? error.message : '文档处理失败或内容损坏，需手动查看'], status: error instanceof DocumentError ? error.status : 'failed' };
  }
}
