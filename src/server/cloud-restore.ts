import { createHash, randomUUID } from 'node:crypto';
import type { Repository } from '../storage/repository';
import { replaceLedgerDatabase, type LedgerService } from '../ledger/service';
import { WorkflowError } from '../ai/deepseek';
import { CloudRestorePreviewRequestSchema, CloudRestoreConfirmRequestSchema } from '../shared/cloud-management';
import { validateSafeBackup } from './backup';
import { withoutOriginalText } from './cloud-export';
import type { RemoteState } from './state';

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function createCloudRestore(options: { repository: Repository; ledger: LedgerService; state: RemoteState; backup(): string | undefined; hasPendingWrites(): boolean; now?(): number }) {
  const now = options.now ?? Date.now;
  type Preview = { deviceId: string; digest: string; identity: string; liveDigest: string; expires: number; payload: ReturnType<typeof validateSafeBackup> };
  const previews = new Map<string, Preview>();
  const liveDigest = () => hash({ planner: options.repository.read(), ledger: options.ledger.exportJson() });
  const counts = (payload: Preview['payload']) => ({ taskCount: payload.planner.entities.task.length, courseCount: payload.planner.entities.course.length, ledgerEntryCount: payload.ledger.entries.length });
  return {
    preview(input: unknown, deviceId: string) {
      const { content } = CloudRestorePreviewRequestSchema.parse(input);
      let raw: unknown, payload: Preview['payload'];
      try { raw = JSON.parse(content); payload = validateSafeBackup(withoutOriginalText(raw)); }
      catch { throw new WorkflowError('VALIDATION', '请选择完整有效的云端安全备份 JSON；本机数据库和旧全库备份不能上传恢复'); }
      // Completed old receipts cannot authorize actions in the restored authority.
      payload.planner.operations = []; payload.planner.receipts = [];
      for (const [token, preview] of previews) if (preview.expires <= now() || preview.deviceId === deviceId) previews.delete(token);
      while (previews.size >= 3) previews.delete(previews.keys().next().value!);
      const token = randomUUID(), digest = hash(content), expires = now() + 10 * 60_000;
      previews.set(token, { deviceId, digest, expires, identity: hash(options.state.identity()), liveDigest: liveDigest(), payload });
      return { token, digest, expiresAt: new Date(expires).toISOString(), createdAt: (raw as { createdAt: string }).createdAt, ...counts(payload), goalCount: payload.planner.entities.goal.length };
    },
    confirm(input: unknown, deviceId: string) {
      const { token, digest } = CloudRestoreConfirmRequestSchema.parse(input), preview = previews.get(token);
      if (!preview || preview.deviceId !== deviceId || preview.digest !== digest || preview.expires <= now()) throw new WorkflowError('CONFLICT', '恢复预览已失效或不属于当前设备，请重新选择并预览备份');
      if (preview.identity !== hash(options.state.identity()) || preview.liveDigest !== liveDigest()) { previews.delete(token); throw new WorkflowError('CONFLICT', '预览后云端资料已变化，未覆盖；请重新预览并确认'); }
      if (options.hasPendingWrites()) throw new WorkflowError('CONFLICT', '云端还有进行中的修改，请等待完成后重新预览恢复');
      if (!options.backup()) throw new WorkflowError('STORAGE', '恢复前安全备份未完成，云端资料未替换');
      previews.clear();
      const marker = { status: 'processing' as const, at: new Date(now()).toISOString(), generation: options.state.identity().generation + 1 };
      options.state.saveRestoreStatus(marker);
      try {
        // Separate DBs cannot commit together. Fence old writers first: a crash can
        // leave old data under a new generation, never restored data under the old one.
        const identity = options.state.advanceGeneration(true);
        options.repository.replaceState(preview.payload.planner, db => replaceLedgerDatabase(db, preview.payload.ledger));
        options.state.saveRestoreStatus({ ...marker, status: 'completed' });
        return { identity, backupCreated: true as const, ...counts(preview.payload) };
      } catch {
        try { options.state.saveRestoreStatus({ ...marker, status: 'interrupted' }); } catch { /* Durable processing marker remains an interrupted restore on startup. */ }
        throw new WorkflowError('STORAGE', '恢复结果需要核对；请重新连接检查云端资料与恢复前备份，不要重发恢复');
      }
    },
  };
}
