import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { REMOTE_READ_METHODS, RemoteIdentitySchema, RemoteMethodSchema, type RemoteMethod } from '../shared/remote';
import { remoteInputs, remoteOutputs } from '../server/protocol';
import { RemoteClientError, sameRemoteIdentity, type NodeRemoteClient } from './node-client';
import { privatePath, readPrivate, writePrivate } from './private-file';
import { receiptFiles, remoteReceiptScope, scopedReceiptFile, withReceiptLock } from './receipt-partitions';

const PendingSchema = z.strictObject({ requestId: z.string().uuid(), origin: z.string(), identity: RemoteIdentitySchema, deviceId: z.string().uuid(), method: RemoteMethodSchema,
  fingerprint: z.string(), operationId: z.string().optional() });
type Pending = z.infer<typeof PendingSchema>;
function normalized(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normalized);
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalized(value)]));
  return input;
}
function intent(input: unknown) { const value = input && typeof input === 'object' && !Array.isArray(input) ? { ...input, operationId: undefined } : input; return createHash('sha256').update(JSON.stringify(normalized(value)) ?? 'undefined').digest('hex'); }

/** Persist only a fingerprint and IDs, never original text/images. One unresolved write blocks later writes. */
export function createWriteJournal(client: NodeRemoteClient, file: string, pinnedScope?: string) {
  privatePath(file);
  const bytes = readPrivate(file, 16_384);
  let pending: Pending | null = bytes ? z.union([PendingSchema, z.null()]).parse(JSON.parse(bytes.toString('utf8'))) : null;
  let serial: Promise<unknown> = Promise.resolve();
  function locked<T>(work: () => Promise<T>) { const next = serial.then(work, work); serial = next.catch(() => {}); return next; }
  function save(value: Pending | null) { writePrivate(file, JSON.stringify(value)); pending = value; }
  async function verify() {
    const session = await client.getSession();
    if (pinnedScope && remoteReceiptScope(client.origin, session) !== pinnedScope) throw new RemoteClientError(409, '连接身份发生变化，未在其他分区发送或核对原操作');
    if (pending && (pending.origin !== client.origin || pending.deviceId !== session.deviceId || !sameRemoteIdentity(pending.identity, session.identity))) throw new RemoteClientError(409, '未核对操作属于原设备或资料代际，已阻止重放');
    return session;
  }
  const operation = (id: string) => pinnedScope ? client.operation(id, pinnedScope) : client.operation(id);
  return {
    rpc(method: RemoteMethod, input?: unknown, requiredOperationId?: string) {
      if (method === 'restoreConfirm') return Promise.reject(new RemoteClientError(400, '恢复确认不能进入自动核对或重放队列'));
      // Validate before reserving a durable request: invalid input must not leave an unresolvable guard.
      try { input=remoteInputs[method].parse(input); } catch(error) { return Promise.reject(error); }
      if ((REMOTE_READ_METHODS as readonly RemoteMethod[]).includes(method)) return client.rpc(method, input);
      return locked(async () => {
        const current = await verify(); const fingerprint = intent(input);
        if (pending) {
          if (requiredOperationId && pending.operationId !== requiredOperationId) throw new RemoteClientError(409, '另一项云端操作结果尚未核对，请先核对原操作');
          if (pinnedScope && pending.operationId && /^(?:plan-import|plan-revision):/.test(pending.operationId) &&
              (!input || typeof input !== 'object' || !('operationId' in input) || input.operationId !== pending.operationId))
            throw new RemoteClientError(409, '原计划写入尚未核对，请重新打开对应的计划文件');
          if (pending.method !== method || pending.fingerprint !== fingerprint) throw new RemoteClientError(409, '上一项云端操作结果尚未核对，请先重试原操作，或从菜单选择“核对云端操作”');
          const receipt = await operation(pending.requestId);
          if (receipt.status === 'completed') {
            if (receipt.method !== method) throw new RemoteClientError(409, '回执操作类型不符');
            const result = remoteOutputs[method].parse(receipt.result); save(null); return result;
          }
          if (receipt.status !== 'unknown') throw new RemoteClientError(409, receipt.status === 'processing' ? '原操作仍在处理，请稍候核对；没有重复发送' : '服务处理曾中断，请刷新资料并从菜单核对原操作');
          // The caller may have generated a fresh business ID after a timeout. Keep the original ID.
          if (pending.operationId && input && typeof input === 'object') input = { ...input, operationId: pending.operationId };
        } else {
          save({ requestId: randomUUID(), origin: client.origin, identity: current.identity, deviceId: current.deviceId, method, fingerprint,
            ...(input && typeof input === 'object' && 'operationId' in input ? { operationId: String(input.operationId) } : {}) });
        }
        const result = pinnedScope ? await client.rpc(method, input, pending!.requestId, pinnedScope) : await client.rpc(method, input, pending!.requestId);
        // Clear only after a validated response and a durable clear. Failures retain the same request ID.
        save(null); return result;
      });
    },
    inspect() { return locked(async () => { if (!pending) return { status: 'none' as const }; await verify(); return { ...await operation(pending.requestId), requestId: pending.requestId, method: pending.method, operationId: pending.operationId }; }); },
    acknowledge(requestId: string) { return locked(async () => {
      if (!pending || pending.requestId !== requestId) throw new RemoteClientError(409, '待核对操作已经变化');
      await verify(); const receipt = await operation(requestId);
      if (receipt.status !== 'completed' && receipt.status !== 'interrupted') throw new RemoteClientError(409, '操作尚未完成，暂不能解除保护');
      // Preserve metadata for manual inspection of an interrupted operation; no user source is recorded.
      writePrivate(file + '.last-acknowledged', JSON.stringify({ ...pending, status: receipt.status, acknowledgedAt: new Date().toISOString() })); save(null);
    }); },
  };
}

