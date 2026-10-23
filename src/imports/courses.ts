import { readSheet } from 'read-excel-file/node';
import { CourseInputSchema, CourseImportResultSchema, type CourseImportResult, type Settings } from '../shared/contracts';
import { WorkflowError } from '../ai/deepseek';

export const COURSE_HEADERS = ['课程', '星期', '开始', '结束', '起始周', '结束周', '单双周', '地点'] as const;
export const COURSE_CSV_TEMPLATE = '\uFEFF' + COURSE_HEADERS.join(',') + '\r\n高等数学,1,08:00,09:30,1,16,全,A101\r\n';
export type SelectedCourseFile = { name: string; bytes: Uint8Array };
export function parseCsv(text: string): string[][] {
  if (text.length > 1_000_000) throw new WorkflowError('VALIDATION', 'CSV 文件过大');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  const value = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) { if (c === '"' && value[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') { quoted = false; closed = true; } else cell += c; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && value[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; closed = false; }
    else { if (closed) throw new WorkflowError('VALIDATION', `CSV 第 ${rows.length + 1} 行引号格式错误`); cell += c; }
  }
  if (quoted) throw new WorkflowError('VALIDATION', `CSV 第 ${rows.length + 1} 行引号未闭合`);
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}
export function previewCourseRows(rows: string[][], settings: Settings, uncertainties: string[] = [], hasHeader = true): CourseImportResult {
  if (hasHeader && JSON.stringify(rows[0]?.map(s => s.trim())) !== JSON.stringify(COURSE_HEADERS)) throw new WorkflowError('VALIDATION', `表头必须依次为：${COURSE_HEADERS.join(',')}`);
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length > 500) throw new WorkflowError('VALIDATION', '一次最多导入 500 行课程');
  const courses: CourseImportResult['courses'] = []; const drafts: CourseImportResult['drafts'] = [];
  data.forEach((raw, index) => {
    if (raw.every(s => !s.trim())) return;
    const cells = raw.map(s => s.trim()); const row = index + (hasHeader ? 2 : 1); const errors: string[] = [];
    if (cells.length !== 8) errors.push(`第 ${row} 行必须有 8 列`);
    if (cells.some(s => s.length > 2000)) errors.push(`第 ${row} 行内容过长`);
    if (cells.some(s => /^[=+@]/.test(s))) errors.push(`第 ${row} 行包含公式，请改为文字或数值`);
    if (!settings.termStart) errors.push(`第 ${row} 行：请先设置学期起始星期一`);
    const parity = cells[6] === '全' ? 'all' : cells[6] === '单' ? 'odd' : cells[6] === '双' ? 'even' : cells[6];
    const integer = (s: string | undefined) => s && /^\d+$/.test(s) ? Number(s) : NaN;
    const parsed = CourseInputSchema.safeParse({ title: cells[0], weekday: integer(cells[1]), startTime: cells[2], endTime: cells[3], firstWeek: integer(cells[4]), lastWeek: integer(cells[5]), parity, location: cells[7], termStart: settings.termStart });
    if (!parsed.success) for (const issue of parsed.error.issues) { const msg = `第 ${row} 行 ${issue.path.join('.') || '课程'}：${issue.message}`; if (errors.length < 20) errors.push(msg.slice(0, 2000)); }
    if (cells.slice(2, 4).some(s => s && !/^\d{2}:\d{2}$/.test(s))) errors.push(`第 ${row} 行：需明确 HH:mm；仅有节次时请提供节次时间表并校对`);
    drafts.push({ row, cells: cells.slice(0, 8).map(s => s.slice(0, 2000)), errors: errors.slice(0, 20) });
    if (!errors.length && parsed.success) courses.push(parsed.data);
  });
  return CourseImportResultSchema.parse({ courses, drafts, uncertainties, message: drafts.some(r => r.errors.length) ? '请修正标出的行；所有课程需核对并确认后保存' : '课表预览已生成，请校对并确认后保存' });
}
export async function parseCourseFile(file: SelectedCourseFile, settings: Settings): Promise<CourseImportResult> {
  if (file.bytes.byteLength > 10 * 1024 * 1024) throw new WorkflowError('VALIDATION', '课表文件不得超过 10 MB');
  if (/\.csv$/i.test(file.name)) return previewCourseRows(parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)), settings);
  if (!/\.xlsx$/i.test(file.name)) throw new WorkflowError('VALIDATION', '仅支持 CSV/XLSX 课表');
  try {
    // read-excel-file only reads cell values/cached formula results; no formula evaluator or macro execution.
    const rows = await readSheet(Buffer.from(file.bytes));
    return previewCourseRows(rows.map(row => row.map(cell => cell === null ? '' : String(cell))), settings);
  } catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError('VALIDATION', 'XLSX 无法读取，请按模板重新导出'); }
}
