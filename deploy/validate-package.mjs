import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const archive = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !archive.endsWith('.tar.gz')) throw Error('Provide a generated backend archive');
const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true });
if (list.status !== 0) throw Error('Cannot inspect archive');
const names = list.stdout.trim().split(/\r?\n/), release = names[0].split('/')[0];
if (!/^backend-[0-9A-Za-z._-]+$/.test(release) || names.some(path => !path.startsWith(`${release}/`) || path.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(path))) throw Error('Unsafe archive paths');
const types = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', windowsHide: true });
if (types.status !== 0 || types.stdout.trim().split(/\r?\n/).some(line => !['-', 'd'].includes(line[0]))) throw Error('Archive special entries forbidden');
const root = mkdtempSync(join(tmpdir(), 'backend-package-check-')); let child;
try {
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', root], { encoding: 'utf8', windowsHide: true }); if (extraction.status !== 0) throw Error('Extraction failed');
  const payload = join(root, release);
  const verify = spawnSync(process.execPath, [join(payload, 'deploy', 'verify-release.mjs'), payload], { encoding: 'utf8', cwd: payload, windowsHide: true });
  if (verify.status !== 0) throw Error(`Manifest validation failed: ${verify.stderr}`);
  const portServer = createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done)); const port = portServer.address().port; await new Promise(done => portServer.close(done));
  const preload = join(root, 'stop-test.cjs'); writeFileSync(preload, "process.on('message',value=>{if(value==='stop-test'){process.disconnect();process.emit('SIGTERM');}});\n");
  const data = join(root, 'synthetic-data'); let output = '';
  child = spawn(process.execPath, ['--require', preload, join(payload, 'dist-server', 'cli.mjs'), 'serve', '--data-dir', data, '--backup-dir', join(root, 'synthetic-backups'), '--origin', `http://localhost:${port}`, '--port', String(port)], {
    cwd: payload, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DEEPSEEK_API_KEY: '', VAPID_SUBJECT: '' },
  });
  child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', () => {});
  let exited = false; const exit = new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => { exited = true; done(code); }); });
  const probe = path => new Promise((done, reject) => { const req = request({ host: '127.0.0.1', port, path, headers: { Host: `localhost:${port}` } }, res => { const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); }); req.on('error', reject); req.setTimeout(1500, () => req.destroy()); req.end(); });
  let ready = false;
  for (let attempt = 0; attempt < 80 && !exited; attempt++) {
    try { const res = await probe('/readyz'); if (res.status === 200 && JSON.parse(res.text).ready) { ready = true; break; } } catch { /* startup not yet listening */ }
    await new Promise(done => setTimeout(done, 100));
  }
  if (!ready || (await probe('/')).status !== 404 || JSON.parse((await probe('/api/v1/session')).text).paired !== false) throw Error('Isolated backend-only/unconfigured-key smoke failed');
  const health = spawnSync(process.execPath, [join(payload, 'deploy', 'check-health.mjs'), '--url', `http://127.0.0.1:${port}/readyz`, '--host', `localhost:${port}`], { encoding: 'utf8', windowsHide: true });
  if (health.status !== 0) throw Error('Packaged health probe failed');
  child.send('stop-test'); let timeout;
  const code = await Promise.race([exit, new Promise((_done, reject) => { timeout = setTimeout(() => reject(Error('CLI shutdown deadline')), 10_000); })]); clearTimeout(timeout);
  if (code !== 0 || !output.includes('STOPPED') || existsSync(join(data, '.remote-service.lock'))) throw Error('Packaged CLI shutdown event did not release its lock');
  process.stdout.write(`${JSON.stringify({ release, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), verified: true, standaloneWithoutNodeModules: true, noFrontendRoot: true, noKeyStartup: true, healthProbe: true, signalHandlerPath: true, payloadFiles: readdirSync(payload).sort() }, null, 2)}\n`);
} finally {
  if (child && child.exitCode === null && !child.killed) { child.kill(); await new Promise(done => child.once('exit', done)); }
  const actual = realpathSync(root), parent = realpathSync(tmpdir());
  if (dirname(actual) !== parent || !basename(actual).startsWith('backend-package-check-')) throw Error('Refuse unsafe temporary cleanup');
  rmSync(actual, { recursive: true, force: true });
}
