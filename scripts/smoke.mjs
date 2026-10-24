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
// Main navigation buttons may carry a count after the label (e.g. "待判断 3").
async function nav(label) { assert(await evaluate(`(() => { const button = Array.from(document.querySelectorAll('nav[aria-label="主导航"] button')).find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); button?.click(); return !!button; })()`), `Main navigation lost ${label}`); }
async function meItem(label) {
  await nav('我的');
  assert(await evaluate(`(() => { const button = Array.from(document.querySelectorAll('nav[aria-label="我的"] button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return !!button; })()`), `我的 menu lost ${label}`);
}
async function until(expression, tries = 50, interval = 100) { for (let i = 0; i < tries; i++) { if (await evaluate(expression)) return true; await wait(interval); } return false; }
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
  const updateState = await evaluate('window.planner.updateSnapshot()');
  assert(updateState.ok && updateState.data.status === 'unavailable' && /^\d+\.\d+\.\d+$/.test(updateState.data.currentVersion), 'Isolated profile must expose version without enabling real updates');
  const isolatedCheck = await evaluate('window.planner.checkForUpdates()');
  assert(isolatedCheck.ok && isolatedCheck.data.status === 'unavailable', 'Isolated profile unexpectedly enabled update checks');
  assert(!(await evaluate('window.planner.downloadUpdate()')).ok && !(await evaluate('window.planner.installUpdate()')).ok, 'Isolated profile allowed real update download or installation');
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
  await meItem('QQ 采集');
  await until('!!document.querySelector(".capture-page")?.textContent.includes("合成验收")');
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
  await nav('账单');
  await until('!!document.querySelector(".a2-ledger .a2-ledger-daily") && document.querySelector(".a2-ledger").textContent.includes("合成午饭")');
  assert(await evaluate(`!!document.querySelector('.a2-ledger .a2-ledger-daily') && document.querySelector('.a2-ledger').textContent.includes('合成午饭')
    && Array.from(document.querySelectorAll('.a2-ledger button')).some(button => button.textContent.trim() === '记一笔')
    && Array.from(document.querySelectorAll('[role=tablist][aria-label="账单页面"] [role=tab]')).map(tab => tab.textContent).join() === '收支,账户'
    && !document.querySelector('.detail-panel')`), 'Ledger page, daily chart, tabs, or 记一笔 action failed');
  await writeFile(join(profile, 'ledger-overview.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert(await evaluate(`(() => { const row = Array.from(document.querySelectorAll('.a2-ledger details.a2-tx')).find(row => row.querySelector('summary').textContent.includes('合成午饭')); if (!row) return false; row.open = true;
    const detail = row.querySelector('.a2-tx-detail').textContent; return detail.includes('实际支付') && detail.includes('个人开销') && detail.includes('¥20.00') && detail.includes('¥12.00'); })()`), 'Ledger detail UI lost actual payment vs personal share');
  await meItem('AI 与费用');
  await until('!!document.querySelector(".settings-page form")', 50, 50);
  assert(await evaluate(`document.querySelectorAll('.settings-page form .settings-group').length === 4
    && Array.from(document.querySelectorAll('.settings-page .settings-group')).filter(group => !group.hidden).length === 1
    && !document.querySelector('.settings-page .settings-group[data-section="ai"]').hidden
    && !document.querySelector('.settings-campus').open && !document.querySelector('.api-usage').open
    && document.querySelector('.settings-pricing').closest('.settings-group') === document.querySelector('.api-usage').closest('.settings-group')
    && new FormData(document.querySelector('.settings-page form')).has('periodMap')
    && new FormData(document.querySelector('.settings-page form')).has('campus')`), 'Sectioned settings lost hidden values, showed several sections, or separated AI usage/pricing');
  await writeFile(join(profile, 'settings-overview.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await meItem('学期与节次');
  assert(await until('!document.querySelector(".settings-campus").hidden && document.querySelector(".settings-campus").open', 50, 50), 'Term section did not open its campus settings');
  await writeFile(join(profile, 'settings-campus.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await meItem('软件更新');
  assert(await until('!!document.querySelector(".settings-page .software-update") && document.querySelector(".settings-page .software-version").textContent.includes("v")', 50, 50), 'Software update section missing its version');
  await nav('日历');
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
  // Exercise overdue/ended personal tasks through the actual renderer, IPC and
  // SQLite store. Dates are relative to this run, so the smoke remains useful
  // after the release date. All records live only in the temporary profile.
  const fixtureTransactions = [];
  async function saveAttentionFixture(operationId, mutations) {
    const request = { operationId, origin: 'manual', mutations };
    let result = await evaluate(`window.planner.mutate(${JSON.stringify(request)})`);
    if (result.ok && result.data.status === 'preview') result = await evaluate(`window.planner.mutate(${JSON.stringify({ ...result.data.proposedRequest, confirmed: true, confirmationToken: result.data.confirmationToken })})`);
    assert(result.ok && result.data.status === 'applied', `${operationId}: fixture could not be saved`);
    fixtureTransactions.push(result.data.transactionId);
  }
  const shanghaiDayOffset = days => new Date(Date.now() + days * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const overdueDay = shanghaiDayOffset(-3), endedDay = shanghaiDayOffset(-2), workDay = shanghaiDayOffset(7);
  const attentionTitles = {
    overdue: '合成逾期未完成事项（隔离验收）',
    ended: '合成已结束待处理事项（隔离验收）',
    work: '合成已安排执行事项（隔离验收）',
    done: '合成已完成事项（隔离验收）',
  };
  for (const [key, title] of Object.entries(attentionTitles)) await saveAttentionFixture(`synthetic-attention-task-${key}`, [{ type: 'create', entity: 'task', values: {
    title, status: key === 'done' ? 'done' : 'open', deadline: key === 'overdue' || key === 'done' ? { date: overdueDay, time: '12:00' } : null,
    reminders: { enabled: false, leadMinutes: null, dateOnlyTime: null },
  } }]);
  const attentionTasks = Object.fromEntries(Object.entries(attentionTitles).map(([key, title]) => [key, title]));
  const attentionSnapshot = (await evaluate('window.planner.snapshot()')).data;
  for (const key of Object.keys(attentionTasks)) attentionTasks[key] = attentionSnapshot.tasks.find(task => task.title === attentionTitles[key]);
  assert(Object.values(attentionTasks).every(Boolean), 'Attention task fixtures disappeared from storage');
  for (const [key, kind, day] of [['ended', 'event', endedDay], ['work', 'work', workDay]]) await saveAttentionFixture(`synthetic-attention-block-${key}`, [{ type: 'create', entity: 'block', values: {
    title: attentionTitles[key], taskId: attentionTasks[key].id, kind, start: `${day}T10:00:00+08:00`, end: `${day}T10:30:00+08:00`, location: '合成验收地点',
    reminders: { enabled: false, leadMinutes: null, dateOnlyTime: null },
  } }]);
  const beforeWorkEdit = (await evaluate('window.planner.snapshot()')).data;
  const workBlock = beforeWorkEdit.blocks.find(block => block.taskId === attentionTasks.work.id);
  assert(workBlock?.kind === 'work', 'Synthetic execution block was not persisted');
  const rowIds = selector => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row => row.dataset.taskId)`);
  async function waitForRows(selector, ids) {
    if (await until(`${JSON.stringify(ids)}.every(id => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(row => row.dataset.taskId === id))`)) return;
    throw Error(`${selector}: open tasks that need attention disappeared`);
  }
  async function verifyTodayRows() {
    await waitForRows('.a2-task-row', [attentionTasks.overdue.id, attentionTasks.ended.id, attentionTasks.work.id]);
    for (const reason of ['overdue', 'ended']) assert(await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.a2-task-row')).find(row => row.dataset.taskId === ${JSON.stringify(attentionTasks[reason].id)});
      return row?.dataset.attention === ${JSON.stringify(reason)} && row.classList.contains('warn') && !!row.querySelector('.a2-task-meta .warn')?.textContent.trim();
    })()`), `today: ${reason} task lost its visible attention status`);
    assert(!(await rowIds('.a2-task-row')).includes(attentionTasks.done.id), 'today: completed task leaked back into open tasks');
  }
  // The unscheduled drawer keeps overdue and ended tasks, but not ones with a session still ahead or already done.
  async function verifyDrawer() {
    await waitForRows('.a2-drawer .a2-card', [attentionTasks.overdue.id, attentionTasks.ended.id]);
    const ids = await rowIds('.a2-drawer .a2-card');
    assert(!ids.includes(attentionTasks.work.id) && !ids.includes(attentionTasks.done.id), 'drawer: scheduled or completed task leaked into 未安排');
    assert(await evaluate(`document.querySelector('.a2-drawer .a2-card[data-task-id=${JSON.stringify(attentionTasks.ended.id)}] .cm').textContent.includes('安排已结束')`), 'drawer: ended task lost its 安排已结束 status');
  }
  async function expectBlockEditor(task, day, kind, from) {
    await until('!!document.querySelector("[role=dialog] input[name=start]")', 50, 50);
    assert(await evaluate(`(() => {
      const dialog = document.querySelector('[role=dialog]');
      return dialog?.querySelector('h2')?.textContent === '编辑时段'
        && dialog.querySelector('[name=start]')?.value === ${JSON.stringify(`${day}T10:00`)}
        && dialog.querySelector('[name=end]')?.value === ${JSON.stringify(`${day}T10:30`)}
        && dialog.querySelector('[name=kind]')?.value === ${JSON.stringify(kind)}
        && dialog.querySelector('[name=taskId]')?.value === ${JSON.stringify(task.id)};
    })()`), `${from}: opened a new draft or lost the existing session time`);
  }
  await nav('今天');
  await verifyTodayRows();
  assert(await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.a2-task-row')).find(row => row.dataset.taskId === ${JSON.stringify(attentionTasks.work.id)});
    const button = Array.from(row?.querySelectorAll('button') ?? []).find(button => button.textContent.trim() === '查看安排');
    if (!button) return false; button.click(); return true;
  })()`), 'today: scheduled execution task did not offer 查看安排');
  await expectBlockEditor(attentionTasks.work, workDay, 'work', 'today 查看安排');
  await evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]'), location = dialog.querySelector('[name=location]');
    location.value = '合成验收调整后的地点'; location.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(dialog.querySelectorAll('button')).find(button => button.textContent.trim() === '保存').click();
    return true;
  })()`);
  for (let i = 0; i < 50; i++) { if (!(await evaluate('!!document.querySelector("[role=dialog]")'))) break; await wait(100); }
  const afterWorkEdit = (await evaluate('window.planner.snapshot()')).data;
  assert(!(await evaluate('!!document.querySelector("[role=dialog]")')) && afterWorkEdit.blocks.length === beforeWorkEdit.blocks.length
    && afterWorkEdit.blocks.filter(block => block.taskId === attentionTasks.work.id).length === 1
    && afterWorkEdit.blocks.find(block => block.id === workBlock.id)?.location === '合成验收调整后的地点'
    && afterWorkEdit.blocks.find(block => block.id === workBlock.id)?.version === workBlock.version + 1,
  'Saving 查看安排 did not update the original execution block, or created a duplicate');
  await nav('日历');
  await verifyDrawer();
  // Drawer card → task detail popover → 调整时间 reopens the ended session instead of drafting a new one.
  await evaluate(`document.querySelector('.a2-drawer .a2-card[data-task-id=${JSON.stringify(attentionTasks.ended.id)}] button.ct').click(); true`);
  assert(await until(`!!document.querySelector('aside[aria-label="任务详情"] [aria-label="已安排活动"]')`, 50, 50), 'drawer: task detail popover did not list its arrangement');
  await evaluate(`Array.from(document.querySelectorAll('aside[aria-label="任务详情"] [aria-label="已安排活动"] button')).find(button => button.textContent.trim() === '调整时间').click(); true`);
  await expectBlockEditor(attentionTasks.ended, endedDay, 'event', 'drawer 调整时间');
  assert(await evaluate('!document.querySelector(".a2-drawer")'), 'Edit panel did not take the drawer\'s place');
  await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent.trim() === '取消').click(); true`);
  assert(await until('!document.querySelector("[role=dialog] input[name=start]") && !!document.querySelector(".a2-drawer")', 50, 50), 'Cancelling the edit panel did not bring the drawer back');
  assert(JSON.stringify((await evaluate('window.planner.snapshot()')).data.blocks) === JSON.stringify(afterWorkEdit.blocks), 'Cancelling the calendar editor changed an existing session');
  await writeFile(join(profile, 'attention-task-rail.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const workEditUndo = await evaluate('window.planner.undo()');
  assert(workEditUndo.ok && workEditUndo.data.status === 'applied', 'Actual execution edit could not be undone');
  for (const transactionId of fixtureTransactions.reverse()) {
    const result = await evaluate(`window.planner.undo(${JSON.stringify(transactionId)})`);
    assert(result.ok && result.data.status === 'applied', 'Synthetic attention fixture cleanup could not be undone');
  }
  const afterAttentionCleanup = (await evaluate('window.planner.snapshot()')).data;
  assert(afterAttentionCleanup.blocks.length === 0 && afterAttentionCleanup.tasks.length === 1 && afterAttentionCleanup.tasks[0].id === recurringTask.id,
    'Attention smoke left synthetic fixtures in the persistence test');
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
  console.log(JSON.stringify({ ok: true, actualMain: true, sandboxPreload: true, ledgerCreateCorrectQueryUndo: true, ledgerIdempotencyAndPersistence: true, ledgerSidebarChartsAndDetailUI: true, recurringPreviewConfirmUndo: true, recurringScopeEditsAndCancellationUndo: true, recurringStableIdentityAndOrdinaryTaskIsolation: true, overdueAndEndedOpenTasksRemainVisible: true, scheduledWorkReusesExistingEditor: true, scheduledWorkSaveDoesNotDuplicate: true, gracefulQuitBeforeRestart: true, twoLaunchPersistence: true, savedCredentialRecovery: true, persistentUndo: true, syntheticEncryptedRoundtrip: true, rendererHasNoNode: true, profile }, null, 2));
  await writeFile(join(reportDirectory, 'smoke-result.json'), JSON.stringify({ ok: true, executable, profile, ledgerCreateCorrectQueryUndo: true, ledgerIdempotencyAndPersistence: true, ledgerSidebarChartsAndDetailUI: true, recurringScopeEditsAndCancellationUndo: true, recurringStableIdentityAndOrdinaryTaskIsolation: true, overdueAndEndedOpenTasksRemainVisible: true, scheduledWorkReusesExistingEditor: true, scheduledWorkSaveDoesNotDuplicate: true, gracefulQuitBeforeRestart: true, twoLaunchPersistence: true, savedCredentialRecovery: true, syntheticEncryptedRoundtrip: true, diagnostics: diagnostics.join('').slice(-3000) }, null, 2));
} catch (error) { console.error(error.message); console.error(diagnostics.join('').replaceAll(secret, '[synthetic]').slice(-5000)); process.exitCode = 1; }
finally { await stop(); for (const client of qqServer.clients) client.terminate(); await new Promise(resolve => qqServer.close(resolve)); }
