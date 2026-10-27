import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';
import { WebSocket } from 'ws';

// Real Edge and an isolated profile, with synthetic records and a loopback-only service.
const [argument] = process.argv.slice(2);
if (!argument) throw Error('Usage: node scripts/smoke-mobile-scheduling.mjs <static-directory>');
const root = resolve(argument);
await readFile(join(root, 'index.html'));
const checks = [], requests = [], mutations = [], runtimeErrors = [], externalRequests = [];
const receipts = new Map(), events = new Set();
const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), at = `${date}T08:00:00+08:00`;
const taskId = 'synthetic-task', blockId = 'synthetic-block', title = '合成任务：准备课堂汇报';
const session = { paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 }, device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic scheduling phone' }, csrfToken: 'synthetic-csrf', aiConfigured: false };
let snapshot = { schemaVersion: 1, sources: [], candidates: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false },
  tasks: [{ id: taskId, version: 1, createdAt: at, updatedAt: at, title, scheduleMode: 'single', status: 'open' }],
  blocks: [{ id: blockId, version: 1, createdAt: at, updatedAt: at, title, taskId, kind: 'work', start: `${date}T15:10:00+08:00`, end: `${date}T15:55:00+08:00`, completed: false }],
};
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const failure = message => ({ ok: false, error: { code: 'VALIDATION', message, retryable: false } });
const assert = (condition, message) => { if (!condition) throw Error(message); };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push({ path, method: req.method });
  try {
    if (path === '/api/v1/session' || path === '/api/v1/session/renew') return json(res, session);
    if (path === '/api/v1/rpc/snapshot') return json(res, { ok: true, data: snapshot });
    if (path === '/api/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': synthetic\n\n'); events.add(res); res.once('close', () => events.delete(res)); return;
    }
    if (path.startsWith('/api/v1/operations/')) {
      const requestId = decodeURIComponent(path.slice('/api/v1/operations/'.length));
      return json(res, receipts.has(requestId) ? { status: 'completed', requestId, method: 'mutate', result: receipts.get(requestId) } : { status: 'unknown' });
    }
    if (path === '/api/v1/rpc/mutate') {
      let body = ''; for await (const chunk of req) body += chunk;
      const envelope = JSON.parse(body);
      mutations.push({ requestId: envelope.requestId, input: envelope.input });
      if (receipts.has(envelope.requestId)) return json(res, receipts.get(envelope.requestId));
      const next = structuredClone(snapshot), changes = [];
      for (const change of envelope.input.mutations) {
        assert(change.type === 'update' && ['task', 'block'].includes(change.entity), 'Unexpected synthetic mutation');
        const records = change.entity === 'task' ? next.tasks : next.blocks;
        const record = records.find(value => value.id === change.id);
        assert(record && record.version === change.expectedVersion, 'Synthetic version mismatch');
        changes.push({ entity: change.entity, id: record.id, action: 'update', beforeVersion: record.version, afterVersion: record.version + 1, title: record.title });
        Object.assign(record, change.values, { version: record.version + 1, updatedAt: new Date().toISOString() });
      }
      snapshot = next;
      const result = { ok: true, data: { status: 'applied', message: '合成安排已保存', transactionId: 'synthetic-transaction', changes, conflicts: [] } };
      receipts.set(envelope.requestId, result);
      return json(res, result);
    }
    if (path.startsWith('/api/')) return json(res, failure('Unexpected synthetic API request'), 400);
    const file = resolve(root, path === '/' ? 'index.html' : path.slice(1)), part = relative(root, file);
    assert(!part.startsWith('..') && !isAbsolute(part), 'Unsafe static path');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  } catch (error) { return json(res, failure(String(error)), 400); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir('test-results', { recursive: true });
const output = await mkdtemp(resolve('test-results/mobile-scheduling-'));
const debug = net.createServer(); debug.listen(0, '127.0.0.1'); await once(debug, 'listening');
const port = debug.address().port; await new Promise(done => debug.close(done));
const browser = spawn(process.env.EDGE_BINARY ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-extensions', '--disable-background-networking', '--disable-gpu', '--user-data-dir=' + join(output, 'profile'), '--remote-debugging-port=' + port, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(test, message, timeout = 12000) {
  const end = Date.now() + timeout;
  do { try { const value = await test(); if (value) return value; } catch {} await wait(60); } while (Date.now() < end);
  throw Error(message);
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let sequence = 0;
  const pending = new Map();
  const connection = { socket, call(method, params = {}) {
    const id = ++sequence;
    const promise = new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, result => { clearTimeout(timer); result.error ? reject(Error(JSON.stringify(result.error))) : done(result.result); });
    });
    socket.send(JSON.stringify({ id, method, params })); return promise;
  } };
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') runtimeErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const local = request.url.startsWith(origin + '/') || /^(?:data:|about:)/.test(request.url);
      if (!local) externalRequests.push(request.url);
      void connection.call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) }).catch(() => {});
    }
  });
  return connection;
}
let control, page;
const button = (text, scope = 'document') => `Array.from(${scope}.querySelectorAll('button')).find(el=>el.innerText.trim()===${JSON.stringify(text)})`;
const checkbox = `Array.from(document.querySelectorAll('.a2-edit label.check')).find(el=>el.innerText.trim()==='安排多个时段')?.querySelector('input[type=checkbox]')`;
async function click(expression) {
  const point = await page.evaluate(`(()=>{const el=${expression};if(!el||el.disabled)throw Error('Control unavailable');el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!(el===hit||el.contains(hit)))throw Error('Control is obscured');return {x,y}})()`);
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function capture(name) { const png = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name + '.png'), Buffer.from(png.data, 'base64')); }
async function openEditorFromCalendar() {
  const event = `Array.from(document.querySelectorAll('.timeline-event-button')).find(el=>el.innerText.includes(${JSON.stringify(title)}))`;
  await until(() => page.evaluate(`!!(${event})`), 'Synthetic calendar block is missing');
  await click(event);
  await until(() => page.evaluate(`!!document.querySelector('[role=dialog][aria-label="时段详情"]')`), 'Block details did not open');
  await click(button('编辑时段', `document.querySelector('[role=dialog][aria-label="时段详情"]')`));
  await until(() => page.evaluate(`!!document.querySelector('.a2-edit[aria-label="编辑时段"]')`), 'Block editor did not open');
}
try {
  const info = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {} }, 'Edge did not start');
  control = await connect(info.webSocketDebuggerUrl);
  const { browserContextId } = await control.call('Target.createBrowserContext');
  const { targetId } = await control.call('Target.createTarget', { url: 'about:blank', browserContextId });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.id === targetId), 'Isolated Edge page missing');
  page = await connect(target.webSocketDebuggerUrl);
  await page.call('Runtime.enable'); await page.call('Page.enable');
  await page.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.call('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  page.evaluate = async expression => { const value = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text); return value.result.value; };
  await page.call('Page.navigate', { url: origin });
  await until(() => page.evaluate(`!!document.querySelector('.m-task-main')`), 'Mobile task did not render');
  await click(button('日历', `document.querySelector('.m-tabs-bar')`));
  await openEditorFromCalendar();
  await until(() => page.evaluate(`!!(${checkbox})`), 'Multiple-slot checkbox missing from block editor');
  const visible = await page.evaluate(`(()=>{const el=${checkbox};const label=el.closest('label');const r=label.getBoundingClientRect();return {checked:el.checked,moreOpen:!!document.querySelector('.editor-form.more-open'),hiddenInMore:!!el.closest('[data-more]'),display:getComputedStyle(label).display,top:r.top,bottom:r.bottom,width:r.width,viewportHeight:innerHeight}})()`);
  assert(!visible.checked && !visible.moreOpen && !visible.hiddenInMore && visible.display !== 'none' && visible.width > 0 && visible.top >= 0 && visible.bottom <= visible.viewportHeight, 'Checkbox was not visible by default before opening More');
  await capture('01-single-slot-visible');
  checks.push({ check: 'calendar-block-editor-shows-unchecked-mode-without-more', ...visible });
  await click(checkbox);
  assert(await page.evaluate(`(${checkbox})?.checked===true`), 'Checkbox did not accept a real pointer click');
  await capture('02-multiple-slot-selected');
  await click(button('保存', `document.querySelector('.a2-edit')`));
  await until(() => mutations.length === 1 && snapshot.tasks[0].scheduleMode === 'multiple', 'Selected mode was not sent to the synthetic service');
  await until(() => page.evaluate(`!document.querySelector('.a2-edit')`), 'Editor did not close after saving');
  const batch = mutations[0].input.mutations;
  assert(batch.length === 2 && batch[0].type === 'update' && batch[0].entity === 'task' && batch[0].id === taskId && batch[0].values.scheduleMode === 'multiple' && batch[1].type === 'update' && batch[1].entity === 'block' && batch[1].id === blockId, 'Mode and existing block were not saved in one atomic batch');
  checks.push({ check: 'one-save-sends-task-mode-and-existing-block-in-same-request', mutationCount: batch.length, requestCount: mutations.length });
  await openEditorFromCalendar();
  await until(() => page.evaluate(`(${checkbox})?.checked===true`), 'Saved mode was not checked when reopening the block editor');
  assert(await page.evaluate(`!document.querySelector('.editor-form.more-open')`), 'Reopened mode required More');
  await capture('03-saved-mode-reopened');
  checks.push({ check: 'saved-mode-reappears-checked' });
  await click(button('取消', `document.querySelector('.a2-edit')`));
  await click(button('今天', `document.querySelector('.m-tabs-bar')`));
  await click(`Array.from(document.querySelectorAll('.m-task-main')).find(el=>el.innerText.includes(${JSON.stringify(title)}))`);
  await until(() => page.evaluate(`!!(${button('再安排一个时段')})`), 'Task details did not expose the additional-slot action');
  await click(button('再安排一个时段'));
  await until(() => page.evaluate(`!!document.querySelector('.a2-edit[aria-label="新建时段"]')`), 'Additional-slot action did not open a new block editor');
  assert(await page.evaluate(`document.querySelector('.a2-edit select[name=taskId]')?.value===${JSON.stringify(taskId)}`), 'Additional slot did not retain its task');
  await capture('04-additional-slot-editor');
  assert(mutations.length === 1, 'Opening additional scheduling unexpectedly wrote data');
  checks.push({ check: 'saved-multiple-task-offers-new-slot-with-same-task' });
  assert(runtimeErrors.length === 0, 'Browser runtime errors: ' + runtimeErrors.join('\n'));
  assert(externalRequests.length === 0, 'Application attempted a nonlocal request');
  const allowed = ['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot', '/api/v1/events', '/api/v1/rpc/mutate'];
  assert(!requests.some(item => item.path.startsWith('/api/') && !allowed.includes(item.path) && !item.path.startsWith('/api/v1/operations/')), 'Unexpected synthetic API request');
  const result = { passed: true, browser: 'Microsoft Edge', viewport: { width: 390, height: 844 }, checks, runtimeErrors, mutationRequests: mutations, productionRequests: 0, realAiRequests: 0, output };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { if (page) await capture('failure'); } catch {}
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, runtimeErrors, externalRequests, requests, mutations }, null, 2));
  console.error(String(error)); console.error('Diagnostic artifacts: ' + output); process.exitCode = 1;
} finally {
  try { if (control) await control.call('Browser.close'); } catch {}
  page?.socket.close(); control?.socket.close();
  if (browser.exitCode === null) browser.kill();
  for (const res of events) res.destroy();
  server.closeAllConnections(); server.close();
}
