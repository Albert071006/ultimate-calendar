import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRemoteService } from '../src/server/service';
import { createRemoteHttpServer } from '../src/server/http';
import { createPushStore } from '../src/server/push-store';
import { createPushHttpExtension } from '../src/server/push-http';
import type { MutationRequestInput } from '../src/shared/contracts';

// A separate synthetic profile. Never imports the Windows application's real data or API key.
const root = resolve('test-results'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'mobile-preview-'));
const service = createRemoteService({ dataDirectory: join(directory, 'data'), backupDirectory: join(directory, 'backups'), getApiKey: async () => null });
const seeder = service.state.pair(service.state.createPairingCode(), '虚构演示资料');
async function mutate(mutations: MutationRequestInput['mutations']) {
  const input = { operationId: crypto.randomUUID(), origin: 'manual' as const, mutations, confirmed: false };
  const result = await service.rpc('mutate', { requestId: crypto.randomUUID(), identity: service.state.identity(), input }, seeder.device.id) as { ok: boolean; data?: { status: string; proposedRequest: MutationRequestInput; confirmationToken: string } };
  if (!result.ok) throw Error('演示资料建立失败');
  if (result.data?.status === 'preview') await service.rpc('mutate', { requestId: crypto.randomUUID(), identity: service.state.identity(), input: { ...result.data.proposedRequest, confirmed: true, confirmationToken: result.data.confirmationToken } }, seeder.device.id);
}
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
await mutate([
  { type: 'create', entity: 'task', values: { title: '整理本周学习笔记', description: '演示：选出三个还没弄懂的问题。', deadline: { date: today, time: '22:30' } } },
  { type: 'create', entity: 'task', values: { title: '买一本新的方格本', description: '演示：路过文具店时处理。' } },
  { type: 'create', entity: 'goal', values: { title: '循序渐进学好线性代数', description: '虚构演示目标', priority: 'high' } },
  { type: 'create', entity: 'block', values: { title: '图书馆专注时间', kind: 'work', start: `${today}T14:00:00+08:00`, end: `${today}T15:30:00+08:00`, location: '演示 · 图书馆' } },
  { type: 'create', entity: 'block', values: { title: '傍晚散步', kind: 'event', start: `${today}T18:00:00+08:00`, end: `${today}T18:30:00+08:00` } },
]);
service.state.revoke(seeder.device.id);
const store = createPushStore(join(directory, 'data', 'notifications.sqlite'));
const server = createRemoteHttpServer({ service, origin: 'http://127.0.0.1:3321', staticDirectory: resolve('dist'), extension: createPushHttpExtension({ store, publicKey: null }), onRevokeDevice: id => store.revokeDevice(id) });
await server.listen(3321);
process.stdout.write(`虚构资料预览已启动：http://127.0.0.1:3321\n配对码：${service.state.createPairingCode()}\n资料仅保存在 ${directory}\n未配置 AI 或推送；按 Ctrl+C 停止。\n`);
let closing = false;
async function stop() { if (closing) return; closing = true; await server.close(); store.close(); await service.close(); }
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
