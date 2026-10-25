import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { WebSocket } from 'ws';

const execFile = promisify(execFileCallback), wait = ms => new Promise(done => setTimeout(done, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(resolve('test-results/remote-smoke-')), data = join(root, 'server'), profile = join(root, 'desktop');
const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'PLANNER_DEV_URL', 'DEEPSEEK_API_KEY', 'VAPID_SUBJECT']) delete env[key];
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(done => server.close(done)); return value; }
const origin = `http://127.0.0.1:${await port()}`;
// These are deliberately invalid provider credentials; this smoke only exercises configuration, never AI calls.
const nativeAiKey = `synthetic-smoke-native-key-${crypto.randomUUID()}`, browserAiKey = `synthetic-smoke-browser-key-${crypto.randomUUID()}`;
const syntheticAiKeys = [nativeAiKey, browserAiKey];
function withoutAiKeys(value, message) { const text = JSON.stringify(value); assert(syntheticAiKeys.every(key => !text.includes(key)), message); }
async function assertPrivateProfileHasNoAiKey(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertPrivateProfileHasNoAiKey(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      assert(syntheticAiKeys.every(key => !bytes.includes(Buffer.from(key)) && !bytes.includes(Buffer.from(key, 'utf16le'))), 'Cloud API Key leaked into native profile');
    }
  }
}
let service, desktop, socket, serial = 0; const pending = new Map();
async function pairingCode() { const result = await execFile(process.execPath, ['dist-server/cli.mjs', 'pair', '--data-dir', data], { env, windowsHide: true }); const code = result.stdout.trim().split(/\r?\n/).at(-1); assert(/^[A-Za-z0-9_-]{43}$/.test(code), 'Pair code unavailable'); return code; }
async function cdp(expression) {
  const id = ++serial;
  const result = new Promise((done, reject) => { const timeout = setTimeout(() => { pending.delete(id); reject(Error('Remote smoke CDP timeout')); }, 20_000); pending.set(id, value => { clearTimeout(timeout); value.error || value.result?.exceptionDetails ? reject(Error('Remote smoke renderer call failed')) : done(value.result.result.value); }); });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); return result;
}
try {
  service = spawn(process.execPath, ['dist-server/cli.mjs', 'serve', '--data-dir', data, '--origin', origin, '--port', new URL(origin).port], { env, windowsHide: true, stdio: 'ignore' });
  let live = false;
  for (let i = 0; i < 100; i++) { try { live = (await fetch(origin + '/api/v1/session')).ok; } catch {} if (live) break; if (service.exitCode !== null) throw Error('Remote service exited'); await wait(100); }
  assert(live, 'Remote service did not start');
  const pair = await fetch(origin + '/api/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: await pairingCode(), name: '合成网页设备' }) });
  const browserSession = await pair.json(), cookie = pair.headers.getSetCookie()[0].split(';')[0]; assert(browserSession.paired, 'Browser pairing failed');
  const rpc = async (method, input) => (await fetch(origin + '/api/v1/rpc/' + method, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': browserSession.csrfToken }, body: JSON.stringify({ requestId: crypto.randomUUID(), identity: browserSession.identity, input }) })).json();
  const browserAiConfiguration = async (method = 'GET', input) => {
    const response = await fetch(origin + '/api/v1/ai/config', { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': browserSession.csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json();
    assert(response.ok && value.ok, 'Browser AI configuration request failed');
    withoutAiKeys(value, 'Browser AI configuration response returned a Key');
    return value.configuration;
  };
  const codeFile = join(root, 'native-pair-code'), configFile = join(root, 'native-config.json');
  await writeFile(codeFile, await pairingCode(), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ origin, deviceName: '合成 Windows 设备', pairingCodeFile: codeFile }));
  const debugPort = await port();
  desktop = spawn(electron, ['.', `--planner-profile=${profile}`, `--planner-remote-config=${configFile}`, `--remote-debugging-port=${debugPort}`], { env, windowsHide: true, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 200; i++) { if (desktop.exitCode !== null) throw Error('Remote desktop exited during startup'); try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(value => value.type === 'page' && value.url.startsWith('file:')); } catch {} if (target) break; await wait(100); }
  assert(target, 'Bundled desktop renderer did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  socket.on('message', bytes => { const value = JSON.parse(bytes.toString()); if (value.id) { const callback = pending.get(value.id); pending.delete(value.id); callback?.(value); } });
  let ready = false;
  for (let i = 0; i < 100; i++) { ready = await cdp('!!window.planner'); if (ready) break; await wait(100); }
  assert(ready, 'Remote preload unavailable');
  const initial = await cdp('window.planner.snapshot()'); assert(initial.ok && initial.data.tasks.length === 0, 'Native remote did not read fresh server');
  assert(initial.data.keyStatus.scope === 'cloud', 'Native snapshot did not identify cloud Key scope');
  const added = await cdp(`window.planner.mutate(${JSON.stringify({ operationId: 'native-create', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: '合成云端往返任务' } }] })})`);
  assert(added.ok && added.data.status === 'applied', 'Native remote create failed');
  const fromBrowser = await rpc('snapshot'); const task = fromBrowser.data.tasks[0]; assert(task?.title === '合成云端往返任务', 'Browser missed native write');
  const changed = await rpc('mutate', { operationId: 'browser-update', origin: 'manual', mutations: [{ type: 'update', entity: 'task', id: task.id, expectedVersion: task.version, values: { title: '网页修改后电脑可见' } }] });
  assert(changed.ok && changed.data.status === 'applied', 'Browser update failed');
  const fromDesktop = await cdp('window.planner.snapshot()'); assert(fromDesktop.ok && fromDesktop.data.tasks[0].title === '网页修改后电脑可见', 'Native missed browser update');
  assert(!(await cdp('window.planner.captureSnapshot()')).ok, 'Cloud mode unexpectedly enabled local capture');
  assert(!(await readdir(profile)).includes('planner.sqlite'), 'Cloud mode created a second formal database');
  const credential = await readFile(join(profile, 'credentials', 'remote-device.bin')); assert(!credential.includes(Buffer.from('planner_dev_session')), 'Native credential was stored unencrypted');
  const ledger = await cdp('window.planner.ledgerSnapshot({month:"2030-01"})'); assert(ledger.ok && Number.isInteger(ledger.data.revision), 'Native ledger roundtrip failed');
  const journalBeforeAiConfiguration = await readFile(join(profile, 'remote-write.json'));
  const firstConfiguration = await cdp('window.planner.retryApiKey()');
  assert(firstConfiguration.ok && firstConfiguration.data.scope === 'cloud' && firstConfiguration.data.cloudConfiguration?.revision === null, 'Native Key status did not read fresh cloud configuration');
  withoutAiKeys(firstConfiguration, 'Native Key status returned a Key');
  const nativeSaved = await cdp(`window.planner.setApiKey(${JSON.stringify({ key: nativeAiKey, expectedRevision: firstConfiguration.data.cloudConfiguration.revision })})`);
  assert(nativeSaved.ok && nativeSaved.data.scope === 'cloud' && nativeSaved.data.cloudConfiguration?.configured === true, 'Native could not save cloud Key through preload');
  withoutAiKeys(nativeSaved, 'Native Key save response returned a Key');
  const browserRead = await browserAiConfiguration();
  assert(browserRead.configured && typeof browserRead.revision === 'string' && browserRead.revision === nativeSaved.data.cloudConfiguration.revision, 'Browser missed native cloud Key update');
  const browserSaved = await browserAiConfiguration('PUT', { identity: browserSession.identity, expectedRevision: browserRead.revision, apiKey: browserAiKey });
  assert(browserSaved.configured && browserSaved.revision !== browserRead.revision, 'Browser cloud Key update did not advance revision');
  const nativeReread = await cdp('window.planner.retryApiKey()');
  assert(nativeReread.ok && nativeReread.data.scope === 'cloud' && nativeReread.data.cloudConfiguration?.revision === browserSaved.revision, 'Native retry missed browser cloud Key update');
  withoutAiKeys(nativeReread, 'Native Key refresh returned a Key');
  const staleNativeSave = await cdp(`window.planner.setApiKey(${JSON.stringify({ key: nativeAiKey, expectedRevision: browserRead.revision })})`);
  assert(!staleNativeSave.ok && staleNativeSave.error?.code === 'CONFLICT', 'Native stale revision was not rejected');
  withoutAiKeys(staleNativeSave, 'Native Key conflict returned a Key');
  const browserAfterConflict = await browserAiConfiguration();
  assert(browserAfterConflict.configured && browserAfterConflict.revision === browserSaved.revision, 'Native stale revision overwrote browser cloud Key');
  const nativeCleared = await cdp(`window.planner.setApiKey(${JSON.stringify({ key: null, expectedRevision: nativeReread.data.cloudConfiguration.revision })})`);
  assert(nativeCleared.ok && nativeCleared.data.scope === 'cloud' && nativeCleared.data.cloudConfiguration?.configured === false, 'Native could not clear cloud Key through preload');
  withoutAiKeys(nativeCleared, 'Native Key clear response returned a Key');
  const browserAfterClear = await browserAiConfiguration();
  assert(!browserAfterClear.configured && browserAfterClear.revision === nativeCleared.data.cloudConfiguration.revision && browserAfterClear.revision !== browserSaved.revision, 'Browser missed native cloud Key clear');
  assert(journalBeforeAiConfiguration.equals(await readFile(join(profile, 'remote-write.json'))), 'Cloud Key configuration changed ordinary write journal');
  assert(!(await readdir(join(profile, 'credentials'))).includes('deepseek.bin'), 'Cloud Key configuration created a local provider credential');
  await cdp('setTimeout(() => window.close(), 10); true'); await Promise.race([once(desktop, 'exit'), wait(5000)]); assert(desktop.exitCode === 0, 'Remote desktop did not exit normally');
  await assertPrivateProfileHasNoAiKey(profile);
  console.log('PASS: compiled server + real Electron preload/native remote + browser share one synthetic database and cloud Key configuration; stale Key revision rejected; no Key in native profile/journal; credentials encrypted; no QQ/local formal database opened.');
  await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, checks: ['compiled-server', 'native-pair', 'bidirectional-task', 'remote-ledger', 'cloud-key-snapshot', 'native-cloud-key-save', 'browser-cloud-key-update', 'native-cloud-key-retry', 'stale-cloud-key-rejected', 'native-cloud-key-clear', 'no-cloud-key-in-native-profile', 'cloud-key-bypasses-write-journal', 'capture-disabled', 'no-local-database', 'encrypted-credential', 'normal-desktop-exit'] }, null, 2));
} finally {
  socket?.close();
  for (const child of [desktop, service]) if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), wait(5000)]); }
}
