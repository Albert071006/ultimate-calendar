import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';
import { WebSocket } from 'ws';

// Real Edge, isolated profile, synthetic service only. Never contacts production or an AI provider.
const [argument] = process.argv.slice(2);
if (!argument) throw Error('Usage: node scripts/smoke-assistant-recovery.mjs <new-static-directory>');
const root = resolve(argument);
await readFile(join(root, 'index.html'));
const checks = [], requests = [], commands = [], runtimeErrors = [];
const receipts = new Map(), eventResponses = new Set();
const session = { paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 }, device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic recovery phone' }, csrfToken: 'synthetic-csrf', aiConfigured: true };
const snapshot = { schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: true, sessionOnly: false } };
let unavailable = false, dropNextCommand = false, failRefreshAfterCommand = false, snapshotsAfterCommand = 0;
const respond = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const failure = message => ({ ok: false, error: { code: 'NETWORK', message, retryable: true } });
const commandResult = (reply, phase = 'saved') => ({ ok: true, data: { reply, mutationResult: null, items: [], conversationState: { domain: 'calendar', phase } } });
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push({ path, method: req.method, unavailable });
  if (path.startsWith('/api/') && unavailable) return respond(res, failure('合成网络中断'), 503);
  if (path === '/api/v1/session' || path === '/api/v1/session/renew') return respond(res, session);
  if (path === '/api/v1/rpc/snapshot') {
    if (failRefreshAfterCommand && ++snapshotsAfterCommand >= 2) {
      return respond(res, failure('合成刷新读取失败'));
    }
    return respond(res, { ok: true, data: snapshot });
  }
  if (path === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': synthetic\n\n'); eventResponses.add(res); res.once('close', () => eventResponses.delete(res)); return;
  }
  if (path.startsWith('/api/v1/operations/')) {
    const requestId = decodeURIComponent(path.slice('/api/v1/operations/'.length));
    return respond(res, receipts.has(requestId) ? { status: 'completed', requestId, method: 'command', result: receipts.get(requestId) } : { status: 'unknown' });
  }
  if (path === '/api/v1/rpc/command') {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const envelope = JSON.parse(bytes), text = envelope.input.text;
    commands.push({ requestId: envelope.requestId, input: envelope.input });
    if (!receipts.has(envelope.requestId)) {
      const result = text === '明天中午到合成食堂集合'
        ? commandResult('合成问题：请补充集合日期，并说明是否新的一场。', 'clarification')
        : commandResult(text === '合成回执核验' ? '合成回执已确认，原操作只执行一次。'
          : text === '合成刷新核验' ? '合成刷新核验已完成。' : '合成集合已记录：28号中午，新的一场。');
      receipts.set(envelope.requestId, result);
    }
    if (text === '合成刷新核验') { failRefreshAfterCommand = true; snapshotsAfterCommand = 0; }
    if (dropNextCommand) {
      dropNextCommand = false; unavailable = true; res.destroy(); return;
    }
    return respond(res, receipts.get(envelope.requestId));
  }
  if (path.startsWith('/api/')) return respond(res, failure('Unexpected synthetic API request'), 400);
  try {
    const file = resolve(root, path === '/' ? 'index.html' : path.slice(1)), part = relative(root, file);
    if (part.startsWith('..') || isAbsolute(part)) throw Error('Unsafe static path');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    const data = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  } catch { res.writeHead(404); res.end('Synthetic missing resource'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir('test-results', { recursive: true });
const output = await mkdtemp(resolve('test-results/assistant-recovery-'));
const debug = net.createServer(); debug.listen(0, '127.0.0.1'); await once(debug, 'listening');
const port = debug.address().port; await new Promise(done => debug.close(done));
const browser = spawn(process.env.EDGE_BINARY ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-extensions', '--disable-gpu', '--user-data-dir=' + join(output, 'profile'), '--remote-debugging-port=' + port, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const wait = ms => new Promise(done => setTimeout(done, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function until(test, message, timeout = 12000) {
  const end = Date.now() + timeout;
  do { try { const value = await test(); if (value) return value; } catch {} await wait(60); } while (Date.now() < end);
  throw Error(message);
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let sequence = 0;
  const pending = new Map();
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') runtimeErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  });
  return { socket, call(method, params = {}) {
    const id = ++sequence;
    const promise = new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, result => { clearTimeout(timer); result.error ? reject(Error(JSON.stringify(result.error))) : done(result.result); });
    });
    socket.send(JSON.stringify({ id, method, params })); return promise;
  } };
}
let control, page;
const input = 'textarea[aria-label="对生活助手说"]';
async function setInput(text) {
  await page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await until(() => page.evaluate(`document.querySelector(${JSON.stringify(input)})?.value===${JSON.stringify(text)}&&!document.querySelector('.m-send').disabled`), 'Composer did not accept synthetic text');
}
async function send(text) { await setInput(text); await page.evaluate("document.querySelector('.m-send').click()"); }
const reply = text => page.evaluate(`Array.from(document.querySelectorAll('.m-msg.assistant')).some(el=>!el.classList.contains('failed')&&!el.classList.contains('pending')&&el.innerText.includes(${JSON.stringify(text)}))`);
async function capture(name) { const png = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name + '.png'), Buffer.from(png.data, 'base64')); }
try {
  const info = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {} }, 'Edge did not start');
  control = await connect(info.webSocketDebuggerUrl);
  const { browserContextId } = await control.call('Target.createBrowserContext');
  const { targetId } = await control.call('Target.createTarget', { url: 'about:blank', browserContextId });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.id === targetId), 'Isolated Edge page missing');
  page = await connect(target.webSocketDebuggerUrl);
  await page.call('Runtime.enable'); await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  page.evaluate = async expression => { const value = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text); return value.result.value; };
  await page.call('Page.navigate', { url: origin });
  await until(() => page.evaluate("!!document.querySelector('.m-assist-entry')"), 'Mobile calendar did not render');
  await page.evaluate("window.syntheticOnlineEvents=0;window.addEventListener('online',()=>window.syntheticOnlineEvents++);document.querySelector('.m-assist-entry').click()");
  await send('明天中午到合成食堂集合');
  await until(() => reply('合成问题'), 'Clarification did not arrive');
  checks.push({ check: 'successful-clarification', commands: commands.length });

  unavailable = true;
  await page.evaluate("window.dispatchEvent(new Event('offline'))");
  await send('28号中午');
  await until(() => page.evaluate("Array.from(document.querySelectorAll('.m-msg.assistant.failed')).some(el=>el.innerText.includes('尚未发送'))"), 'Pre-send failure did not show its real cause');
  assert(commands.length === 1, 'Offline clarification reached the synthetic server');
  assert(await page.evaluate(`document.querySelector(${JSON.stringify(input)}).value==='28号中午'`), 'Unsent clarification was not restored visibly');
  assert(await page.evaluate("document.body.innerText.includes('可在输入框继续补充后发送')"), 'Draft continuation hint missing');
  await capture('01-unsent-draft');
  checks.push({ check: 'not-sent-error-and-visible-draft', commandPosts: commands.length });

  const resumeStart = requests.length;
  unavailable = false; // Deliberately do not fire online/visibilitychange/pageshow.
  await send('28号中午，新的一场');
  await until(() => reply('合成集合已记录'), 'Sending the edited draft did not recover connectivity');
  const merged = commands.filter(command => command.input.text === '28号中午，新的一场');
  assert(merged.length === 1 && commands.length === 2, 'Edited clarification was lost or submitted twice');
  assert(!merged[0].input.history.some(entry => entry.text === '28号中午'), 'Unsent text was silently injected into model history');
  const resumeRequests = requests.slice(resumeStart);
  assert(resumeRequests.findIndex(item => item.path === '/api/v1/session') >= 0 && resumeRequests.findIndex(item => item.path === '/api/v1/session') < resumeRequests.findIndex(item => item.path === '/api/v1/rpc/command'), 'Command did not revalidate its connection before sending');
  assert(await page.evaluate('window.syntheticOnlineEvents===0'), 'Recovery depended on a browser online event');
  await capture('02-continued-clarification');
  checks.push({ check: 'edited-draft-recovers-without-online-event', commandPosts: merged.length, text: merged[0].input.text });

  dropNextCommand = true;
  await send('合成回执核验');
  await until(() => page.evaluate("Array.from(document.querySelectorAll('.m-msg.assistant.failed')).some(el=>el.innerText.includes('结果待核对'))"), 'Dropped response was not marked uncertain');
  const lost = commands.find(command => command.input.text === '合成回执核验');
  assert(lost && receipts.has(lost.requestId), 'Synthetic server did not retain the completed operation');
  assert(await page.evaluate(`document.querySelector(${JSON.stringify(input)}).value===''`), 'Uncertain command was incorrectly restored as a new draft');
  await capture('03-unknown-result');
  unavailable = false;
  await page.evaluate("(()=>{const bubble=Array.from(document.querySelectorAll('.m-msg.assistant.failed')).find(el=>el.innerText.includes('结果待核对'));const button=Array.from(bubble.querySelectorAll('button')).find(el=>el.innerText==='重试这条指令');if(!button||button.disabled)throw Error('Receipt retry unavailable');button.click()})()");
  await until(() => reply('合成回执已确认'), 'Original receipt did not restore the dropped result');
  assert(commands.filter(command => command.input.text === '合成回执核验').length === 1, 'Receipt retry executed the command again');
  assert(requests.some(item => item.path === '/api/v1/operations/' + lost.requestId), 'Recovery did not query the original request ID');
  checks.push({ check: 'lost-response-reuses-original-receipt', commandPosts: 1, operationLookups: requests.filter(item => item.path === '/api/v1/operations/' + lost.requestId).length });

  await send('合成刷新核验');
  await until(() => reply('合成刷新核验已完成'), 'Post-success refresh failure erased the successful response');
  await until(() => page.evaluate("document.body.innerText.includes('已收到处理结果，但最新资料刷新失败')"), 'Successful response lacked a separate refresh warning');
  assert(commands.filter(command => command.input.text === '合成刷新核验').length === 1, 'Refresh failure repeated the command');
  assert(await page.evaluate("!Array.from(document.querySelectorAll('.m-msg.assistant')).find(el=>el.innerText.includes('合成刷新核验已完成')).querySelector('button')"), 'Successful reply exposed a retry action');
  await capture('04-success-refresh-warning');
  checks.push({ check: 'success-survives-refresh-failure', commandPosts: 1 });
  assert(runtimeErrors.length === 0, 'Browser runtime/console errors: ' + runtimeErrors.join('\n'));
  assert(!requests.some(item => item.path.startsWith('/api/') && !['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot', '/api/v1/events', '/api/v1/rpc/command'].includes(item.path) && !item.path.startsWith('/api/v1/operations/')), 'Unexpected synthetic API call');
  const result = { passed: true, browser: 'Microsoft Edge', viewport: { width: 390, height: 844 }, checks, runtimeErrors, commandPosts: commands.length, distinctExecutions: receipts.size, productionRequests: 0, realAiRequests: 0, output };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { if (page) await capture('failure'); } catch {}
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, runtimeErrors, requests, commands }, null, 2));
  console.error(String(error)); console.error('Diagnostic artifacts: ' + output); process.exitCode = 1;
} finally {
  try { if (control) await control.call('Browser.close'); } catch {}
  page?.socket.close(); control?.socket.close();
  if (browser.exitCode === null) browser.kill();
  for (const res of eventResponses) res.destroy();
  server.closeAllConnections(); server.close();
}
