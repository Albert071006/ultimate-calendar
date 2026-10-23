import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';
import { WebSocketServer } from 'ws';

const reportDirectory = resolve('test-results');
await mkdir(reportDirectory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'ultimate-calendar-smoke-'));
const executable = process.env.PLANNER_SMOKE_EXE || electron;
const launchArgs = process.env.PLANNER_SMOKE_EXE ? [] : ['.'];
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PLANNER_DEV_URL;
const secret = 'synthetic-only-temporary-storage-check';
let child; let ws; let seq = 0; const pending = new Map(); const diagnostics = [];
const qqToken = 'synthetic-qq-bridge-token';
const qqServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(qqServer, 'listening');
let qqClient;
qqServer.on('connection', client => { qqClient = client; client.on('message', buffer => {
  const request = JSON.parse(buffer.toString());
  const data = request.action === 'get_status' ? { online: true, good: true } : request.action === 'get_login_info' ? { user_id: '100', nickname: 'Synthetic' } : request.action === 'get_group_list' ? [{ group_id: '200', group_name: '合成课程群' }] : request.action === 'get_group_msg_history' ? { messages: [] } : {};
  client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }));
}); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function connect() {
  const port = await availablePort();
  child = spawn(executable, [...launchArgs, `--planner-profile=${profile}`, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => diagnostics.push(b.toString().replaceAll(secret, '[synthetic]')));
  let target;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('Electron exited during startup');
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('file:')); if (target) break; } catch {}
    await wait(100);
  }
  if (!target) throw Error('Renderer debug target did not appear');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => { const msg = JSON.parse(event.data); if (msg.id) { const callback = pending.get(msg.id); pending.delete(msg.id); callback?.(msg); } });
  for (let i = 0; i < 100; i++) { if (await evaluate('!!window.planner && !!document.querySelector(".app-shell")')) return; await wait(100); }
  throw Error('Actual application UI/preload did not become ready');
}
async function cdp(method, params = {}) { const id = ++seq; const response = new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000); pending.set(id, v => { clearTimeout(timeout); v.error ? reject(Error('CDP call failed')) : resolve(v.result); }); }); ws.send(JSON.stringify({ id, method, params })); return response; }
async function evaluate(expression) { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error('Renderer evaluation failed'); return result.result.value; }
function assert(condition, message) { if (!condition) throw Error(message); }
async function stop() {
  if (child && child.exitCode === null && ws?.readyState === WebSocket.OPEN) {
    try { await evaluate('setTimeout(() => window.close(), 50); true'); } catch {}
    await Promise.race([once(child, 'exit'), wait(4000)]);
  }
  const graceful = !child || child.exitCode === 0;
  if (ws) { ws.close(); ws = null; }
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  return graceful;
}
try {
  await connect();
  const first = await evaluate('window.planner.snapshot()'); assert(first.ok && first.data.tasks.length === 0 && !first.data.keyStatus.configured, 'Initial profile was not empty');
  const capture = await evaluate('window.planner.captureSnapshot()'); assert(capture.ok && !capture.data.config.enabled && capture.data.config.groupIds.length === 0, 'Capture is not opt-in');
  const captureConfig = await evaluate(`window.planner.captureConfigure(${JSON.stringify({ ...capture.data.config, endpoint: `ws://127.0.0.1:${qqServer.address().port}`, analysisEnabled: false })})`); assert(captureConfig.ok, 'Capture configure IPC failed');
  const connected = await evaluate(`window.planner.captureConnect({token:${JSON.stringify(qqToken)}})`); assert(connected.ok && connected.data.connection === 'online' && connected.data.config.accountId === '100', 'Capture did not verify QQ online identity');
  const qqGroups = await evaluate('window.planner.captureGroups()'); assert(qqGroups.ok && qqGroups.data[0]?.id === '200', 'QQ groups IPC failed');
  assert((await evaluate(`window.planner.captureConfigure(${JSON.stringify({ ...connected.data.config, groupIds: ['200'], enabled: true, analysisEnabled: false })})`)).ok, 'Group opt-in failed');
  const notice = { post_type: 'message', message_type: 'group', self_id: '100', group_id: '200', user_id: '300', message_id: '400', time: Date.now() / 1000, message: [{ type: 'text', data: { text: '合成验收：明天交报告' } }] };
  qqClient.send(JSON.stringify(notice)); qqClient.send(JSON.stringify(notice)); qqClient.send(JSON.stringify({ ...notice, group_id: '999', message_id: 'unselected' }));
  let qqMessages;
  for (let i = 0; i < 50; i++) { qqMessages = await evaluate('window.planner.captureMessages({})'); if (qqMessages.ok && qqMessages.data.items.length) break; await wait(100); }
  assert(qqMessages?.ok && qqMessages.data.total === 1 && qqMessages.data.items[0].text === notice.message[0].data.text, 'Real bridge capture/dedup/allowlist failed');
  assert(!(await readFile(join(profile, 'credentials', 'qq-bridge.bin'))).includes(Buffer.from(qqToken)), 'QQ bridge credential stored as plaintext');
  const qqSnapshot = await evaluate('window.planner.captureSnapshot()'); assert(!JSON.stringify(qqSnapshot).includes(qqToken), 'QQ bridge credential leaked');
  await evaluate(`Array.from(document.querySelectorAll('nav button')).find(b => b.textContent.includes('QQ 采集')).click(); true`);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector(".capture-page")?.textContent.includes("合成验收")')) break; await wait(100); }
  assert(await evaluate('!!document.querySelector(".capture-page") && document.querySelector(".capture-page").textContent.includes("合成验收")'), 'Capture page did not show stored message');
  const account = await evaluate('window.planner.accountSnapshot()'); assert(account.ok && !account.data.configured && account.data.balance.data === null, 'Account IPC or empty-account state failed');
  assert(await evaluate('typeof window.planner.refreshAccount === "function" && typeof window.planner.onAccountChanged === "function"'), 'Account bridge methods missing');
  // Real sandbox/preload/main roundtrip, using only this isolated profile's synthetic ledger.
  const ledgerDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), ledgerMonth = ledgerDay.slice(0, 7);
  const initialLedger = await evaluate(`window.planner.ledgerSnapshot({month:${JSON.stringify(ledgerMonth)}})`);
  assert(initialLedger.ok && !initialLedger.data.entries.some(entry => entry.id === 'synthetic-ledger-lunch'), 'Ledger snapshot IPC unavailable');
  const initialPersonalCents = initialLedger.data.summary.personalCents;
  const balanceTime = new Date(Date.now() - 60000).toISOString();
  const ledgerBalance = await evaluate(`window.planner.ledgerMutate(${JSON.stringify({ operationId: 'synthetic-ledger-balance', expectedRevision: initialLedger.data.revision, month: ledgerMonth, changes: [{ type: 'setBalance', snapshot: { id: 'synthetic-ledger-balance', accountId: 'alipay', balanceCents: 10000, date: new Date(Date.parse(balanceTime) + 8 * 3600000).toISOString().slice(0, 10), asOf: balanceTime, coveredEntryIds: [], note: '隔离验收余额，非真实用户余额' } }] })})`);
  assert(ledgerBalance.ok, 'Ledger balance snapshot IPC failed');
  const ledgerDraft = { id: 'synthetic-ledger-lunch', kind: 'expense', date: ledgerDay, month: ledgerMonth, occurredAt: new Date().toISOString(), title: '合成午饭（隔离账本测试）', category: '餐饮', amountCents: 2000, personalCents: 1200, cashflows: [{ accountId: null, deltaCents: -2000 }], note: 'AA，本人承担 12 元；支付账户稍后补充' };
  const ledgerCreateRequest = { operationId: 'synthetic-ledger-create', expectedRevision: ledgerBalance.data.snapshot.revision, month: ledgerMonth, changes: [{ type: 'putEntry', entry: ledgerDraft, expectedVersion: null, note: '合成验收' }] };
  const ledgerCreated = await evaluate(`window.planner.ledgerMutate(${JSON.stringify(ledgerCreateRequest)})`);
  assert(ledgerCreated.ok && ledgerCreated.data.snapshot.summary.personalCents === initialPersonalCents + 1200 && ledgerCreated.data.snapshot.summary.accounts.find(account => account.id === 'alipay').balanceCents === 10000, 'Unknown account expense changed a known balance or lost personal share');
  const ledgerRetry = await evaluate(`window.planner.ledgerMutate(${JSON.stringify(ledgerCreateRequest)})`);
  assert(ledgerRetry.ok && ledgerRetry.data.status === 'already_saved' && ledgerRetry.data.snapshot.entries.filter(entry => entry.id === ledgerDraft.id).length === 1, 'Ledger IPC retry duplicated the transaction');
  const ledgerCorrection = { operationId: 'synthetic-ledger-correct', expectedRevision: ledgerCreated.data.snapshot.revision, month: ledgerMonth, changes: [{ type: 'putEntry', entry: { ...ledgerDraft, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] }, expectedVersion: 1, note: '补充原笔支付账户' }] };
  const ledgerCorrected = await evaluate(`window.planner.ledgerMutate(${JSON.stringify(ledgerCorrection)})`);
  assert(ledgerCorrected.ok && ledgerCorrected.data.snapshot.summary.accounts.find(account => account.id === 'alipay').balanceCents === 8000 && ledgerCorrected.data.snapshot.summary.personalCents === initialPersonalCents + 1200, 'Supplementing account duplicated personal expense or failed to debit once');
  const ledgerUndo = await evaluate(`window.planner.ledgerUndo(${JSON.stringify({ operationId: 'synthetic-ledger-undo', expectedRevision: ledgerCorrected.data.snapshot.revision, month: ledgerMonth })})`);
  assert(ledgerUndo.ok && ledgerUndo.data.snapshot.entries.find(entry => entry.id === ledgerDraft.id).cashflows[0].accountId === null && ledgerUndo.data.snapshot.summary.accounts.find(account => account.id === 'alipay').balanceCents === 10000, 'Ledger undo did not restore original entry and balance together');
  const ledgerFinal = await evaluate(`window.planner.ledgerMutate(${JSON.stringify({ ...ledgerCorrection, operationId: 'synthetic-ledger-correct-final', expectedRevision: ledgerUndo.data.snapshot.revision })})`);
  assert(ledgerFinal.ok, 'Ledger correction after undo failed');
  await evaluate(`Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === '账单').click(); true`);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector(".ledger-page .ledger-charts")')) break; await wait(100); }
  assert(await evaluate('!!document.querySelector(".ledger-charts") && document.querySelector(".ledger-page").textContent.includes("合成午饭") && document.querySelector(".workspace-header .primary").textContent.includes("记一笔") && !document.querySelector(".detail-panel")'), 'Ledger sidebar/page integration, charts, or dedicated header failed');
  await writeFile(join(profile, 'ledger-overview.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`Array.from(document.querySelectorAll('.ledger-page [role="tab"]')).find(button => button.textContent === '明细').click(); true`);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector(".ledger-filters")')) break; await wait(50); }
  assert(await evaluate('document.querySelector(".ledger-page").textContent.includes("实际支付") && document.querySelector(".ledger-page").textContent.includes("个人开销") && document.querySelector(".ledger-page").textContent.includes("¥20.00") && document.querySelector(".ledger-page").textContent.includes("¥12.00")'), 'Ledger detail UI lost actual payment vs personal share');
  await evaluate(`Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === '设置').click(); true`);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector(".settings-page")')) break; await wait(50); }
  assert(await evaluate(`document.querySelectorAll('.settings-page .settings-group').length === 4
    && !document.querySelector('.settings-campus').open && !document.querySelector('.api-usage').open
    && document.querySelector('.settings-pricing').closest('.settings-group') === document.querySelector('.api-usage').closest('.settings-group')
    && new FormData(document.querySelector('.settings-page form')).has('periodMap')
    && new FormData(document.querySelector('.settings-page form')).has('campus')`), 'Grouped settings lost collapsed values or separated AI usage/pricing');
  await writeFile(join(profile, 'settings-overview.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.querySelector('.settings-campus > summary').click(); document.querySelector('.settings-campus').scrollIntoView({ block: 'start' }); true`);
  await writeFile(join(profile, 'settings-campus.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === '日历').click(); true`);
  const created = await evaluate(`window.planner.mutate(${JSON.stringify({ operationId: 'synthetic-smoke-create', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: '合成验收任务（隔离测试）', deadline: { date: '2026-12-20', time: null } } }] })})`); assert(created.ok && created.data.status === 'applied', 'Real preload/IPC mutation failed');
  const recurringTask = (await evaluate('window.planner.snapshot()')).data.tasks[0];
  const recurringRequest = { operationId: 'synthetic-smoke-recurring', origin: 'manual', mutations: [{ type: 'scheduleRecurringTask', id: recurringTask.id, expectedVersion: recurringTask.version,
    rule: { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', termStart: '2026-08-31' },
    location: '合成地点', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } }] };
  const recurringPreview = await evaluate(`window.planner.mutate(${JSON.stringify(recurringRequest)})`);
  assert(recurringPreview.ok && recurringPreview.data.status === 'preview' && recurringPreview.data.details.filter(d => d.entity === 'block').length === 6, 'Recurring IPC did not preview six even-week activities');
  assert((await evaluate('window.planner.snapshot()')).data.blocks.length === 0, 'Recurring preview wrote records before confirmation');
  const recurringSaved = await evaluate(`window.planner.mutate(${JSON.stringify({ ...recurringRequest, confirmed: true, confirmationToken: recurringPreview.data.confirmationToken })})`);
  assert(recurringSaved.ok && recurringSaved.data.status === 'applied', 'Recurring IPC confirmation failed');
  const recurringBlocks = (await evaluate('window.planner.snapshot()')).data.blocks.sort((a, b) => a.start.localeCompare(b.start));
  assert(recurringBlocks.length === 6 && recurringBlocks[0].start === '2026-11-03T20:40:00+08:00' && recurringBlocks[0].end === '2026-11-03T21:10:00+08:00'
    && recurringBlocks.at(-1).start === '2027-01-12T20:40:00+08:00' && recurringBlocks.every(b => b.taskId === recurringTask.id && b.reminders.leadMinutes?.[0] === 30), 'Recurring dates, task association, duration, or per-occurrence reminders were lost');
  const seriesId = recurringBlocks[0].recurrence?.seriesId;
  assert(seriesId && recurringBlocks.every(block => block.recurrence?.seriesId === seriesId && block.recurrence.occurrenceStart === block.start && block.cancelled === false), 'Recurring series metadata did not cross actual snapshot IPC');
  const ordinarySaved = await evaluate(`window.planner.mutate(${JSON.stringify({ operationId: 'synthetic-smoke-ordinary-same-task', origin: 'manual', mutations: [{ type: 'create', entity: 'block', values: { title: '同任务普通活动（隔离测试）', taskId: recurringTask.id, kind: 'event', start: '2026-11-04T12:00:00+08:00', end: '2026-11-04T12:30:00+08:00', location: '普通地点' } }] })})`);
  assert(ordinarySaved.ok && ordinarySaved.data.status === 'applied', 'Ordinary activity with the same task could not be created');
  const ordinaryBlock = (await evaluate('window.planner.snapshot()')).data.blocks.find(block => !block.recurrence);
  assert(ordinaryBlock && ordinaryBlock.taskId === recurringTask.id, 'Ordinary activity was incorrectly grouped into recurrence');
  const blockFields = ({ version, updatedAt, ...fields }) => fields;
  const fieldMap = blocks => blocks.map(blockFields).sort((a, b) => a.id.localeCompare(b.id));
  async function recurringMutation(operationId, mutation, expectedIds) {
    const before = (await evaluate('window.planner.snapshot()')).data;
    const preview = await evaluate(`window.planner.mutate(${JSON.stringify({ operationId, origin: 'manual', mutations: [mutation] })})`);
    assert(preview.ok && preview.data.status === 'preview', `${operationId}: semantic IPC did not require preview`);
    assert(JSON.stringify(preview.data.details.map(detail => detail.id).sort()) === JSON.stringify([...expectedIds].sort()), `${operationId}: preview targeted the wrong occurrences`);
    const afterPreview = (await evaluate('window.planner.snapshot()')).data;
    assert(JSON.stringify(afterPreview.blocks) === JSON.stringify(before.blocks) && JSON.stringify(afterPreview.tasks) === JSON.stringify(before.tasks), `${operationId}: preview modified records`);
    const saved = await evaluate(`window.planner.mutate(${JSON.stringify({ ...preview.data.proposedRequest, confirmed: true, confirmationToken: preview.data.confirmationToken })})`);
    assert(saved.ok && saved.data.status === 'applied', `${operationId}: semantic confirmation failed`);
    const after = (await evaluate('window.planner.snapshot()')).data;
    assert(JSON.stringify(after.blocks.find(block => block.id === ordinaryBlock.id)) === JSON.stringify(ordinaryBlock), `${operationId}: modified an ordinary activity just because taskId matched`);
    assert(JSON.stringify(after.tasks) === JSON.stringify(before.tasks), `${operationId}: changed or removed the linked task`);
    assert(after.blocks.filter(block => block.recurrence).every(block => JSON.stringify(block.recurrence) === JSON.stringify(recurringBlocks.find(original => original.id === block.id)?.recurrence)), `${operationId}: lost stable original occurrence identity`);
    return { before, after, transactionId: saved.data.transactionId };
  }
  async function undoRecurringMutation(operationId, result) {
    const undone = await evaluate(`window.planner.undo(${JSON.stringify(result.transactionId)})`);
    assert(undone.ok && undone.data.status === 'applied', `${operationId}: semantic undo failed`);
    const restored = (await evaluate('window.planner.snapshot()')).data;
    assert(JSON.stringify(fieldMap(restored.blocks)) === JSON.stringify(fieldMap(result.before.blocks)) && JSON.stringify(restored.tasks) === JSON.stringify(result.before.tasks), `${operationId}: undo did not restore activity fields and linked task`);
  }
  const singleAnchor = recurringBlocks[1];
  const singleEdit = await recurringMutation('synthetic-smoke-series-single-edit', { type: 'updateRecurringEvent', id: singleAnchor.id, expectedVersion: singleAnchor.version, scope: 'single', values: { start: '2026-11-18T21:40:00+08:00', location: '临时值班地点' } }, [singleAnchor.id]);
  const movedSingle = singleEdit.after.blocks.find(block => block.id === singleAnchor.id);
  assert(movedSingle.start === '2026-11-18T21:40:00+08:00' && movedSingle.end === '2026-11-18T22:10:00+08:00' && movedSingle.location === '临时值班地点', 'Single edit did not preserve duration across a date move');
  assert(singleEdit.after.blocks.filter(block => block.id !== singleAnchor.id).every(block => JSON.stringify(block) === JSON.stringify(singleEdit.before.blocks.find(original => original.id === block.id))), 'Single edit modified a sibling occurrence');
  await undoRecurringMutation('single edit', singleEdit);
  const followingAnchor = (await evaluate('window.planner.snapshot()')).data.blocks.find(block => block.id === recurringBlocks[2].id);
  const followingIds = recurringBlocks.slice(2).map(block => block.id);
  const followingEdit = await recurringMutation('synthetic-smoke-series-following-edit', { type: 'updateRecurringEvent', id: followingAnchor.id, expectedVersion: followingAnchor.version, scope: 'this-and-following', values: { start: '2026-12-02T19:00:00+08:00', reminders: { enabled: true, leadMinutes: [10], dateOnlyTime: null } } }, followingIds);
  for (const id of followingIds) {
    const block = followingEdit.after.blocks.find(value => value.id === id), original = followingEdit.before.blocks.find(value => value.id === id);
    assert(block.start.slice(11, 16) === '19:00' && Date.parse(`${block.start.slice(0, 10)}T00:00:00Z`) - Date.parse(`${original.start.slice(0, 10)}T00:00:00Z`) === 86400000
      && Date.parse(block.end) - Date.parse(block.start) === 30 * 60000 && block.reminders.leadMinutes?.[0] === 10, 'Following edit lost date offset, duration, or reminder settings');
  }
  assert(followingEdit.after.blocks.filter(block => !followingIds.includes(block.id)).every(block => JSON.stringify(block) === JSON.stringify(followingEdit.before.blocks.find(original => original.id === block.id))), 'Following edit changed an earlier occurrence');
  await undoRecurringMutation('following edit', followingEdit);
  for (const [scope, index] of [['single', 1], ['this-and-following', 3]]) {
    const anchor = (await evaluate('window.planner.snapshot()')).data.blocks.find(block => block.id === recurringBlocks[index].id);
    const ids = scope === 'single' ? [anchor.id] : recurringBlocks.slice(index).map(block => block.id);
    const cancelled = await recurringMutation(`synthetic-smoke-series-${scope}-cancel`, { type: 'cancelRecurringEvent', id: anchor.id, expectedVersion: anchor.version, scope }, ids);
    assert(cancelled.after.blocks.length === cancelled.before.blocks.length && cancelled.after.blocks.filter(block => block.cancelled).length === ids.length && ids.every(id => cancelled.after.blocks.find(block => block.id === id)?.cancelled), `${scope}: cancellation deleted history or affected wrong dates`);
    assert(cancelled.after.blocks.filter(block => !ids.includes(block.id)).every(block => JSON.stringify(block) === JSON.stringify(cancelled.before.blocks.find(original => original.id === block.id))), `${scope}: cancellation changed an earlier or ordinary activity`);
    await undoRecurringMutation(`${scope} cancel`, cancelled);
  }
  const ordinaryUndo = await evaluate(`window.planner.undo(${JSON.stringify(ordinarySaved.data.transactionId)})`);
  assert(ordinaryUndo.ok && ordinaryUndo.data.status === 'applied' && !(await evaluate('window.planner.snapshot()')).data.blocks.some(block => block.id === ordinaryBlock.id), 'Ordinary same-task fixture could not be undone');
  const recurringUndo = await evaluate(`window.planner.undo(${JSON.stringify(recurringSaved.data.transactionId)})`);
  assert(recurringUndo.ok && recurringUndo.data.status === 'applied' && (await evaluate('window.planner.snapshot()')).data.blocks.length === 0, 'Recurring batch could not be undone atomically');
  const bad = await evaluate('window.planner.mutate({operationId:"bad",arbitraryPath:"C:/secret"})'); assert(!bad.ok && bad.error.code === 'VALIDATION', 'Malformed DTO accepted');
  const key = await evaluate(`window.planner.setApiKey({key:${JSON.stringify(secret)}})`); assert(key.ok && key.data.configured && !key.data.sessionOnly, 'Async safeStorage encryption unavailable');
  assert(!(await readFile(join(profile, 'credentials', 'deepseek.bin'))).includes(Buffer.from(secret)), 'Credential file contains plaintext');
  const snapshot = await evaluate('window.planner.snapshot()'); assert(!JSON.stringify(snapshot).includes(secret), 'Snapshot leaked credential');
  assert(!JSON.stringify(await evaluate('window.planner.accountSnapshot()')).includes(secret), 'Account status leaked credential');
  await evaluate(`window.planner.saveSettings({settings:{...(${JSON.stringify(snapshot.data.settings)}),closeToTray:false}})`);
  assert(await stop(), 'Application did not quit gracefully before restart'); await connect();
  const reopened = await evaluate('window.planner.snapshot()'); assert(reopened.ok && reopened.data.tasks[0]?.title === '合成验收任务（隔离测试）' && reopened.data.keyStatus.configured, `Restart persistence/decryption failed (ok=${reopened.ok}, tasks=${reopened.data?.tasks?.length}, keyConfigured=${reopened.data?.keyStatus?.configured}, profile=${profile})`);
  const reopenedLedger = await evaluate(`window.planner.ledgerSnapshot({month:${JSON.stringify(ledgerMonth)}})`);
  assert(reopenedLedger.ok && reopenedLedger.data.entries.filter(entry => entry.id === ledgerDraft.id).length === 1 && reopenedLedger.data.entries.find(entry => entry.id === ledgerDraft.id).cashflows[0].accountId === 'alipay' && reopenedLedger.data.summary.personalCents === initialPersonalCents + 1200 && reopenedLedger.data.summary.accounts.find(account => account.id === 'alipay').balanceCents === 8000, 'Ledger entries, personal totals, snapshots, or corrected account failed restart persistence');
  // Exercise recovery through the real main process and sandbox IPC using only this temporary credential.
  const keyPath = join(profile, 'credentials', 'deepseek.bin');
  const encrypted = await readFile(keyPath);
  assert(await stop(), 'Application did not quit before recovery check');
  await writeFile(keyPath, 'synthetic-invalid-ciphertext');
  await connect();
  const unavailable = await evaluate('window.planner.snapshot()');
  assert(unavailable.ok && !unavailable.data.keyStatus.configured && unavailable.data.keyStatus.loadError === 'decrypt', 'Unreadable saved key was mistaken for an unconfigured key');
  assert((await readFile(keyPath)).toString() === 'synthetic-invalid-ciphertext', 'Failed load modified saved ciphertext');
  await writeFile(keyPath, encrypted);
  const recovered = await evaluate('window.planner.retryApiKey()'); assert(recovered.ok && recovered.data.configured && !JSON.stringify(recovered).includes(secret), 'Credential recovery bridge failed or leaked key');
  const afterRecovery = await evaluate('window.planner.snapshot()'); assert(afterRecovery.ok && afterRecovery.data.keyStatus.configured && !afterRecovery.data.keyStatus.loadError, 'Recovery did not update the status');
  const undone = await evaluate('window.planner.undo()'); assert(undone.ok && undone.data.status === 'applied', 'Persistent undo failed');
  const noKey = await evaluate('window.planner.setApiKey({key:null})'); assert(noKey.ok && !noKey.data.configured, 'Credential removal failed');
  const clearedAccount = await evaluate('window.planner.accountSnapshot()'); assert(clearedAccount.ok && !clearedAccount.data.configured && clearedAccount.data.balance.data === null && clearedAccount.data.models.data === null, 'Clearing key retained account-specific data');
  assert(await evaluate('typeof window.require === "undefined" && typeof window.process === "undefined"'), 'Renderer acquired Node capability');
  const files = await readdir(join(profile, 'backups')); for (const file of files) assert(!(await readFile(join(profile, 'backups', file))).includes(Buffer.from(secret)), 'Backup leaked credential');
  assert(!diagnostics.join('').match(/Unable to load preload|preload script.*Error|ReferenceError|Uncaught/i), 'Runtime preload/renderer error');
  console.log(JSON.stringify({ ok: true, actualMain: true, sandboxPreload: true, ledgerCreateCorrectQueryUndo: true, ledgerIdempotencyAndPersistence: true, ledgerSidebarChartsAndDetailUI: true, recurringPreviewConfirmUndo: true, recurringScopeEditsAndCancellationUndo: true, recurringStableIdentityAndOrdinaryTaskIsolation: true, gracefulQuitBeforeRestart: true, twoLaunchPersistence: true, savedCredentialRecovery: true, persistentUndo: true, syntheticEncryptedRoundtrip: true, rendererHasNoNode: true, profile }, null, 2));
  await writeFile(join(reportDirectory, 'smoke-result.json'), JSON.stringify({ ok: true, executable, profile, ledgerCreateCorrectQueryUndo: true, ledgerIdempotencyAndPersistence: true, ledgerSidebarChartsAndDetailUI: true, recurringScopeEditsAndCancellationUndo: true, recurringStableIdentityAndOrdinaryTaskIsolation: true, gracefulQuitBeforeRestart: true, twoLaunchPersistence: true, savedCredentialRecovery: true, syntheticEncryptedRoundtrip: true, diagnostics: diagnostics.join('').slice(-3000) }, null, 2));
} catch (error) { console.error(error.message); console.error(diagnostics.join('').replaceAll(secret, '[synthetic]').slice(-5000)); process.exitCode = 1; }
finally { await stop(); for (const client of qqServer.clients) client.terminate(); await new Promise(resolve => qqServer.close(resolve)); }
