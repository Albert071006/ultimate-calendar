import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';
import { WebSocket } from 'ws';

// Only isolated browser profiles and synthetic data. No production origin, credentials or AI.
const [oldArgument, newArgument] = process.argv.slice(2);
if (!oldArgument || !newArgument) throw Error('Usage: node scripts/smoke-mobile-upgrade.mjs <stable-static-directory> <new-static-directory>');
const roots = { old: resolve(oldArgument), next: resolve(newArgument) };
const html = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, await readFile(join(root, 'index.html'), 'utf8')])));
const version = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, /const BUILD_VERSION = '([^']+)'/.exec(await readFile(join(root, 'sw.js'), 'utf8'))?.[1]])));
const allowedAssets = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, new Set(JSON.parse(/const STATIC_ASSETS = (\[[^\n]+\]);/.exec(await readFile(join(root, 'sw.js'), 'utf8'))?.[1] ?? '[]'))])));
const integrityWorker = (await readFile(join(roots.next, 'sw.js'), 'utf8')).includes('const STATIC_INTEGRITY');
const script = Object.fromEntries(Object.entries(html).map(([name, value]) => [name, /<script[^>]+src="\.?(\/assets\/[^"?]+\.js)"/.exec(value)?.[1]]));
if (!script.old || !script.next || script.old === script.next || !version.old || !version.next) throw Error('Expected two distinct production builds');
const checks = [], requests = [], runtimeErrors = [];
const session = { paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 }, device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic smoke phone' }, csrfToken: 'synthetic-csrf', aiConfigured: false };
const snapshot = { schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } };
let current = 'old', retain = false, switchAfterDocument = false, pauseSession = false;
const pausedResponses = new Set();
const blockedAssets = new Set();
const json = (res, value) => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'synthetic_phone=preserved; Path=/; SameSite=Strict' }); res.end(JSON.stringify(value)); } };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const record = { path, status: 0, build: current }; requests.push(record);
  if (path === '/api/v1/session' || path === '/api/v1/session/renew') {
    record.status = 200;
    if (pauseSession) { pausedResponses.add(res); res.once('close', () => pausedResponses.delete(res)); return; }
    return json(res, session);
  }
  if (path === '/api/v1/rpc/snapshot') { record.status = 200; return json(res, { ok: true, data: snapshot }); }
  if (path === '/api/v1/events') { record.status = 200; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': synthetic\n\n'); return; }
  if (path.startsWith('/api/')) { record.status = 409; res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: 'No writes are permitted in this smoke test' } })); return; }
  const fileName = path === '/' ? 'index.html' : path.slice(1);
  const safePath = root => { const file = resolve(root, fileName), part = relative(root, file); if (part.startsWith('..') || isAbsolute(part)) throw Error('Unsafe synthetic request'); return file; };
  try {
    if (blockedAssets.has(path) || !retain && path.startsWith('/assets/') && !allowedAssets[current].has(path)) throw Error('Deliberately unavailable synthetic asset');
    let file = safePath(roots[current]);
    try { await access(file); } catch { if (!retain || !path.startsWith('/assets/')) throw Error('Missing current resource'); file = safePath(roots[current === 'old' ? 'next' : 'old']); }
    const data = await readFile(file);
    if (path === '/' && switchAfterDocument) { switchAfterDocument = false; current = 'next'; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    record.status = 200; res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain', 'Cache-Control': 'no-cache' }); res.end(data);
  } catch { record.status = 404; res.writeHead(404); res.end('Synthetic missing resource'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir('test-results', { recursive: true }); const output = await mkdtemp(resolve('test-results/mobile-upgrade-'));
const debug = net.createServer(); debug.listen(0, '127.0.0.1'); await once(debug, 'listening'); const debugPort = debug.address().port; await new Promise(done => debug.close(done));
const edge = process.env.EDGE_BINARY ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-extensions', '--disable-gpu', '--user-data-dir=' + join(output, 'profile'), '--remote-debugging-port=' + debugPort, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const wait = ms => new Promise(done => setTimeout(done, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
async function until(test, message, timeout = 12000) {
  const end = Date.now() + timeout;
  do { try { const value = await test(); if (value) return value; } catch {} await wait(80); } while (Date.now() < end);
  throw Error(message);
}
async function connection(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let sequence = 0; const pending = new Map();
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); }
    else if (value.method === 'Runtime.exceptionThrown') runtimeErrors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  });
  return {
    socket,
    call(method, params = {}) {
      const id = ++sequence;
      const result = new Promise((done, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, value => { clearTimeout(timer); value.error ? reject(Error(JSON.stringify(value.error))) : done(value.result); }); });
      socket.send(JSON.stringify({ id, method, params })); return result;
    },
  };
}
let control;
const pageSockets = new Set();
async function newPage(context) {
  const { targetId } = await control.call('Target.createTarget', { url: 'about:blank', browserContextId: context });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(value => value.id === targetId), 'New isolated page missing');
  const page = await connection(target.webSocketDebuggerUrl); pageSockets.add(page.socket);
  await page.call('Runtime.enable'); await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  page.evaluate = async expression => { const result = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  page.close = async () => { await control.call('Target.closeTarget', { targetId }); page.socket.close(); pageSockets.delete(page.socket); };
  return page;
}
const ready = page => page.evaluate('!!document.querySelector(".m-app") && document.body.innerText.includes("今天没有课程和安排。")');
async function openCalendar(page, label, suffix = '') {
  const start = Date.now(); await page.call('Page.navigate', { url: origin + '/' + suffix });
  await until(() => ready(page), label + ': calendar never rendered');
  const readyMs = Date.now() - start; checks.push({ check: label, readyMs }); return readyMs;
}
const activeWorker = page => page.evaluate('(async()=>{const r=await navigator.serviceWorker.getRegistration();return r?.active?.state==="activated"&&!!navigator.serviceWorker.controller})()');
async function switchWorker(page, context, build) {
  current = build; retain = true;
  await page.evaluate('(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();return true})()');
  await until(() => page.evaluate('(async()=>{const r=await navigator.serviceWorker.getRegistration();return r?.waiting?.state==="installed"})()'), build + ' worker never reached waiting');
  await page.close(); await wait(200);
  const reopened = await newPage(context); await openCalendar(reopened, build === 'next' ? 'upgraded-reopen' : 'rollback-reopen');
  await until(() => reopened.evaluate(`(async()=>{const keys=await caches.keys();return keys.includes(${JSON.stringify('ultimate-calendar-shell-' + version[build])})&&!keys.includes(${JSON.stringify('ultimate-calendar-shell-' + version[build === 'old' ? 'next' : 'old'])})})()`), 'Expected worker version did not activate');
  return reopened;
}
const idb = body => `(async()=>{const db=await new Promise((done,fail)=>{const r=indexedDB.open('ultimate-calendar-phone-v1',1);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(r.error)});const get=key=>new Promise((done,fail)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(r.error)});const key=await get('active:'+location.origin);const value=await get(key);${body}})()`;
const preserved = page => page.evaluate(idb(`return value?.session?.device?.id===${JSON.stringify(session.device.id)}&&value.queue.some(item=>item.id==='synthetic-retained-draft')&&document.cookie.includes('synthetic_phone=preserved');`));
try {
  const description = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch {} }, 'Edge did not start');
  control = await connection(description.webSocketDebuggerUrl);
  // Deterministic reproduction: an old document starts loading just as its release disappears.
  for (const keep of [false, true]) {
    const { browserContextId: context } = await control.call('Target.createBrowserContext');
    const page = await newPage(context); current = 'old'; retain = keep; switchAfterDocument = true;
    const start = requests.length; await page.call('Page.navigate', { url: origin });
    if (!keep) {
      await until(() => requests.slice(start).some(item => item.path === script.old && item.status === 404), 'Could not reproduce missing old fingerprinted script');
      await wait(300); assert(!await ready(page), 'Missing JS unexpectedly rendered a calendar');
      checks.push({ check: 'reproduced-old-document-new-release-without-retention', script404: true, blank: !(await page.evaluate('document.body.innerText')).trim() });
    } else { await until(() => ready(page), 'Retained old assets did not prevent the upgrade gap'); checks.push({ check: 'retained-assets-prevent-upgrade-gap', script404: false }); }
    await page.close(); await control.call('Target.disposeBrowserContext', { browserContextId: context });
  }
  if (html.next.includes('UC-START-01')) {
    const { browserContextId: context } = await control.call('Target.createBrowserContext');
    const page = await newPage(context); current = 'next'; retain = true; blockedAssets.add(script.next);
    await page.call('Page.navigate', { url: origin });
    await until(() => page.evaluate(`document.body.innerText.includes('UC-START-01') && !!document.querySelector('a[href="/?recovery=startup"]')`), 'Missing script left a white screen instead of a recovery action');
    assert(!await ready(page), 'Blocked production script unexpectedly ran'); checks.push({ check: 'missing-bundle-shows-static-recovery-action' });
    blockedAssets.clear(); await openCalendar(page, 'static-recovery-action-opens-calendar', '?recovery=startup');
    await page.close(); await control.call('Target.disposeBrowserContext', { browserContextId: context });
  }
  const { browserContextId: context } = await control.call('Target.createBrowserContext');
  current = 'old'; retain = true; let page = await newPage(context);
  await openCalendar(page, 'stable-cold-start'); await until(() => activeWorker(page), 'Stable worker not active');
  await page.evaluate(idb(`value.queue.push({id:'synthetic-retained-draft',requestId:'33333333-3333-4333-8333-333333333333',method:'mutate',input:{operationId:'synthetic-draft',origin:'manual',mutations:[]},identity:value.session.identity,createdAt:'2030-01-10T08:00:00+08:00',status:'conflict',label:'Synthetic unsubmitted draft',message:'Synthetic conflict; never send automatically',base:[],dependencies:[],targets:[]});await new Promise((done,fail)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put(value,key);tx.oncomplete=done;tx.onerror=()=>fail(tx.error)});return true;`));
  await openCalendar(page, 'stable-cached-reopen'); assert(await preserved(page), 'Stable reopen lost synthetic device, cookie or draft');
  page = await switchWorker(page, context, 'next'); assert(await preserved(page), 'Upgrade lost synthetic device, cookie or draft');
  await openCalendar(page, 'upgraded-cached-reopen'); assert(await preserved(page), 'Cached reopen lost synthetic draft');
  const deleted = await page.evaluate(`(async()=>{const c=await caches.open(${JSON.stringify('ultimate-calendar-shell-' + version.next)});return c.delete(${JSON.stringify(script.next)})})()`);
  assert(deleted, 'Could not remove the synthetic cached script');
  await openCalendar(page, 'cache-miss-refetches-matching-script'); assert(await preserved(page), 'Cache recovery lost synthetic draft');
  pauseSession = true;
  const cachedTime = await openCalendar(page, 'cached-calendar-with-session-response-held');
  assert(cachedTime < 3000 && pausedResponses.size > 0, 'Calendar did not render before the held session response');
  pauseSession = false; for (const res of pausedResponses) json(res, session); pausedResponses.clear();
  await until(() => preserved(page), 'Slow reconnect lost pairing or draft');
  if (integrityWorker) {
    const deletedDocument = await page.evaluate(`(async()=>{const c=await caches.open(${JSON.stringify('ultimate-calendar-shell-' + version.next)});return c.delete('/index.html')})()`);
    assert(deletedDocument, 'Could not remove the synthetic cached document');
    current = 'old'; retain = true;
    await page.call('Page.navigate', { url: origin });
    await until(() => page.evaluate(`document.body.innerText.includes('UC-SHELL-01') && !!document.querySelector('a[href="/?recovery=shell"]')`), 'Mixed-version HTML was not replaced with the recovery page');
    assert(await preserved(page), 'Mixed-version recovery page lost synthetic data');
    checks.push({ check: 'mixed-version-document-rejected-with-recovery-action' });
    await openCalendar(page, 'mixed-version-recovery-query-opens-stable-calendar', '?recovery=shell');
    assert(await preserved(page), 'Mixed-version recovery query lost synthetic data');
  }
  page = await switchWorker(page, context, 'old'); assert(await preserved(page), 'Rollback lost synthetic device, cookie or draft');
  await openCalendar(page, 'rollback-recovery-query', '?recovery=synthetic'); assert(await preserved(page), 'Recovery query changed synthetic data');
  assert(!requests.some(item => item.path.startsWith('/api/') && !['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot', '/api/v1/events'].includes(item.path)), 'Smoke attempted a business mutation');
  assert(runtimeErrors.length === 0, 'Browser runtime errors: ' + runtimeErrors.join('\n'));
  await page.close(); await control.call('Target.disposeBrowserContext', { browserContextId: context });
  const result = { passed: true, browser: 'Microsoft Edge', oldVersion: version.old, newVersion: version.next, checks, runtimeErrors, preserved: ['synthetic-device', 'cookie', 'outbox'], businessWrites: 0 };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, runtimeErrors, requests }, null, 2));
  console.error(String(error)); console.error('Diagnostic artifacts: ' + output); process.exitCode = 1;
} finally {
  for (const res of pausedResponses) res.destroy();
  try { if (control) await control.call('Browser.close'); } catch {}
  for (const socket of pageSockets) socket.close(); control?.socket.close();
  if (browser.exitCode === null) browser.kill();
  server.closeAllConnections(); server.close();
}
