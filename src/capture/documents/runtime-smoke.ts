import { app } from 'electron';
import { mkdir, mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDocumentExtractor } from './runtime';
import { fixturePdf, fixtureDocx, fixtureXlsx, fixturePptx, PIXEL_PNG } from './fixtures';

const reportPath = resolve(process.argv.find(arg => arg.startsWith('--report-path='))?.slice('--report-path='.length) ?? 'test-results/document-smoke-result.json');
const debugPath = join(dirname(reportPath), 'document-smoke-debug.log');

async function main() {
  await mkdir(dirname(reportPath), { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'ultimate-calendar-document-smoke-'));
  app.setName('UltimateCalendarDocumentSmoke'); app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  const diagnostics: string[] = [];
  app.on('web-contents-created', (_event, contents) => { contents.on('console-message', details => { diagnostics.push(details.message); void appendFile(debugPath, details.message + '\n'); }); contents.on('preload-error', (_event, _path, error) => { diagnostics.push(error.message); void appendFile(debugPath, error.message + '\n'); }); });
  await app.whenReady();
  const runtimeDirectory = resolve(process.argv.find(arg => arg.startsWith('--runtime-directory='))?.slice('--runtime-directory='.length) ?? 'dist-electron');
  const extractor = createDocumentExtractor({ runtimeDirectory });
  const reports = [];
  try {
    for (const [name, bytes] of [
      ['text.pdf', fixturePdf('text')], ['scan.pdf', fixturePdf('scan')], ['mixed.pdf', fixturePdf('mixed')],
      ['notice.docx', fixtureDocx()], ['notice.xlsx', fixtureXlsx()], ['notice.pptx', fixturePptx()],
    ] as const) {
      const result = await extractor.extract({ name, bytes });
      reports.push({ name, status: result.status, textParts: result.parts.filter(part => part.text).length, imageParts: result.parts.filter(part => part.imageDataUrl).length, warnings: result.warnings });
      await writeFile(reportPath, JSON.stringify({ reports, diagnostics }, null, 2));
    }
    const oversized = Buffer.from(PIXEL_PNG); oversized.writeUInt32BE(100000, 16);
    for (const [name, bytes] of [
      ['notice.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
      ['notice.webp', await readFile(resolve('src/capture/documents/fixtures/notice.webp'))],
      ['oversized.png', oversized],
    ] as const) {
      const result = await extractor.extract({ name, bytes });
      if (result.parts.some(part => part.imageDataUrl && !/^data:image\/(png|jpeg);base64,/.test(part.imageDataUrl))) throw new Error('Unsupported output image');
      reports.push({ name, status: result.status, textParts: result.parts.filter(part => part.text).length, imageParts: result.parts.filter(part => part.imageDataUrl).length, warnings: result.warnings });
    }
    const fixtureDirectory = process.argv.find(arg => arg.startsWith('--legacy-fixtures='))?.slice('--legacy-fixtures='.length);
    if (fixtureDirectory) for (const extension of ['doc', 'xls', 'ppt']) {
      const name = `notice.${extension}`, result = await extractor.extract({ name, bytes: await readFile(join(fixtureDirectory, name)) });
      reports.push({ name, status: result.status, textParts: result.parts.filter(part => part.text).length, imageParts: result.parts.filter(part => part.imageDataUrl).length, warnings: result.warnings });
    }
    if (fixtureDirectory) for (const name of ['encrypted.doc', 'encrypted.pdf']) {
      const result = await extractor.extract({ name, bytes: await readFile(join(fixtureDirectory, name)) });
      reports.push({ name, status: result.status, textParts: result.parts.filter(part => part.text).length, imageParts: result.parts.filter(part => part.imageDataUrl).length, warnings: result.warnings });
    }
    await writeFile(reportPath, JSON.stringify({ reports, diagnostics }, null, 2));
  } finally { extractor.dispose(); app.quit(); }
}
void main().catch(async () => {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ failed: true }));
  app.exit(1);
});
