import * as XLSX from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import { DOCUMENT_LIMITS, DocumentError, type DocumentExtraction, type DocumentPart } from './types';
XLSX.set_cptable(codepages);

/** SheetJS only reads stored BIFF values; formulas, macros and external links are never executed. */
export function extractXls(bytes: Buffer): DocumentExtraction {
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true, cellNF: true, cellText: true, cellDates: false, bookVBA: true, bookFiles: true, dense: false, raw: true }); }
  catch (error) {
    if (error instanceof Error && /password|encrypt/i.test(error.message)) throw new DocumentError('Excel 文件已加密，需先手动解密', 'encrypted');
    throw new DocumentError('旧版 Excel 文件损坏或无法解析');
  }
  const warnings = new Set<string>(), parts: DocumentPart[] = [];
  let characters = 0;
  const date1904 = !!workbook.Workbook?.WBProps?.date1904;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name], label = `工作表「${name}」`;
    if (!sheet) { warnings.add(`${label}缺失`); continue; }
    const rows = new Map<number, Array<{ address: string; column: number; text: string }>>();
    for (const address of Object.keys(sheet)) {
      if (address.startsWith('!')) continue;
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new DocumentError('旧版 Excel 单元格地址损坏');
      const cell = sheet[address] as XLSX.CellObject;
      let text = cell.v === undefined || cell.v === null ? '' : cell.w ?? String(cell.v);
      if (cell.f && (cell.v === undefined || cell.v === null)) { warnings.add(`${label}/${address}：公式没有已保存的结果，未重新计算`); text = '[公式缓存结果缺失]'; }
      if (cell.t === 'e') warnings.add(`${label}/${address}：单元格为错误值`);
      if (cell.l?.Target) warnings.add('工作簿包含链接，未访问或更新外部内容');
      if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && XLSX.SSF.is_date(cell.z)) {
        const date = XLSX.SSF.parse_date_code(cell.v, { date1904 });
        if (date) {
          const format = String(cell.z).replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
          const time = `${String(date.H).padStart(2, '0')}:${String(date.M).padStart(2, '0')}:${String(date.S).padStart(2, '0')}`;
          text = !/[yd]/i.test(format) && /[hs]/i.test(format) ? time : `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}${date.H || date.M || date.S ? ` ${time}` : ''}`;
        }
      }
      if (!text) continue;
      characters += text.length;
      if (characters > DOCUMENT_LIMITS.textCharacters) throw new DocumentError('旧版 Excel 正文超过处理限额', 'needs-review');
      const decoded = XLSX.utils.decode_cell(address), row = rows.get(decoded.r) ?? [];
      row.push({ address, column: decoded.c, text: `${address}=${text}${cell.f && cell.v !== undefined ? '（已保存公式结果）' : ''}` }); rows.set(decoded.r, row);
    }
    for (const [, values] of [...rows].sort(([a], [b]) => a - b)) {
      values.sort((a, b) => a.column - b.column);
      parts.push({ locator: `${label}/${values[0]!.address}${values.length > 1 ? `:${values.at(-1)!.address}` : ''}`, text: values.map(value => value.text).join(' | ') });
      if (parts.length > DOCUMENT_LIMITS.parts) throw new DocumentError('旧版 Excel 行数超过处理限额', 'needs-review');
    }
    if (sheet['!merges']?.length) warnings.add(`${label}包含合并单元格，内容以保存值所在单元格为准`);
    if (workbook.Workbook?.Sheets?.find(metadata => metadata.name === name)?.Hidden) warnings.add(`${label}为隐藏工作表，已读取保存值`);
  }
  if (workbook.vbaraw) warnings.add('工作簿包含宏；未执行');
  const cfb = (workbook as unknown as { cfb?: { FileIndex?: { name?: string; content?: Uint8Array }[] } }).cfb;
  const stream = cfb?.FileIndex?.find(entry => /^(Workbook|Book)$/i.test(entry.name ?? ''))?.content;
  if (stream) {
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    const drawingContent = (start: number, end: number, depth = 0): boolean | null => {
      if (depth > 12) return true;
      for (let offset = start; offset + 8 <= end;) {
        const options = view.getUint16(offset, true), type = view.getUint16(offset + 2, true), length = view.getUint32(offset + 4, true), finish = offset + 8 + length;
        if (finish > end) return null;
        // LibreOffice writes an empty drawing root (one patriarch shape) even for sheets with no drawings.
        if (type === 0xf008 && length >= 8) return view.getUint32(offset + 8, true) > 1;
        if ((options & 15) === 15) { const nested = drawingContent(offset + 8, finish, depth + 1); if (nested !== null) return nested; }
        offset = finish;
      }
      return null;
    };
    for (let offset = 0; offset + 4 <= stream.length;) {
      const record = view.getUint16(offset, true), length = view.getUint16(offset + 2, true);
      if (record === 0x1002 || record === 0x00ec && (drawingContent(offset + 4, Math.min(offset + 4 + length, stream.length)) ?? true)) { warnings.add('旧版 Excel 包含绘图或图表，图片布局需手动查看'); break; }
      offset += 4 + length;
    }
  }
  if (!parts.length) warnings.add('工作簿没有可读单元格，需手动查看');
  return { parts, warnings: [...warnings], status: warnings.size ? 'needs-review' : 'ready' };
}
