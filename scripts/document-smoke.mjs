import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Run after npm run build. All inputs are committed/generated synthetic fixtures; no QQ, AI or API key is used.
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['src/capture/documents/runtime-smoke.ts'], outfile: 'test-results/document-smoke.cjs', platform: 'node', format: 'cjs', target: 'node24', bundle: true, external: ['electron'] });
const reportPath = resolve('test-results/document-smoke-result.json');
await rm(reportPath, { force: true });
const args = [resolve('test-results/document-smoke.cjs'), `--report-path=${reportPath}`];
const runtimeArgument = process.argv.find(arg => arg.startsWith('--runtime-directory='));
if (runtimeArgument) args.push(runtimeArgument);
if (!process.argv.includes('--no-legacy')) args.push(`--legacy-fixtures=${resolve('src/capture/documents/fixtures')}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PLANNER_DEV_URL;
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const timer = setTimeout(() => child.kill(), 300_000);
const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode); });
clearTimeout(timer);
assert.equal(code, 0, 'Document smoke process did not finish successfully');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.ok(Array.isArray(report.reports), 'Document smoke did not return a report');
const byName = new Map(report.reports.map(item => [item.name, item]));
for (const name of ['text.pdf', 'scan.pdf', 'mixed.pdf', 'notice.docx', 'notice.xlsx', 'notice.pptx']) assert.equal(byName.get(name)?.status, 'ready', `${name}: ${JSON.stringify(byName.get(name))}`);
assert.equal(byName.get('text.pdf').textParts, 1);
assert.equal(byName.get('scan.pdf').imageParts, 1);
assert.equal(byName.get('mixed.pdf').imageParts, 1);
assert.equal(byName.get('notice.docx').imageParts, 1);
assert.equal(byName.get('notice.webp')?.status, 'ready');
assert.equal(byName.get('notice.webp')?.imageParts, 1);
assert.equal(byName.get('notice.gif')?.imageParts, 1);
assert.equal(byName.get('oversized.png')?.status, 'needs-review');
assert.equal(byName.get('oversized.png')?.imageParts, 0);
if (!process.argv.includes('--no-legacy')) {
  for (const name of ['notice.doc', 'notice.xls', 'notice.ppt']) assert.equal(byName.get(name)?.status, 'ready', `${name}: ${JSON.stringify(byName.get(name))}`);
  for (const name of ['encrypted.doc', 'encrypted.pdf']) assert.equal(byName.get(name)?.status, 'encrypted', `${name}: encryption was not detected`);
}
assert.deepEqual(report.diagnostics, [], 'Document renderer reported errors');
await writeFile('test-results/qq-document-runtime-report.json', JSON.stringify({ testedAt: new Date().toISOString(), environment: `Electron runtime, ${runtimeArgument ?? 'current dist-electron bundles'}; synthetic local documents only, no QQ or AI requests`, ...report }, null, 2) + '\n');
console.log(`Document runtime smoke passed: ${report.reports.length} synthetic documents.`);
