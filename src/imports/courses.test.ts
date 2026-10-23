import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCourseFile, parseCsv, previewCourseRows, COURSE_CSV_TEMPLATE } from './courses';
import { SettingsSchema } from '../shared/contracts';
const settings = SettingsSchema.parse({ termStart: '2026-09-07' });
describe('reviewable course files', () => {
  it('reads the documented template and parity with literal teaching weeks', () => {
    const result = previewCourseRows(parseCsv(COURSE_CSV_TEMPLATE), settings);
    expect(result.courses).toMatchObject([{ title: '高等数学', weekday: 1, firstWeek: 1, lastWeek: 16, parity: 'all', startTime: '08:00', termStart: '2026-09-07' }]); expect(result.drafts[0]?.errors).toEqual([]);
  });
  it('keeps invalid/missing rows editable with row numbers instead of discarding or guessing', () => {
    const result = previewCourseRows(parseCsv('课程,星期,开始,结束,起始周,结束周,单双周,地点\n"数学,实验",1,第1节,,1,,单,A101\n英语,8,08:00,09:30,2,1,全,B201'), SettingsSchema.parse({}));
    expect(result.courses).toEqual([]); expect(result.drafts.map(d => d.cells[0])).toEqual(['数学,实验', '英语']); expect(result.drafts[0]?.row).toBe(2); expect(result.drafts[0]?.errors.join(' ')).toContain('学期起始星期一'); expect(result.drafts[1]?.errors.join(' ')).toContain('第 3 行');
  });
  it('rejects guessed headers, unclosed quotes and formula cells without evaluating them', () => {
    expect(() => previewCourseRows(parseCsv('课程名,周几,开始\n数学,1,08:00'), settings)).toThrow('表头'); expect(() => parseCsv('"课程,星期')).toThrow('引号未闭合');
    expect(previewCourseRows([['=HYPERLINK("file:///secret")', '1', '08:00', '09:00', '1', '2', '全', '']], settings, [], false)).toMatchObject({ courses: [], drafts: [{ errors: [expect.stringContaining('公式')] }] });
  });
  it('reads actual synthetic XLSX bytes through read-excel-file and keeps strict header order', async () => {
    const bytes = readFileSync('tests/fixtures/synthetic-courses.xlsx');
    const result = await parseCourseFile({ name: 'synthetic.xlsx', bytes }, settings);
    expect(result.courses).toMatchObject([{ title: '合成数学', parity: 'odd', weekday: 1, startTime: '08:00', endTime: '09:30', firstWeek: 1, lastWeek: 16 }]);
    expect(result.drafts).toHaveLength(1); expect(result.drafts[0]?.errors).toEqual([]);
  });
});