/** Desktop sessions can switch authorities. The CLI retains its original single-profile journal. */
export function createDesktopWriteJournal(client: NodeRemoteClient, legacyFile: string) {
  const old = readPrivate(legacyFile, 16_384);
  const pending = old ? PendingSchema.nullable().parse(JSON.parse(old.toString('utf8'))) : null;
  if (pending) {
    const file = scopedReceiptFile(legacyFile, remoteReceiptScope(pending.origin, pending));
    const existing = readPrivate(file, 16_384);
    if (!existing) writePrivate(file, JSON.stringify(pending));
    else if (JSON.stringify(PendingSchema.parse(JSON.parse(existing.toString('utf8')))) !== JSON.stringify(pending)) throw Error('旧云端操作与分区副本不一致，保留两份回执供核对');
    writePrivate(legacyFile, 'null');
  }
  async function within<T>(work: (journal: ReturnType<typeof createWriteJournal>) => Promise<T>, expected?: string) {
    const scope = remoteReceiptScope(client.origin, await client.getSession());
    if (expected && expected !== scope) throw new RemoteClientError(409, '计划预览属于另一连接，未核对或发送原请求');
    const file = scopedReceiptFile(legacyFile, scope);
    return withReceiptLock(file, () => work(createWriteJournal(client, file, scope)));
  }
  return {
    rpc(method: RemoteMethod, input?: unknown, plan?: { scope: string; operationId: string }) {
      if ((REMOTE_READ_METHODS as readonly RemoteMethod[]).includes(method)) return client.rpc(method, input);
      return within(journal => journal.rpc(method, input, plan?.operationId), plan?.scope);
    },
    unresolved() {
      return receiptFiles(legacyFile).flatMap(file => {
        const bytes = readPrivate(file, 16_384);
        const row = bytes ? PendingSchema.nullable().parse(JSON.parse(bytes.toString('utf8'))) : null;
        return row ? [{ scope: remoteReceiptScope(row.origin, row), operationId: row.operationId, requestId: row.requestId, method: row.method }] : [];
      });
    },
    inspect: () => within(journal => journal.inspect()),
    acknowledge: (id: string) => within(journal => journal.acknowledge(id)),
  };
}
