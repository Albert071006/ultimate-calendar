import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { ReminderSchema, SnapshotSchema, type Snapshot } from '../shared/contracts';
import { RemoteIdentitySchema, type RemoteIdentity } from '../shared/remote';
import { readPrivate, writePrivate, privatePath } from '../remote/private-file';
import { createReminderScheduler, type ReminderRepository } from './notifications';
import { WorkflowError } from '../ai/deepseek';

const ReceiptSchema = z.strictObject({ version: z.literal(1), identity: RemoteIdentitySchema, receipts: z.array(ReminderSchema.shape.id).max(1_000_000) });
/** Desktop presentation state only; the authoritative planner snapshot stays in memory and on the cloud. */
export function createRemoteReminderScheduler(options: { directory: string; identity: RemoteIdentity }) {
  if (!isAbsolute(options.directory) || resolve(options.directory) === parse(resolve(options.directory)).root) throw Error('提醒状态目录必须是明确的独立资料目录');
  const identity = RemoteIdentitySchema.parse(options.identity), encoded = JSON.stringify(identity);
  const tag = createHash('sha256').update(encoded).digest('hex');
  const cursorPath = privatePath(join(options.directory, `cloud-reminder-cursor-${tag}.json`));
  const receiptPath = privatePath(join(options.directory, `cloud-reminder-receipts-${tag}.json`));
  let snapshot: Snapshot | undefined, initialized = false, initializing: Promise<void> | undefined;
  let receipts: string[] = [];
  const repository: ReminderRepository = {
    read: () => ({ receipts: [...receipts] }),
    snapshot() { if (!snapshot) throw new WorkflowError('NETWORK', '尚未取得云端日程，提醒检查等待资料加载。'); return snapshot; },
    claimReminders(values) {
      const sent = new Set(receipts), fresh = values.filter(value => !sent.has(value.id));
      for (const item of fresh) sent.add(item.id);
      const next = [...sent];
      writePrivate(receiptPath, JSON.stringify(ReceiptSchema.parse({ version: 1, identity, receipts: next })));
      receipts = next; return fresh;
    },
  };
  const scheduler = createReminderScheduler(repository, cursorPath);
  function initialize() {
    if (initialized) return Promise.resolve();
    if (initializing) return initializing;
    initializing = (async () => {
      const bytes = readPrivate(receiptPath, 32 * 1024 * 1024);
      if (bytes) {
        try {
          const saved = ReceiptSchema.parse(JSON.parse(bytes.toString('utf8')));
          if (JSON.stringify(saved.identity) !== encoded) throw Error();
          receipts = [...new Set(saved.receipts)];
        } catch { throw new WorkflowError('STORAGE', '本机提醒收据无法核验，已保留文件；未清空或重新发送历史提醒。'); }
      }
      await scheduler.initialize(); initialized = true;
    })().finally(() => { initializing = undefined; });
    return initializing;
  }
  return {
    initialize,
    updateSnapshot(value: Snapshot) { snapshot = SnapshotSchema.parse(value); },
    async check(now: string) { await initialize(); return snapshot ? scheduler.check(now) : []; },
    async acknowledge(ids: string[]) { await initialize(); return scheduler.acknowledge(ids); },
  };
}
