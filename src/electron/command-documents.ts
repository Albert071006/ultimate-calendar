import { basename, extname } from 'node:path';
import { CommandDocumentSchema, MAX_COMMAND_DOCUMENTS, MAX_COMMAND_DOCUMENT_CHARACTERS, MAX_COMMAND_DOCUMENT_TOTAL_CHARACTERS, type CommandDocument } from '../shared/contracts';
import { DOCUMENT_LIMITS, type DocumentInput, type DocumentExtraction } from '../capture/documents/types';
import { WorkflowError } from '../ai/deepseek';
import { boundedFile } from './files';

export const COMMAND_DOCUMENT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'log', 'docx', 'xlsx', 'pptx', 'xls', 'pdf', 'doc', 'ppt'];
const informationalWarning = (warning: string) => warning.startsWith('文本编码按 GB18030 解码')
  || /包含合并单元格，内容以保存值所在单元格为准$/.test(warning)
  || /为隐藏工作表，已读取(?:其缓存内容|保存值)$/.test(warning)
  || ['文档包含宏或活动控件；未执行', '工作簿包含宏；未执行', '文档包含外部链接；未联网读取或更新外链',
    '工作簿包含链接，未访问或更新外部内容', '工作簿包含外部数据来源，仅读取已保存值，未更新外部数据'].includes(warning);

/** Paths come only from the trusted native picker. Return content and basenames, never paths. */
export async function commandDocumentsFromPaths(paths: string[], extract: (input: DocumentInput) => Promise<DocumentExtraction>): Promise<CommandDocument[]> {
  if (!paths.length || paths.length > MAX_COMMAND_DOCUMENTS) throw new WorkflowError('VALIDATION', '一次最多选择 3 份文件');
  const documents: CommandDocument[] = [];
  for (const path of paths) {
    const label = basename(path);
    if (!COMMAND_DOCUMENT_EXTENSIONS.includes(extname(label).slice(1).toLowerCase())) throw new WorkflowError('VALIDATION', '请选择文本、CSV、Word、Excel、PowerPoint 或 PDF 文件');
    const extracted = await extract({ name: label, bytes: await boundedFile(path, DOCUMENT_LIMITS.inputBytes) });
    // A table with missing rows/pages must not be presented as a complete roster.
    const seriousWarnings = extracted.warnings.filter(warning => !informationalWarning(warning));
    if (!['ready', 'needs-review'].includes(extracted.status) || seriousWarnings.length) {
      throw new WorkflowError('VALIDATION', `${label}：${seriousWarnings[0] ?? '文件无法完整读取，请解密或转换格式后重试'}`);
    }
    if (extracted.parts.some(part => part.imageDataUrl)) throw new WorkflowError('VALIDATION', `${label} 含扫描页或需看图的内容，请将相关页另存为图片发送；未发送不完整的文件文字`);
    const text = extracted.parts.filter(part => part.text.trim()).map(part => `[${part.locator}]\n${part.text}`).join('\n\n');
    if (!text.trim()) throw new WorkflowError('VALIDATION', `${label} 没有可读取的文字，请将相关页另存为图片发送`);
    if (text.length > MAX_COMMAND_DOCUMENT_CHARACTERS) throw new WorkflowError('VALIDATION', `${label} 超过 40000 字符，请先拆分文件；不会截断后发送`);
    if (documents.reduce((sum, item) => sum + item.text.length, text.length) > MAX_COMMAND_DOCUMENT_TOTAL_CHARACTERS) throw new WorkflowError('VALIDATION', '所选文件文字合计超过 100000 字符，请分次发送');
    const document = CommandDocumentSchema.safeParse({ label, text, ...(extracted.warnings.length ? { warnings: extracted.warnings } : {}) });
    if (!document.success) throw new WorkflowError('VALIDATION', '文件名称或提取内容超过限制，请缩短文件名或拆分后重试');
    documents.push(document.data);
  }
  return documents;
}
