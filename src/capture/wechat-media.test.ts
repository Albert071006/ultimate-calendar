import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWechatMediaLocation } from './wechat-media';
import { downloadAttachment } from './download';
import { createWechatBridgeFactory } from './wechat-bridge';
import { createCaptureService } from './service';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';
import { extractDocument } from './documents';
import { fixtureDocx, PIXEL_PNG } from './documents/fixtures';
import { instantAt } from '../domain/time';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean) { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw Error('Synthetic media reader did not finish'); }
function directory() { const path = mkdtempSync(join(tmpdir(), 'uc-wechat-media-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }
const metadata = (path: string, bytes: Buffer) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const account = 'wechat:wxid_media_test', group = 'media@chatroom';

async function pipeline(errorCode?: string, oldPaidPlaceholder = false, onlyImageFails = false) {
  const root = directory(), workdir = join(root, 'cache'), media = join(workdir, 'reader-synthetic', 'media'); mkdirSync(media, { recursive: true });
  const imagePath = join(media, 'image.png'), docPath = join(media, 'document.docx');
  const docx = fixtureDocx(); writeFileSync(imagePath, PIXEL_PNG); writeFileSync(docPath, docx);
  const responses = { image: { ...metadata(imagePath, PIXEL_PNG), name: '图片通知.png', status: 'ready' }, file: { ...metadata(docPath, docx), name: '合成通知.docx', status: 'ready' } };
  const ready = join(root, 'ready'), closed = join(root, 'closed'), worker = join(root, 'worker.mjs');
  if (!errorCode) writeFileSync(ready, 'ready');
  const sentAt = instantAt(Date.now() - 60_000);
  writeFileSync(worker, `import { createInterface } from 'node:readline'; import { existsSync, writeFileSync } from 'node:fs';
const results = ${JSON.stringify(responses)};
const lines = createInterface({input:process.stdin});
lines.on('line', line => { const q=JSON.parse(line); let data;
 if(q.action==='status') data={accountId:${JSON.stringify(account)},nickname:'合成微信'};
 else if(q.action==='groups') data=[{id:${JSON.stringify(group)},name:'合成媒体群'}];
 else if(q.action==='history') data={messages:['image','file'].map((kind,index)=>({self_id:${JSON.stringify(account)},group_id:q.groupId,message_id:'s:'+index,time:${Date.parse(sentAt) / 1000},message_type:'group',message:[{type:kind,data:{file:'wm1:'+kind,name:results[kind].name}}]})),nextCursor:null,complete:false};
 else if(q.action==='media') {if(q.messageId !== (q.kind==='image'?'s:0':'s:1')) throw Error('Wrong original message'); if(!existsSync(${JSON.stringify(ready)}) && (!${onlyImageFails} || q.kind==='image')) {process.stdout.write(JSON.stringify({id:q.id,ok:false,error:{code:${JSON.stringify(errorCode ?? 'NOT_DOWNLOADED')},message:'PRIVATE_MEDIA_PATH'}})+'\\n');return;} data=results[q.kind];}
 process.stdout.write(JSON.stringify({id:q.id,ok:true,data})+'\\n');
}); lines.on('close',()=>writeFileSync(${JSON.stringify(closed)},'closed'));`);
  const repository = createRepository(join(root, 'planner.sqlite'), { automaticBackup: () => {} }); cleanups.push(() => repository.close());
  const store = createCaptureStore(repository.path, { platform: 'wechat' }); cleanups.push(() => store.close());
  let previousBatch: ReturnType<typeof store.batch> = null;
  if (oldPaidPlaceholder) {
    store.saveConfig({ ...store.config(), accountId: account, groupIds: [group], enabled: true });
    store.ingest([{ accountId: account, groupId: group, messageId: 's:0', sentAt, text: '请按图片中的通知安排参加活动。', attachments: [] }]);
    const batch = store.sealBatches({ force: true })[0]!;
    store.claimBatch(); store.startAttempt(batch.id, 'legacy-paid'); store.saveResult(batch.id, { legacy: 'paid-text' }); store.markApplied(batch.id);
    previousBatch = store.batch(batch.id);
  }
  store.saveConfig({ ...store.config(), analysisEnabled: false });
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const wire = JSON.parse(String(init?.body)); requests.push(wire);
    const content = wire.messages.find((m: any) => m.role === 'user').content;
    const input = JSON.parse(content[0].text), units = input.units;
    const image = units.find((u: any) => u.hasImage), document = units.find((u: any) => u.text.includes('周五提交报告'));
    const values = [image && { unit: image, title: '参加合成图片通知活动', quote: '请参加合成图片活动' }, document && { unit: document, title: '提交合成报告', quote: '周五提交报告 & 实验记录' }].filter(Boolean).map(value => ({ title: value.title, action: value.title, benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [], sourceIds: [value.unit.id], sourceQuote: value.quote, deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: values }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const service = createCaptureService({ platform: 'wechat', store, repository, bridgeFactory: createWechatBridgeFactory({ python: process.execPath, worker, workdir, requestTimeoutMs: 2000 }), credentials: { get: async () => null, set: async () => {}, status: () => ({ configured: false }) }, getApiKey: async () => 'synthetic-key', getModelInputModalities: () => ['text', 'image'], extract: (input, signal) => extractDocument(input, { signal }), fetch: fetcher });
  cleanups.push(async () => { service.stop(); await until(() => !service.busy() && existsSync(closed)); });
  await service.connect(); await service.configure({ ...store.config(), groupIds: [group], enabled: true }); await until(() => !service.busy());
  const run = async () => { await service.configure({ ...store.config(), analysisEnabled: true }); await until(() => !service.busy()); service.action({ action: 'analyze' }); await until(() => !service.busy()); };
  return { root, workdir, store, repository, service, run, ready, requests, fetcher, sentAt, responses, previousBatch };
}

describe('WeChat bounded media extraction', () => {
  it('accepts only one-use local capabilities with bounded, unchanged bytes', async () => {
    const root = directory(), media = join(root, 'reader-one', 'media'); mkdirSync(media, { recursive: true });
    const path = join(media, 'notice.png'); writeFileSync(path, PIXEL_PNG);
    const capability = await readWechatMediaLocation(root, metadata(path, PIXEL_PNG));
    expect(await downloadAttachment(capability, { fileName: '通知.png' })).toEqual(PIXEL_PNG);
    await expect(downloadAttachment(capability, { fileName: '通知.png' })).rejects.toThrow();
    await expect(downloadAttachment({ ...capability }, { fileName: '通知.png' })).rejects.toThrow();
    await expect(readWechatMediaLocation(root, { ...metadata(path, PIXEL_PNG), sha256: '0'.repeat(64) })).rejects.toThrow();
    await expect(readWechatMediaLocation(root, { ...metadata(path, PIXEL_PNG), size: 26 * 1024 * 1024 })).rejects.toThrow();
  });

  it('rejects outside paths, junctions and hardlinks', async () => {
    const root = directory(), media = join(root, 'reader-one', 'media'); mkdirSync(media, { recursive: true });
    const external = join(root, 'external'); mkdirSync(external); const secret = join(external, 'secret.txt'); writeFileSync(secret, 'private');
    await expect(readWechatMediaLocation(root, metadata(secret, Buffer.from('private')))).rejects.toThrow('受限');
    linkSync(secret, join(media, 'linked.txt'));
    await expect(readWechatMediaLocation(root, metadata(join(media, 'linked.txt'), Buffer.from('private')))).rejects.toThrow('链接');
    const redirected = join(root, 'reader-redirect'); symlinkSync(external, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(external, 'media')); writeFileSync(join(external, 'media', 'leak.txt'), 'private');
    await expect(readWechatMediaLocation(root, metadata(join(redirected, 'media', 'leak.txt'), Buffer.from('private')))).rejects.toThrow('链接或重定向');
  });

  it('passes real PNG and DOCX through RPC, bounded download, actual parsers and fake AI into pending candidates', async () => {
    const f = await pipeline(); await f.run();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const content = f.requests[0].messages.find((m: any) => m.role === 'user').content;
    expect(content.some((part: any) => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${PIXEL_PNG.toString('base64')}`)).toBe(true);
    expect(content[0].text).toContain('周五提交报告 & 实验记录');
    expect(f.repository.snapshot().candidates).toHaveLength(2);
    expect(f.repository.snapshot().candidates.every(candidate => candidate.status === 'pending')).toBe(true);
    expect(f.repository.snapshot().tasks).toEqual([]);
    expect(f.store.listBatches().items[0]?.status).toBe('applied');
    expect(f.repository.snapshot().sources.every(source => Date.parse(source.sentAt!) === Date.parse(f.sentAt))).toBe(true);
    expect(JSON.stringify(f.repository.snapshot())).not.toContain(f.workdir);
  });

  it.each(['NOT_DOWNLOADED', 'IMAGE_KEY_UNAVAILABLE'])('does not pay or apply placeholder-only results and retries %s', async code => {
    const f = await pipeline(code); await f.run();
    const batch = f.store.listBatches().items[0]!;
    expect(batch.status).toBe('failed'); expect(batch.attemptCount).toBe(0); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.store.batch(batch.id)?.waitingForAttachments).toBe(true);
    expect(batch.error).not.toContain('PRIVATE_MEDIA_PATH');
    writeFileSync(f.ready, 'ready'); expect(f.store.retryWaitingAttachments()).toBe(2);
    f.service.action({ action: 'analyze' }); await until(() => !f.service.busy());
    expect(f.store.batch(batch.id)?.status).toBe('applied'); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['NOT_DOWNLOADED', 'UNSUPPORTED'])('isolates %s media without blocking readable messages or marking unread media applied', async code => {
    const f = await pipeline(code, false, true); await f.run();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const batches = f.store.listBatches().items;
    expect(batches.filter(batch => batch.status === 'applied')).toHaveLength(1);
    expect(batches.filter(batch => batch.status === 'failed')).toHaveLength(1);
    const failed = f.store.batch(batches.find(batch => batch.status === 'failed')!.id)!;
    expect(failed.attempts).toEqual([]); expect(failed.waitingForAttachments).toBe(code === 'NOT_DOWNLOADED');
    expect(f.store.batchMessages(failed.id).map(message => message.messageId)).toEqual(['s:0']);
    expect(f.repository.snapshot().candidates.map(candidate => candidate.title)).toContain('提交合成报告');
    const missingMessageId = f.store.batchMessages(failed.id)[0]!.id;
    expect(f.repository.snapshot().sources.every(source => source.captureRef?.messageId !== missingMessageId)).toBe(true);
    expect(f.store.exportState().state.batches.every(batch => batch.messageIds.length === 1)).toBe(true);
  });

  it('reads new media on old paid messages using the original RPC identity without charging the old text again', async () => {
    const f = await pipeline(undefined, true); await f.run();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.store.batch(f.previousBatch!.id)).toEqual(f.previousBatch);
    const content = f.requests[0].messages.find((m: any) => m.role === 'user').content;
    const input = JSON.parse(content[0].text);
    expect(input.units.every((unit: any) => !unit.text.includes('请按图片中的通知'))).toBe(true);
    expect(content[0].text).toContain('请按图片中的通知安排参加活动。');
    expect(f.repository.snapshot().candidates).toHaveLength(2);
    expect(f.repository.snapshot().sources.every(source => Date.parse(source.sentAt!) === Date.parse(f.sentAt))).toBe(true);
    expect(JSON.stringify(f.repository.snapshot())).not.toContain('sourceMessageId');
    f.service.action({ action: 'backfill' }); await until(() => !f.service.busy());
    f.service.action({ action: 'analyze' }); await until(() => !f.service.busy());
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['UNSUPPORTED', 'TOO_LARGE'])('requires manual handling for %s instead of infinite automatic retries', async code => {
    const f = await pipeline(code); await f.run(); const batch = f.store.listBatches().items[0]!;
    expect(batch.status).toBe('failed'); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.store.batch(batch.id)?.waitingForAttachments).toBe(false); expect(f.store.retryWaitingAttachments()).toBe(0);
  });
});
