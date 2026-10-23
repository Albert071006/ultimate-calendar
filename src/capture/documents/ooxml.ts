import { DOMParser, type Element, type Document, type Node } from '@xmldom/xmldom';
import { posix } from 'node:path';
import { DOCUMENT_LIMITS, DocumentError, type DocumentExtraction, type DocumentPart } from './types';
import { readOfficeZip } from './zip';

type Relationship = { id: string; type: string; target: string; external: boolean };
function elements(node: Node): Element[] {
  return Array.from({ length: node.childNodes.length }, (_, i) => node.childNodes.item(i)).filter((n): n is Element => n?.nodeType === 1);
}
function all(node: Element | Document, local: string): Element[] {
  return Array.from(node.getElementsByTagName('*')).filter(element => element.localName === local);
}
function direct(node: Node, local: string): Element[] { return elements(node).filter(element => element.localName === local); }
function attribute(element: Element, local: string): string {
  for (let i = 0; i < element.attributes.length; i++) { const a = element.attributes.item(i); if (a?.localName === local && (a.prefix === 'r' || a.namespaceURI?.endsWith('/relationships'))) return a.value; }
  for (let i = 0; i < element.attributes.length; i++) { const a = element.attributes.item(i); if (a?.localName === local) return a.value; }
  return '';
}
function plainText(element: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (['t', 'delText'].includes(el.localName ?? '')) return el.localName === 't' ? el.textContent ?? '' : '';
    if (['tab'].includes(el.localName ?? '')) return '\t';
    if (['br', 'cr'].includes(el.localName ?? '')) return '\n';
    return elements(el).map(walk).join('');
  };
  return walk(element).trim();
}
function hasAncestor(element: Element, local: string): boolean {
  let parent = element.parentNode;
  while (parent?.nodeType === 1) { if ((parent as Element).localName === local) return true; parent = parent.parentNode; }
  return false;
}
export function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

