import assert from 'node:assert/strict';
import { spawn, execFile as exec } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readServerMobileArchive, serverMobileNames, verifyServerMobileArtifacts } from './package-server-mobile.mjs';

const execFile = promisify(exec), wait = ms => new Promise(done => setTimeout(done, ms));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await verifyServerMobileArtifacts(version);
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(resolve('test-results/server-mobile-')), application = join(root, 'application'), data = join(root, 'data'), backups = join(root, 'backups');
const archive = await readFile(join('release-server', serverMobileNames(version)[0]));
for (const [name, bytes] of readServerMobileArchive(archive, version).entries) {
  const path = join(application, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
}
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`, cli = join(application, 'dist-server/cli.mjs');
const env = { ...process.env }; for (const key of ['DEEPSEEK_API_KEY', 'VAPID_SUBJECT', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
let service, output = '';
async function start() {
  // IPC triggers the CLI's own graceful shutdown handler on Windows as well as Linux.
  const bootstrap = "process.on('message', value => { if(value === 'stop') { process.emit('SIGTERM'); process.disconnect(); } }); await import(process.argv[1]);";
  service = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, pathToFileURL(cli).href, 'serve', '--data-dir', data, '--backup-dir', backups, '--origin', origin, '--port', String(port), '--static-dir', join(application, 'web')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { output += bytes.toString(); });
  for (let i = 0; i < 100; i++) {
    if (service.exitCode !== null) throw Error('Bundled server exited during startup');
    try { if ((await fetch(origin + '/readyz')).ok) return; } catch {}
    await wait(100);
  }
  throw Error('Bundled server did not become ready');
}
async function stop() {
  if (!service || service.exitCode !== null) return;
  const child = service; child.send('stop');
  const code = await Promise.race([once(child, 'exit').then(([code]) => code), wait(15_000).then(() => 'timeout')]);
  if (code === 'timeout') { child.kill(); throw Error('Synthetic server failed to stop gracefully'); }
  assert.equal(code, 0); service = null;
}
async function pair(name) {
  const result = await execFile(process.execPath, [cli, 'pair', '--data-dir', data], { env, windowsHide: true });
  const code = result.stdout.trim().split(/\r?\n/).at(-1); assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const response = await fetch(origin + '/api/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
  const session = await response.json(); assert.equal(session.paired, true);
  return { session, cookie: response.headers.getSetCookie()[0].split(';')[0] };
}
async function rpc(device, method, input) {
  const response = await fetch(origin + '/api/v1/rpc/' + method, { method: 'POST', headers: { Origin: origin, Cookie: device.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': device.session.csrfToken }, body: JSON.stringify({ requestId: crypto.randomUUID(), identity: device.session.identity, input }) });
  const result = await response.json(); assert.equal(result.ok, true); return result.data;
}
try {
  await start();
  const page = await fetch(origin + '/'); assert.equal(page.status, 200); const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map(match => match[1]); assert.ok(assets.length > 0);
  for (const asset of assets) assert.equal((await fetch(new URL(asset, origin + '/'))).status, 200);
  assert.equal((await fetch(origin + '/sw.js')).status, 200);
  const manifest = await (await fetch(origin + '/manifest.webmanifest')).json(); assert.ok(manifest.name);
  const guest = await fetch(origin + '/api/v1/rpc/snapshot', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(guest.status, 401);
  const phone = await pair('Synthetic phone'), desktop = await pair('Synthetic desktop');
  const initial = await rpc(phone, 'snapshot'); assert.equal(initial.tasks.length, 0); assert.equal(initial.keyStatus.configured, false);
  const added = await rpc(phone, 'mutate', { operationId: 'synthetic-mobile-task', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: 'Synthetic shared task' } }] }); assert.equal(added.status, 'applied');
  assert.equal((await rpc(desktop, 'snapshot')).tasks[0].title, 'Synthetic shared task');
  await stop(); await start();
  assert.equal((await rpc(phone, 'snapshot')).tasks[0].title, 'Synthetic shared task');
  await stop();
  const report = { ok: true, version, archiveVerified: true, staticAssetsAndPwa: true, unauthenticatedAccessRejected: true, pairedDevicesShareData: true, restartPersistence: true, gracefulShutdown: true, realAiCalls: false, productionDeployment: false };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(output.slice(-2000)); throw error;
} finally { await stop(); }
