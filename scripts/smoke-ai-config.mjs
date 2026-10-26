import { spawn, execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback), wait = ms => new Promise(done => setTimeout(done, ms));
const assert = value => { if (!value) throw Error('AI configuration smoke assertion failed'); };
const args = process.argv.slice(2);
let root, child, childExit, captured = '', failed = false;
const secrets = ['synthetic-managed-ai-key-aaaaaaaa', 'synthetic-external-ai-key-bbbbbbbb'];
const env = { ...process.env };
for (const key of ['DEEPSEEK_API_KEY', 'VAPID_SUBJECT', 'ELECTRON_RUN_AS_NODE']) delete env[key];

async function stop() {
  if (!child) return;
  const running = child;
  if (!running.pid) { await childExit; child = undefined; return; }
  async function waitForExit(milliseconds) {
    let timer;
    try { await Promise.race([childExit, new Promise(done => { timer = setTimeout(done, milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  if (running.exitCode === null && running.signalCode === null) running.kill('SIGTERM');
  await waitForExit(5000);
  if (running.exitCode === null && running.signalCode === null) {
    running.kill('SIGKILL'); await waitForExit(3000);
  }
  assert(running.exitCode !== null || running.signalCode !== null);
  child = undefined;
}

try {
  assert(args.length === 0 || args.length === 2 && args[0] === '--cli' && isAbsolute(args[1]));
  const cli = args.length ? args[1] : resolve('dist-server/cli.mjs');
  assert((await stat(cli)).isFile());
  root = await mkdtemp(join(tmpdir(), 'planner-ai-config-smoke-'));
  const data = join(root, 'data'), backups = join(root, 'backups'), credential = join(data, 'ai-credentials.json');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const origin = `http://127.0.0.1:${port}`, endpoint = `${origin}/api/v1/ai/config`;
  const serveArgs = [cli, 'serve', '--data-dir', data, '--backup-dir', backups, '--origin', origin, '--port', String(port), '--host', '127.0.0.1'];
  async function start(extraEnv = {}) {
    await stop();
    let startFailed = false;
    child = spawn(process.execPath, serveArgs, { env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = new Promise(done => { child.once('exit', done); child.once('error', () => { startFailed = true; done(); }); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { captured += value.toString(); if (captured.length > 1_000_000) { startFailed = true; child?.kill(); } });
    for (let attempt = 0; attempt < 100; attempt++) {
      assert(!startFailed && child.exitCode === null && child.signalCode === null);
      try { if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Await local startup only. */ }
      await wait(100);
    }
    assert(false);
  }
  await start();
  const pairing = await execFile(process.execPath, [cli, 'pair', '--data-dir', data], { env, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
  const code = pairing.stdout.trim().split(/\r?\n/).at(-1);
  assert(/^[A-Za-z0-9_-]{43}$/.test(code));
  const paired = await fetch(`${origin}/api/v1/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: 'Synthetic AI configuration smoke' }), signal: AbortSignal.timeout(3000) });
  assert(paired.status === 200);
  const session = await paired.json(), cookie = paired.headers.getSetCookie()[0]?.split(';')[0];
  assert(session.paired && cookie && session.csrfToken && !session.aiConfigured);
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
  async function call(method = 'GET', body, expected = 200, extraHeaders = {}) {
    const response = await fetch(endpoint, { method, headers: { ...headers, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    assert(response.status === expected && !secrets.some(key => text.includes(key)));
    assert(response.headers.get('cache-control') === 'no-store');
    return JSON.parse(text);
  }
  const initial = await call();
  assert(initial.configuration.editable && !initial.configuration.configured && initial.configuration.revision === null);
  const update = { identity: session.identity, expectedRevision: null, apiKey: secrets[0] };
  await call('PUT', update, 403, { 'X-CSRF-Token': '' });
  const saved = await call('PUT', update);
  assert(saved.configuration.source === 'managed' && saved.configuration.configured && saved.configuration.revision);
  const savedBytes = await readFile(credential);
  assert(JSON.parse(savedBytes).apiKey === secrets[0]);
  await call('PUT', update, 409);
  await start();
  assert(JSON.stringify(await call()) === JSON.stringify(saved));
  const reconnected = await fetch(`${origin}/api/v1/session`, { headers, signal: AbortSignal.timeout(3000) });
  assert((await reconnected.json()).aiConfigured === true);
  await start({ DEEPSEEK_API_KEY: secrets[1] });
  const external = await call();
  assert(external.configuration.configured && !external.configuration.editable && external.configuration.source === 'external');
  await call('PUT', update, 403);
  await call('DELETE', { identity: session.identity, expectedRevision: null }, 403);
  assert((await readFile(credential)).equals(savedBytes));
  await start();
  assert(JSON.stringify(await call()) === JSON.stringify(saved));
  if (process.platform !== 'win32') {
    assert(((await stat(credential)).mode & 0o777) === 0o600);
    await chmod(credential, 0o644);
    try { await call('GET', undefined, 503); }
    finally { await chmod(credential, 0o600); }
    assert(JSON.stringify(await call()) === JSON.stringify(saved));
  }
  const cleared = await call('DELETE', { identity: session.identity, expectedRevision: saved.configuration.revision });
  assert(!cleared.configuration.configured && cleared.configuration.revision !== saved.configuration.revision);
  await start();
  assert(JSON.stringify(await call()) === JSON.stringify(cleared));
  await call('PUT', update, 409);
  await stop();
  assert(!secrets.some(key => captured.includes(key)));
} catch { failed = true; }
finally {
  try { await stop(); } catch { failed = true; }
  if (root && !child) {
    try {
      const absolute = resolve(root);
      assert(dirname(absolute) === resolve(tmpdir()) && basename(absolute).startsWith('planner-ai-config-smoke-'));
      await rm(absolute, { recursive: true, force: true });
    } catch { failed = true; }
  }
}
process.stdout.write(failed ? 'FAIL: isolated AI configuration CLI smoke failed.\n' : 'PASS: isolated CLI credentials persist, protect changes, respect external configuration, and clear safely.\n');
process.exitCode = failed ? 1 : 0;