class OfficeReader {
  files: Map<string, Buffer>;
  parts: DocumentPart[] = [];
  warnings = new Set<string>();
  private characters = 0;
  private imageBytes = 0;
  private xmlCache = new Map<string, Document>();
  constructor(bytes: Buffer) { this.files = readOfficeZip(bytes); }
  warn(message: string): void { this.warnings.add(message); }
  add(locator: string, text: string, imageDataUrl?: string): void {
    if (!text.trim() && !imageDataUrl) return;
    this.characters += text.length;
    if (this.parts.length >= DOCUMENT_LIMITS.parts || this.characters > DOCUMENT_LIMITS.textCharacters) throw new DocumentError('文档正文或定位片段超出处理限额，需手动查看', 'needs-review');
    this.parts.push({ locator, text, ...(imageDataUrl ? { imageDataUrl } : {}) });
  }
  xml(name: string): Document {
    const previous = this.xmlCache.get(name); if (previous) return previous;
    const bytes = this.files.get(name);
    if (!bytes) throw new DocumentError('Office 文档缺少必要的正文或关系文件');
    if (bytes.length > DOCUMENT_LIMITS.xmlBytes) throw new DocumentError('文档单个 XML 内容超过处理限额', 'needs-review');
    let value: string;
    try { value = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DocumentError('Office 文档 XML 编码损坏'); }
    if (/<!\s*(DOCTYPE|ENTITY)/i.test(value)) throw new DocumentError('文档 XML 不允许自定义实体或外部定义');
    let broken = false;
    const document = new DOMParser({ onError: () => { broken = true; } }).parseFromString(value, 'text/xml');
    if (broken || !document.documentElement) throw new DocumentError('Office 文档 XML 结构损坏');
    this.xmlCache.set(name, document); return document;
  }
  relationships(part: string): Relationship[] {
    const file = `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
    if (!this.files.has(file)) return [];
    return all(this.xml(file), 'Relationship').map(element => {
      const raw = element.getAttribute('Target') ?? '', external = element.getAttribute('TargetMode') === 'External';
      if (external) { this.warn('文档包含外部链接；未联网读取或更新外链'); return { id: element.getAttribute('Id') ?? '', type: element.getAttribute('Type') ?? '', target: '', external }; }
      let target: string; try { target = decodeURIComponent(raw).replace(/^\//, ''); } catch { throw new DocumentError('文档关系路径损坏'); }
      if (!raw.startsWith('/')) target = posix.join(posix.dirname(part), target);
      target = posix.normalize(target);
      if (!target || target.startsWith('../') || target.includes('\\') || target.includes(':') || target.includes('\0') || target.includes('#') || target.includes('?')) throw new DocumentError('文档关系指向不允许的路径');
      return { id: element.getAttribute('Id') ?? '', type: element.getAttribute('Type') ?? '', target, external: false };
    });
  }
  image(target: string, locator: string): void {
    const bytes = this.files.get(target);
    if (!bytes) { this.warn(`${locator}：图片资源缺失`); return; }
    const mime = imageMime(bytes);
    if (!mime) { this.warn(`${locator}：图片格式需手动查看（可能为矢量图或旧式图元）`); return; }
    if (bytes.length > DOCUMENT_LIMITS.imageBytes || this.imageBytes + bytes.length > DOCUMENT_LIMITS.imageTotalBytes) { this.warn(`${locator}：图片超出自动识别限额`); return; }
    this.imageBytes += bytes.length;
    this.add(locator, '', `data:${mime};base64,${bytes.toString('base64')}`);
  }
  media(element: Element | Document, part: string, locator: string, visited = new Set<string>(), depth = 0): void {
    if (depth > 4 || visited.has(part)) { this.warn(`${locator}：复杂嵌入关系需手动查看`); return; }
    visited.add(part);
    const relations = this.relationships(part);
    const relationMap = new Map(relations.map(relation => [relation.id, relation]));
    const imageIds = [...all(element, 'blip').map(el => attribute(el, 'embed')), ...all(element, 'imagedata').map(el => attribute(el, 'id'))].filter(Boolean);
    for (const [i, id] of [...new Set(imageIds)].entries()) {
      const relation = relationMap.get(id);
      if (relation && !relation.external) this.image(relation.target, `${locator}/图片 ${i + 1}`);
      else this.warn(`${locator}：图片引用缺失或为外链`);
    }
    for (const chart of all(element, 'chart')) {
      const relation = relationMap.get(attribute(chart, 'id'));
      if (relation && !relation.external && this.files.has(relation.target)) {
        const data = this.xml(relation.target), values = all(data, 'v').map(v => v.textContent ?? '').filter(Boolean);
        this.add(`${locator}/图表缓存`, values.join(' | '));
      }
      this.warn(`${locator}：图表仅读取已有缓存，视觉布局需人工核对`);
    }
    for (const relation of relations.filter(r => /\/drawing$/.test(r.type) && !r.external)) {
      if (this.files.has(relation.target)) this.media(this.xml(relation.target), relation.target, locator, visited, depth + 1);
      else this.warn(`${locator}：绘图资源缺失`);
    }
    if (all(element, 'relIds').length) this.warn(`${locator}：SmartArt 图形需要手动核对`);
    if (all(element, 'oleObject').length || all(element, 'OLEObject').length || relations.some(r => /\/(oleObject|package)$/.test(r.type))) this.warn(`${locator}：嵌入对象未执行或展开`);
  }
  output(): DocumentExtraction {
    if (!this.parts.length) this.warn('文档未提取到可读正文或图片，需手动查看');
    if ([...this.files.keys()].some(path => /(?:vbaProject\.bin|activeX\/)/i.test(path))) this.warn('文档包含宏或活动控件；未执行');
    return { parts: this.parts, warnings: [...this.warnings], status: this.warnings.size ? 'needs-review' : 'ready' };
  }
}

function extractWord(reader: OfficeReader): void {
  const main = 'word/document.xml';
  const readPart = (part: string, label: string) => {
    const doc = reader.xml(part); let paragraph = 0, table = 0;
    const root = all(doc, 'body')[0] ?? doc.documentElement!;
    const blocks = (node: Node) => {
      for (const element of elements(node)) {
        if (element.localName === 'p') {
          const locator = `${label}/段落 ${++paragraph}`;
          reader.add(locator, plainText(element)); reader.media(element, part, locator);
        } else if (element.localName === 'tbl') {
          table++;
          for (const [i, row] of direct(element, 'tr').entries()) {
            const text = direct(row, 'tc').map(cell => all(cell, 'p').map(plainText).join('\n')).join(' | ');
            const locator = `${label}/表格 ${table}/行 ${i + 1}`;
            reader.add(locator, text); reader.media(row, part, locator);
          }
        } else if (element.localName !== 'del') blocks(element);
      }
    };
    blocks(root);
    if (all(doc, 'altChunk').length) reader.warn(`${label}：包含未展开的附加文档内容`);
  };
  readPart(main, '正文');
  const additional = reader.relationships(main).filter(r => !r.external && /\/(header|footer|footnotes|endnotes|comments)$/.test(r.type));
  for (const [i, relation] of additional.entries()) {
    if (reader.files.has(relation.target)) readPart(relation.target, `${/header$/.test(relation.type) ? '页眉' : /footer$/.test(relation.type) ? '页脚' : /comments$/.test(relation.type) ? '批注' : '注释'} ${i + 1}`);
    else reader.warn('文档的页眉、页脚或注释文件缺失');
  }
}

function extractPowerPoint(reader: OfficeReader): void {
  const main = 'ppt/presentation.xml', presentation = reader.xml(main), relationships = new Map(reader.relationships(main).map(r => [r.id, r]));
  const ids = all(presentation, 'sldId');
  if (!ids.length) reader.warn('演示文稿没有可读取的幻灯片');
  for (const [index, id] of ids.entries()) {
    const relation = relationships.get(attribute(id, 'id'));
    if (!relation || relation.external) throw new DocumentError('幻灯片顺序关系损坏');
    const slide = reader.xml(relation.target), label = `幻灯片 ${index + 1}`;
    for (const [i, paragraph] of all(slide, 'p').filter(p => !hasAncestor(p, 'tbl')).entries()) reader.add(`${label}/段落 ${i + 1}`, plainText(paragraph));
    for (const [i, table] of all(slide, 'tbl').entries()) for (const [j, row] of direct(table, 'tr').entries()) reader.add(`${label}/表格 ${i + 1}/行 ${j + 1}`, direct(row, 'tc').map(plainText).join(' | '));
    reader.media(slide, relation.target, label);
    for (const note of reader.relationships(relation.target).filter(r => !r.external && /\/notesSlide$/.test(r.type))) {
      const notes = reader.xml(note.target);
      for (const [i, paragraph] of all(notes, 'p').entries()) reader.add(`${label}/备注/段落 ${i + 1}`, plainText(paragraph));
      reader.media(notes, note.target, `${label}/备注`);
    }
  }
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function excelDate(value: number, date1904: boolean, format: string, id: number): string {
  const days = Math.floor(value), fraction = value - days;
  if (!date1904 && days === 60) return '1900-02-29（Excel 日期兼容值，需核对）';
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const date = new Date(epoch + (days - (!date1904 && days > 60 ? 1 : 0)) * 86_400_000 + Math.round(fraction * 86_400_000));
  if (!Number.isFinite(date.getTime())) return String(value);
  const timeOnly = [18, 19, 20, 21, 45, 46, 47].includes(id) || (!/[yd]/i.test(format) && /[hs]/i.test(format));
  if (timeOnly) return date.toISOString().slice(11, 19);
  return date.toISOString().slice(0, 10) + (fraction ? ` ${date.toISOString().slice(11, 19)}` : '');
}
function extractExcel(reader: OfficeReader): void {
  const main = 'xl/workbook.xml', workbook = reader.xml(main), relationships = reader.relationships(main), byId = new Map(relationships.map(r => [r.id, r]));
  const date1904 = ['1', 'true'].includes(all(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '');
  const sharedPath = relationships.find(r => /\/sharedStrings$/.test(r.type) && !r.external)?.target ?? 'xl/sharedStrings.xml';
  const shared = reader.files.has(sharedPath) ? all(reader.xml(sharedPath), 'si').map(plainText) : [];
  const stylesPath = relationships.find(r => /\/styles$/.test(r.type) && !r.external)?.target ?? 'xl/styles.xml';
  const styles = reader.files.has(stylesPath) ? reader.xml(stylesPath) : null;
  const formats = new Map(styles ? all(styles, 'numFmt').map(el => [Number(el.getAttribute('numFmtId')), el.getAttribute('formatCode') ?? '']) : []);
  const xfs = styles ? direct(all(styles, 'cellXfs')[0] ?? styles.documentElement!, 'xf').map(el => Number(el.getAttribute('numFmtId'))) : [];
  for (const sheet of all(workbook, 'sheet')) {
    const relation = byId.get(attribute(sheet, 'id')), label = `工作表「${sheet.getAttribute('name') ?? '未命名'}」`;
    if (!relation || relation.external) throw new DocumentError('工作表关系缺失');
    const data = reader.xml(relation.target);
    if (['hidden', 'veryHidden'].includes(sheet.getAttribute('state') ?? '')) reader.warn(`${label}为隐藏工作表，已读取其缓存内容`);
    for (const row of all(data, 'row')) {
      const values: string[] = [], references: string[] = [];
      for (const cell of direct(row, 'c')) {
        const reference = cell.getAttribute('r') ?? '';
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(reference)) throw new DocumentError('工作表单元格地址缺失或损坏');
        const type = cell.getAttribute('t') ?? '', raw = direct(cell, 'v')[0]?.textContent ?? '', formula = direct(cell, 'f')[0];
        let value = raw;
        if (type === 's') { value = shared[Number(raw)] ?? ''; if (!/^[0-9]+$/.test(raw) || shared[Number(raw)] === undefined) reader.warn(`${label}/${reference}：共享文字缺失`); }
        else if (type === 'inlineStr') value = direct(cell, 'is').map(plainText).join('');
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') reader.warn(`${label}/${reference}：单元格为错误值 ${raw}`);
        else if (raw !== '' && ['n', ''].includes(type)) {
          const numFmtId = xfs[Number(cell.getAttribute('s') || 0)] ?? 0, format = (formats.get(numFmtId) ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
          if (Number.isFinite(Number(raw)) && (BUILTIN_DATES.has(numFmtId) || /[ydhs]/i.test(format))) value = excelDate(Number(raw), date1904, format, numFmtId);
        }
        if (formula && raw === '') { reader.warn(`${label}/${reference}：公式没有已保存的结果，未重新计算`); value = '[公式缓存结果缺失]'; }
        if (value) { references.push(reference); values.push(`${reference}=${value}${formula && raw !== '' ? '（已保存公式结果）' : ''}`); }
      }
      if (values.length) reader.add(`${label}/${references[0]}${references.length > 1 ? `:${references.at(-1)}` : ''}`, values.join(' | '));
    }
    reader.media(data, relation.target, label);
    if (all(data, 'mergeCell').length) reader.warn(`${label}包含合并单元格，内容以保存值所在单元格为准`);
  }
  if (all(workbook, 'externalReference').length) reader.warn('工作簿包含外部数据来源，仅读取已保存值，未更新外部数据');
}

export function extractOffice(bytes: Buffer, extension: 'docx' | 'xlsx' | 'pptx'): DocumentExtraction {
  const reader = new OfficeReader(bytes);
  if (!reader.files.has('[Content_Types].xml')) throw new DocumentError('文件不是有效的 Office Open XML 文档');
  reader.xml('[Content_Types].xml');
  if (extension === 'docx') extractWord(reader);
  else if (extension === 'xlsx') extractExcel(reader);
  else extractPowerPoint(reader);
  return reader.output();
}
