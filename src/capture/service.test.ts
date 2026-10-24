import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { createCaptureService, normalizeMessage, fromUnix } from './service';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';
import { AttachmentDownloadError } from './download';
import { detectExistingBridge } from './bridge';
vi.mock('./bridge', async importOriginal => ({ ...await importOriginal<typeof import('./bridge')>(), detectExistingBridge: vi.fn(async () => []) }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.mocked(detectExistingBridge).mockReset().mockResolvedValue([]); });
async function waitFor(check: () => boolean) { for (let n = 0; n < 150; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Expected state did not arrive'); }
async function setup(fetcher: typeof fetch = async () => { throw Error('AI must not be called'); }, overrides: Partial<Parameters<typeof createCaptureService>[0]> = {}, read?: (request: { action: string; params: Record<string, unknown> }) => unknown) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let socket: WebSocket | undefined; const actions: string[] = [];
  server.on('connection', next => { socket = next; next.on('message', buffer => {
    const request = JSON.parse(buffer.toString()); actions.push(request.action);
    const data = read?.(request) ?? (request.action === 'get_status' ? { online: true, good: true } : request.action === 'get_login_info' ? { user_id: '100', nickname: '合成测试' } : request.action === 'get_group_list' ? [{ group_id: '200', group_name: '合成课程群' }] : request.action === 'get_group_msg_history' ? { messages: [] } : {});
    next.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }));
  }); });
  const dir = mkdtempSync(join(tmpdir(), 'calendar-capture-service-')); const path = join(dir, 'planner.sqlite'); const repository = createRepository(path); const store = createCaptureStore(path);
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port');
  store.saveConfig({ ...store.config(), endpoint: `ws://127.0.0.1:${address.port}`, analysisEnabled: false });
  const service = createCaptureService({ store, repository, credentials: { get: async () => 'test-token', set: async () => {}, status: () => ({ configured: true }) }, getApiKey: async () => 'synthetic-api', extract: async () => ({ parts: [], warnings: [], status: 'ready' }), fetch: fetcher, ...overrides });
  cleanups.push(async () => { service.stop(); await waitFor(() => !service.busy()); store.close(); repository.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  await service.connect(); await service.groups();
  const send = (messageId: string, group = '200') => socket!.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: '100', group_id: group, user_id: '300', message_id: messageId, time: Date.now() / 1000, message: [{ type: 'text', data: { text: '明天交报告' } }] }));
  return { service, store, repository, send, actions };
}
describe('capture orchestration against real local OneBot websocket', () => {
  it('keeps self, other and all mention identities in normalized text', () => {
    const message = normalizeMessage({ group_id: '200', message_id: 'recipients', time: Date.now() / 1000,
      message: [{ type: 'at', data: { qq: '100' } }, { type: 'at', data: { qq: '300' } }, { type: 'at', data: { qq: 'all' } }] }, '100', new Map());
    expect(message?.text).toBe('@我@其他成员@全体成员');
    expect(message?.segments).toHaveLength(3);
  });
  it('collects messages addressed only to others without downloading their attachments or calling AI', async () => {
    const downloader = vi.fn(async () => { throw Error('not needed'); });
    const extract = vi.fn(async () => { throw Error('not needed'); });
    const getApiKey = vi.fn(async () => 'synthetic-api');
    const fetcher = vi.fn(async () => { throw Error('not needed'); });
    const { service, store, repository } = await setup(fetcher, { downloader, extract, getApiKey });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); await waitFor(() => !service.busy());
    store.ingest([normalizeMessage({ group_id: '200', message_id: 'another-person-file', time: Date.now() / 1000,
      message: [{ type: 'at', data: { qq: '300' } }, { type: 'text', data: { text: '请你提交附件' } }, { type: 'file', data: { file_id: 'synthetic-file', name: '材料.pdf' } }] }, '100', new Map())!]);
    await service.configure({ ...store.config(), enabled: false, analysisEnabled: true }); await waitFor(() => !service.busy());
    service.action({ action: 'analyze' }); await waitFor(() => store.listBatches().items[0]?.status === 'applied' && !service.busy());
    expect(downloader).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(getApiKey).not.toHaveBeenCalled();
    expect(store.stats().messages).toBe(1); expect(repository.snapshot().candidates).toHaveLength(0);
  });
  it('requires account/group opt-in, deduplicates and labels empty historical responses as partial', async () => {
    const { service, store, send, actions } = await setup();
    expect(service.snapshot()).toMatchObject({ accountName: '合成测试', config: { accountId: '100', enabled: false, groupIds: [] } });
    send('before'); await new Promise(r => setTimeout(r, 30)); expect(store.stats().messages).toBe(0);
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] });
    send('1'); send('1'); send('unselected', '999');
    await waitFor(() => store.stats().messages === 1 && !service.busy());
    expect(store.listCoverage()[0]?.status).toBe('partial'); expect(actions).not.toContain('send_group_msg'); expect(JSON.stringify(service.snapshot())).not.toContain('test-token');
    await service.configure({ ...store.config(), enabled: false }); send('paused'); await new Promise(r => setTimeout(r, 30)); expect(store.stats().messages).toBe(1);
  });
  it('uses persisted SnowLuma pagination for manual connections and service restarts', async () => {
    const pages: Record<string, unknown>[] = []; const now = Date.now() / 1000;
    const { service, store } = await setup(undefined, {}, request => {
      if (request.action !== 'get_group_msg_history') return undefined;
      pages.push(request.params);
      return { messages: [{ group_id: '200', message_id: request.params.message_id ? 'older' : 'cursor-message', message_seq: 'unrelated-sequence', time: now - (request.params.message_id ? 8 * 86400 : 60), message: [] }] };
    });
    await service.configure({ ...store.config(), flavor: 'snowluma' });
    expect(service.snapshot().connection).toBe('disconnected');
    await service.connect(); await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); await waitFor(() => !service.busy());
    expect(pages).toEqual([{ group_id: '200', count: 100, reverse_order: true }, { group_id: '200', count: 100, reverse_order: true, message_id: 'cursor-message' }]);
    service.stop(); await service.start(); await waitFor(() => !service.busy());
    expect(pages.slice(2)).toEqual(pages.slice(0, 2));
    expect(detectExistingBridge).not.toHaveBeenCalled();
  });
  it('persists detected flavor and retains it when later reconnecting without configuration detection', async () => {
    const { service, store } = await setup();
    vi.mocked(detectExistingBridge).mockResolvedValue([{ endpoint: store.config().endpoint, token: 'detected-synthetic-token', flavor: 'snowluma', source: 'SnowLuma' }]);
    await service.connect({ detect: true }); expect(store.config().flavor).toBe('snowluma');
    vi.mocked(detectExistingBridge).mockClear().mockResolvedValue([]);
    await service.connect(); expect(service.snapshot().config.flavor).toBe('snowluma'); expect(detectExistingBridge).not.toHaveBeenCalled();
  });
  it('pauses queued analysis before manual or detected bridge changes and preserves pending attachments', async () => {
    const getApiKey = vi.fn(async () => 'synthetic-api');
    const { service, store } = await setup(undefined, { getApiKey });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); await waitFor(() => !service.busy());
    store.ingest([normalizeMessage({ group_id: '200', message_id: 'queued-file', time: Date.now() / 1000,
      message: [{ type: 'text', data: { text: '请读取附件' } }, { type: 'file', data: { file_id: 'file-1', name: '合成通知.pdf' } }],
    }, '100', new Map())!]);
    const batch = store.sealBatches({ force: true })[0]!;
    store.saveConfig({ ...store.config(), analysisEnabled: true });
    const manual = await service.configure({ ...store.config(), flavor: 'snowluma' });
    expect(manual.config).toMatchObject({ enabled: false, analysisEnabled: false });
    expect(store.batch(batch.id)?.status).toBe('pending'); expect(store.listMessages().items[0]?.attachments[0]?.status).toBe('pending');
    expect(service.busy()).toBe(false); expect(getApiKey).not.toHaveBeenCalled();
    await service.connect(); expect(service.snapshot().connection).toBe('online');
    expect(service.snapshot().config.analysisEnabled).toBe(false);
    store.saveConfig({ ...store.config(), analysisEnabled: true });
    vi.mocked(detectExistingBridge).mockResolvedValue([{ endpoint: store.config().endpoint, token: 'detected-synthetic-token', flavor: 'napcat' }]);
    await service.connect({ detect: true });
    expect(service.snapshot().config).toMatchObject({ flavor: 'napcat', enabled: false, analysisEnabled: false });
    expect(store.batch(batch.id)?.status).toBe('pending'); expect(store.listMessages().items[0]?.attachments[0]?.status).toBe('pending');
    expect(getApiKey).not.toHaveBeenCalled();
  });
  it('disconnects and clears active authorization while preserving credentials and collected data', async () => {
    const credentials = { get: vi.fn(async () => 'saved-synthetic-token'), set: vi.fn(async () => {}), status: () => ({ configured: true }) };
    const { service, store, send } = await setup(undefined, { credentials });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); send('retained'); await waitFor(() => store.stats().messages === 1 && !service.busy());
    const result = service.action({ action: 'disconnect' });
    expect(result).toMatchObject({ connection: 'disconnected', accountName: null, accountLabel: null, credentialConfigured: true, config: { enabled: false, analysisEnabled: false, accountId: null, groupIds: [] } });
    expect(store.stats().messages).toBe(1); expect(credentials.set).not.toHaveBeenCalled();
    await service.connect(); expect(service.snapshot()).toMatchObject({ accountName: '合成测试', config: { accountId: '100', enabled: false, groupIds: [] } });
  });
  it('unknown API response is parked after one request and requires explicit retry', async () => {
    let calls = 0; const { service, store, send } = await setup(async () => { calls++; throw Error('interrupted'); });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); send('1');
    await waitFor(() => store.stats().messages === 1 && !service.busy());
    await service.configure({ ...store.config(), enabled: false, analysisEnabled: true }); await waitFor(() => !service.busy());
    service.action({ action: 'analyze' }); await waitFor(() => !service.busy());
    expect(calls).toBe(1); expect(store.listBatches().items[0]?.status).toBe('uncertain');
    service.action({ action: 'analyze' }); await waitFor(() => !service.busy()); expect(calls).toBe(1);
  });
  it('rejects groups not returned by the authenticated account', async () => {
    const { service, store } = await setup(); await expect(service.configure({ ...store.config(), enabled: true, groupIds: ['999'] })).rejects.toMatchObject({ code: 'VALIDATION' }); expect(store.config().groupIds).toEqual([]);
  });
  it('preserves file/quote locators internally and never mistakes voice/video as text', () => {
    const message = normalizeMessage({ group_id: '200', message_id: '1', time: 1792713600, message: [{ type: 'text', data: { text: '请看文件' } }, { type: 'file', data: { name: '作业.pdf', file_id: 'file-1', size: 300 } }, { type: 'record', data: { file: 'voice' } }, { type: 'reply', data: { id: 'old' } }] }, '100', new Map());
    expect(message?.text).toBe('请看文件'); expect(message?.attachments?.map(a => a.kind)).toEqual(['file', 'voice', 'other']); expect(message?.attachments?.[0]?.locator).toMatchObject({ data: { file_id: 'file-1' } });
  });
  it('catches up newest disconnected messages before resuming a saved older cursor', async () => {
    let resumed = false; const cursors: unknown[] = []; const now = Date.now() / 1000;
    const { service, store } = await setup(undefined, {}, request => {
      if (!resumed || request.action !== 'get_group_msg_history') return undefined;
      cursors.push(request.params.message_seq);
      return { messages: request.params.message_seq === 'older-frontier' ? [{ group_id: '200', message_id: 'ancient', time: now - 8 * 86400, message: [] }] : [
        { group_id: '200', message_id: 'newest', time: now - 60, message: [{ type: 'text', data: { text: '断线期间新通知' } }] },
        { group_id: '200', message_id: 'head-overlap', time: now - 7200, message: [] },
      ] };
    });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); await waitFor(() => !service.busy());
    store.saveCoverage({ accountId: '100', groupId: '200', status: 'partial', windowStart: fromUnix(now - 7 * 86400)!, windowEnd: fromUnix(now - 3600)!, earliestAt: null, cursor: 'older-frontier', fetchedCount: 0, updatedAt: fromUnix(now)!, error: 'synthetic partial' });
    resumed = true; service.action({ action: 'backfill' }); await waitFor(() => !service.busy());
    expect(cursors).toEqual([undefined, 'older-frontier']); expect(store.messageByKey('100', '200', 'newest')?.text).toBe('断线期间新通知'); expect(store.listCoverage()[0]?.status).toBe('complete');
  });
  it('keeps paused preparation pending and resumes it without a hidden request during the pause', async () => {
    let release: ((value: string) => void) | undefined, calls = 0, pauseKey = true;
    const { service, store, send } = await setup(async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }, { getApiKey: async () => pauseKey ? new Promise<string>(resolve => { release = resolve; }) : 'synthetic' });
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); send('paused-analysis'); await waitFor(() => store.stats().messages === 1 && !service.busy());
    await service.configure({ ...store.config(), enabled: false, analysisEnabled: true }); await waitFor(() => !service.busy());
    service.action({ action: 'analyze' }); await waitFor(() => !!release);
    expect(() => service.action({ action: 'disconnect' })).toThrow('仍在处理');
    expect(store.config().accountId).toBe('100');
    await service.configure({ ...store.config(), analysisEnabled: false }); release!('synthetic'); await waitFor(() => !service.busy());
    expect(calls).toBe(0); expect(store.listBatches().items[0]?.status).toBe('pending');
    pauseKey = false; await service.configure({ ...store.config(), analysisEnabled: true }); await waitFor(() => !service.busy());
    expect(calls).toBe(1); expect(store.listBatches().items[0]?.status).toBe('applied');
  });
  it('labels message and attachment limits rather than silently truncating them', () => {
    const message = normalizeMessage({ group_id: '200', message_id: 'long', time: Date.now() / 1000, message: Array.from({ length: 1001 }, () => ({ type: 'file', data: { name: 'x'.repeat(2000), file_id: 'file' } })) }, '100', new Map());
    expect(message?.attachments).toHaveLength(100); expect(message?.attachments?.[0]?.name.length).toBe(1000);
    expect(message?.text).toContain('超过 1000'); expect(message?.text).toContain('附件超过 100');
  });
  it('preserves safe attachment failure details and statuses through the capture UI data', async () => {
    const { service, store } = await setup(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })), {
      downloader: async () => { throw new AttachmentDownloadError('附件超过自动下载的大小上限', 'too-large'); },
    }, request => request.action === 'get_group_file_url' ? { url: 'https://gchat.qpic.cn/synthetic.pdf' } : undefined);
    await service.configure({ ...store.config(), enabled: true, groupIds: ['200'] }); await waitFor(() => !service.busy());
    store.ingest([normalizeMessage({ group_id: '200', message_id: 'file-failure', time: Date.now() / 1000, message: [{ type: 'text', data: { text: '合成文件通知' } }, { type: 'file', data: { file_id: 'file-1', name: '通知.pdf' } }] }, '100', new Map())!]);
    await service.configure({ ...store.config(), enabled: false, analysisEnabled: true }); await waitFor(() => !service.busy());
    service.action({ action: 'analyze' }); await waitFor(() => !service.busy());
    expect(store.listMessages().items[0]?.attachments[0]).toMatchObject({ status: 'too-large', error: '附件超过自动下载的大小上限' });
  });
});
