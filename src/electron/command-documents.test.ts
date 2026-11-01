import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commandDocumentsFromPaths } from './command-documents';
import { extractDocument, type DocumentExtraction } from '../capture/documents';
import { fixtureXlsx, fixtureZip } from '../capture/documents/fixtures';
import { readOfficeZip } from '../capture/documents/zip';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function file(name: string, bytes: string | Buffer) {
  const folder = await mkdtemp(join(tmpdir(), 'assistant-documents-')); folders.push(folder);
  const path = join(folder, name); await writeFile(path, bytes); return path;
}

describe('native assistant document import', () => {
  it('reads selected text without exposing local paths and preserves row locators', async () => {
    const path = await file('合成名单.csv', '学号,姓名,班级\nS123,合成同学,甲班');
    const extract = vi.fn(extractDocument);
    const result = await commandDocumentsFromPaths([path], extract);
    expect(result).toEqual([{ label: '合成名单.csv', text: '[第 1–2 行]\n学号,姓名,班级\nS123,合成同学,甲班' }]);
    expect(extract.mock.calls[0]![0].name).toBe('合成名单.csv');
    expect(JSON.stringify(result)).not.toContain(folders[0]);
  });

  it('reads Excel through the shared bounded document parser', async () => {
    const path = await file('合成表.xlsx', fixtureXlsx());
    const result = await commandDocumentsFromPaths([path], extractDocument);
    expect(result[0]!.text).toContain('交报告');
    expect(result[0]!.label).toBe('合成表.xlsx');
  });

  it('reads merged Excel headers and hidden sheets while retaining informational warnings', async () => {
    const files = readOfficeZip(fixtureXlsx());
    const sheet = 'xl/worksheets/sheet2.xml', workbook = 'xl/workbook.xml';
    files.set(sheet, Buffer.from(files.get(sheet)!.toString().replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="C3:D3"/></mergeCells></worksheet>')));
    files.set(workbook, Buffer.from(files.get(workbook)!.toString().replace('name="课程"', 'name="课程" state="hidden"')));
    files.set('xl/vbaProject.bin', Buffer.from('synthetic macro never executed'));
    const path = await file('合并表头.xlsx', fixtureZip(Object.fromEntries(files)));
    const [result] = await commandDocumentsFromPaths([path], extractDocument);
    expect(result!.text).toContain('交报告');
    expect(result!.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('包含合并单元格'), expect.stringContaining('为隐藏工作表，已读取其缓存内容'), '文档包含宏或活动控件；未执行',
    ]));
    const missingCache = await file('公式缺缓存.xlsx', fixtureXlsx(true));
    await expect(commandDocumentsFromPaths([missingCache], extractDocument)).rejects.toThrow('公式没有已保存的结果');
  });

  it('rejects encrypted, partially parsed, scanned and oversized files instead of silently truncating', async () => {
    const path = await file('合成.pdf', '%PDF-synthetic');
    const cases: DocumentExtraction[] = [
      { status: 'encrypted', parts: [], warnings: ['文件已加密'] },
      { status: 'needs-review', parts: [{ locator: '第1页', text: '部分内容' }], warnings: ['第2页读取失败'] },
      { status: 'ready', parts: [{ locator: '第1页', text: '', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], warnings: [] },
      { status: 'ready', parts: [{ locator: '第1页', text: 'a'.repeat(40001) }], warnings: [] },
    ];
    for (const result of cases) await expect(commandDocumentsFromPaths([path], async () => result)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(commandDocumentsFromPaths(Array(4).fill(path), extractDocument)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
