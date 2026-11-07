import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWechatBridgeFactory } from './wechat-bridge';
import { createCaptureService } from './service';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
const accountId = 'wechat:wxid_synthetic', groupId = 'synthetic@chatroom';
async function until(check: () => boolean) {
  for (let n = 0; n < 150; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Synthetic reader did not settle');
}
function fixture(errorCode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'uc-wechat-reconnect-'));
  const worker = join(dir, 'worker.mjs'), ready = join(dir, 'ready'), trace = join(dir, 'trace.jsonl');
  writeFileSync(worker, `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const log = event => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(event)+'\\n');
log({event:'start'});
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line), ready = existsSync(${JSON.stringify(ready)});
  log({event:'request',action:request.action,accountId:request.accountId,ready});
  const data = request.action === 'status' ? {accountId:${JSON.stringify(accountId)},nickname:'合成微信'}
    : request.action === 'groups' ? [{id:${JSON.stringify(groupId)},name:'合成群'}]
    : {messages:[],nextCursor:null,complete:false};
  const result = ready ? {id:request.id,ok:true,data}
    : {id:request.id,ok:false,error:{code:${JSON.stringify(errorCode)},message:'PRIVATE_ERROR_NEVER_SHOW'}};
  process.stdout.write(JSON.stringify(result)+'\\n');
});
lines.on('close', () => log({event:'closed'}));
`);
  const records = (): { event: string; action?: string; accountId?: string; ready?: boolean }[] => existsSync(trace)
    ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const path = join(dir, 'planner.sqlite'), repository = createRepository(path, { automaticBackup: () => {} });
  const store = createCaptureStore(path, { platform: 'wechat' });
  store.saveConfig({ ...store.config(), accountId, groupIds: [groupId], enabled: true, analysisEnabled: true });
  const getToken = vi.fn(async () => { throw Error('WeChat must not read QQ credentials'); });
  const service = createCaptureService({ platform: 'wechat', store, repository,
    bridgeFactory: createWechatBridgeFactory({ python: process.execPath, worker, workdir: dir, requestTimeoutMs: 2000 }),
    credentials: { get: getToken, set: async () => {}, status: () => ({ configured: false }) },
    getApiKey: async () => null, extract: async () => { throw Error('No documents to extract'); },
    fetch: async () => { throw Error('AI must not be called'); },
  });
  cleanups.push(async () => {
    service.stop(); await until(() => !service.busy() && records().filter(r => r.event === 'start').length === records().filter(r => r.event === 'closed').length);
    store.close(); repository.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { service, store, records, getToken, ready: () => writeFileSync(ready, 'synthetic login ready') };
}

describe('WeChat startup recovery without changing authorization', () => {
  it.each(['ACCOUNT_SELECTION_REQUIRED', 'IDENTITY_UNAVAILABLE'])('automatically retries %s with the original account and group selection', async errorCode => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-07T08:00:00+08:00'));
    const f = fixture(errorCode);
    await f.service.start();
    expect(f.service.snapshot()).toMatchObject({ connection: 'error', config: { accountId, groupIds: [groupId], enabled: true, analysisEnabled: true } });
    expect(f.service.snapshot().error).toContain('自动重试');
    expect(JSON.stringify(f.service.snapshot())).not.toContain('PRIVATE_ERROR_NEVER_SHOW');
    // Keep it unavailable through one poll, then recover solely through the existing timer.
    await vi.advanceTimersByTimeAsync(5000); await until(() => !f.service.busy());
    expect(f.records().filter(r => r.event === 'start')).toHaveLength(2);
    f.ready();
    await vi.advanceTimersByTimeAsync(115_000);
    expect(f.records().filter(r => r.event === 'start')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000); await until(() => !f.service.busy() && f.service.snapshot().connection === 'online');
    expect(f.service.snapshot()).toMatchObject({ connection: 'online', config: { accountId, groupIds: [groupId], enabled: true, analysisEnabled: true } });
    expect(f.records().filter(r => r.event === 'start')).toHaveLength(3);
    const requests = f.records().filter(r => r.event === 'request');
    expect(requests.every(r => r.accountId === accountId)).toBe(true);
    expect(requests.filter(r => !r.ready).every(r => r.action === 'status')).toBe(true);
    expect(requests.some(r => r.ready && r.action === 'history')).toBe(true);
    expect(f.getToken).not.toHaveBeenCalled();
  });

  it('keeps a verified changed account disabled and never reads its groups or messages', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-07T08:00:00+08:00'));
    const f = fixture('ACCOUNT_CHANGED');
    await f.service.start();
    expect(f.service.snapshot()).toMatchObject({ connection: 'account-changed', config: { accountId, groupIds: [groupId], enabled: false, analysisEnabled: false } });
    f.ready(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.records().filter(r => r.event === 'start')).toHaveLength(1);
    expect(f.records().filter(r => r.event === 'request').map(r => r.action)).toEqual(['status']);
    expect(f.service.snapshot().connection).toBe('account-changed');
  });
});
