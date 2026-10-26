import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import type { CaptureStore, StoredCaptureAttachment } from '../capture/store';
import type { LocalSourceEvidenceResult } from './local-evidence';
import { SourceAttachmentsRequestSchema, SourceAttachmentOpenRequestSchema, SourceAttachmentsResultSchema, type SourceAttachment } from '../shared/source-attachments';
import { WorkflowError } from '../ai/deepseek';
import { readPrivate, writePrivate, privatePath } from '../remote/private-file';
import { isSupportedResourceFileName, resourceFilePath } from './resources';

const MAX_BYTES = 25 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const contentId = (hash: string) => `attachment-sha256:${hash}`;
const savedFile = z.strictObject({ id: z.string().min(1).max(200), hash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(240) });
const manifestSchema = z.strictObject({ version: z.literal(1), files: z.array(savedFile).max(50000) })
  .refine(value => new Set(value.files.map(item => item.id)).size === value.files.length);
type SavedFile = z.infer<typeof savedFile>;
type Options = {
  directory: string;
  store: Pick<CaptureStore, 'attachment' | 'attachments' | 'message' | 'readAttachmentBytes'>;
  resolveEvidence(request: { sourceId: string }): LocalSourceEvidenceResult | Promise<LocalSourceEvidenceResult>;
  openPath(path: string): Promise<string>;
};

/** Attachment names are labels, never paths or commands. Preserve only a safe basename. */
function safeName(value: string): string | null {
  if (!value || /[\\/:\u0000-\u001f\u007f]/.test(value)) return null;
  const name = value.trim();
  if (!name || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) return null;
  if (!isSupportedResourceFileName(name)) return null;
  const extension = extname(name).toLowerCase();
  const stem = name.slice(0, -extension.length).replace(/[<>"|?*]/g, '_').slice(0, 200);
  return stem ? stem + extension : null;
}

/** Private durable copies live outside the attachment/cache retention folders. */
export function createSourceAttachmentHost(options: Options) {
  const root = () => privatePath(join(options.directory, 'source-attachments'));
  const registryPath = () => join(root(), 'manifest.json');
  const load = () => {
    try {
      const bytes = readPrivate(registryPath(), 16 * 1024 * 1024);
      return bytes ? manifestSchema.parse(JSON.parse(bytes.toString('utf8'))) : { version: 1 as const, files: [] as SavedFile[] };
    } catch { throw new WorkflowError('STORAGE', '附件资料索引无法安全读取，请核对本机资料'); }
  };
  const pathFor = (file: SavedFile) => {
    if (safeName(file.name) !== file.name) throw new WorkflowError('STORAGE', '附件资料索引中的文件名无效，未打开文件');
    return privatePath(join(root(), file.hash, file.name));
  };
  async function belonging(sourceIds: string[]) {
    const attachments = new Map<string, StoredCaptureAttachment>(); let unavailableSources = 0;
    for (const sourceId of sourceIds) {
      let resolved: LocalSourceEvidenceResult;
      try { resolved = await options.resolveEvidence({ sourceId }); }
      catch { unavailableSources++; continue; }
      let unavailable = resolved.sources.length === 0;
      for (const source of resolved.sources) {
        const ref = source.captureRef; if (!ref) continue;
        const message = options.store.message(ref.messageId);
        if (!message || message.deleted || message.accountId !== ref.accountId || message.groupId !== ref.groupId) { unavailable = true; continue; }
        const items = ref.attachmentId ? [options.store.attachment(ref.attachmentId)].filter((item): item is StoredCaptureAttachment => !!item) : options.store.attachments(ref.messageId);
        for (const item of items) if (item.messageId === ref.messageId) attachments.set(item.id, item);
        if (ref.attachmentId && !items.some(item => item.id === ref.attachmentId && item.messageId === ref.messageId)) unavailable = true;
      }
      if (unavailable) unavailableSources++;
    }
    if (attachments.size > 100) throw new WorkflowError('VALIDATION', '关联附件超过一次可查看的数量，请分批查看来源');
    return { attachments: [...attachments.values()], unavailableSources };
  }
  function ensure(attachment: StoredCaptureAttachment, registry: z.infer<typeof manifestSchema>): { item: SourceAttachment; file?: SavedFile; changed: boolean } {
    const name = safeName(attachment.name);
    const label = attachment.name.split(/[\\/:]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || '原附件';
    const previous = registry.files.find(item => item.id === attachment.id);
    const supported = name && ['file', 'image', 'voice', 'video'].includes(attachment.kind);
    const hash = attachment.hash ?? previous?.hash;
    const id = supported && hash ? contentId(hash) : attachment.id;
    const result = (status: SourceAttachment['status'], message: string) => ({ item: { id, name: label, status, message }, changed: false });
    if (!supported || !name) return result('unsupported', '该附件类型不能直接打开，请查看原始消息');
    if (previous && attachment.hash && previous.hash !== attachment.hash) return result('missing', '原附件内容已变化，已保留旧副本，请核对原始资料');
    const sameContent = attachment.hash ? registry.files.find(item => item.hash === attachment.hash) : undefined;
    const file: SavedFile | undefined = previous ?? (attachment.hash ? { id: attachment.id, hash: attachment.hash, name: sameContent?.name ?? name } : undefined);
    if (!file) return result('missing', '本机尚未保存原附件，或附件缓存已清理');
    let path: string;
    try { path = pathFor(file); }
    catch { return result('missing', '附件资料位置无效，已保留关联，请核对本机资料'); }
    let persisted: Buffer | null;
    try { persisted = readPrivate(path, MAX_BYTES); }
    catch { return result('missing', '附件副本无法安全读取，请核对本机资料'); }
    if (persisted && digest(persisted) !== file.hash) return result('missing', '附件副本已被修改，未覆盖或打开；请核对本机资料');
    if (!persisted) {
      let bytes: Buffer | null;
      try { bytes = options.store.readAttachmentBytes(attachment.id); }
      catch { return result('missing', '本机原附件无法安全读取，已保留关联'); }
      if (!bytes || bytes.length > MAX_BYTES || digest(bytes) !== file.hash) return result('missing', '本机没有完整的原附件，已保留关联');
      // Exclusive creation never overwrites an existing user-edited document, even if it appears after the read.
      try {
        mkdirSync(privatePath(dirname(path)), { recursive: true, mode: 0o700 });
        const fd = openSync(privatePath(path), 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      catch { return result('missing', '未能保存附件资料，请检查磁盘空间或访问权限'); }
    }
    if (!previous) registry.files.push(file);
    return { item: { id: contentId(file.hash), name: file.name, status: 'available' }, file, changed: !previous };
  }
  return {
    async list(input: unknown) {
      const { sourceIds } = SourceAttachmentsRequestSchema.parse(input);
      const selected = await belonging(sourceIds), registry = load(), unique = new Map<string, SourceAttachment>(); let changed = false;
      for (const item of selected.attachments) {
        // Retain an alias for every original ID even when multiple messages share one file.
        const result = ensure(item, registry); changed ||= result.changed;
        const hash = item.hash ?? registry.files.find(file => file.id === item.id)?.hash;
        const key = hash && safeName(item.name) ? hash : item.id;
        const previous = unique.get(key);
        if (!previous || previous.status !== 'available' && result.item.status === 'available') unique.set(key, result.item);
      }
      if (changed) writePrivate(registryPath(), JSON.stringify(manifestSchema.parse(registry)));
      return SourceAttachmentsResultSchema.parse({ attachments: [...unique.values()], unavailableSources: selected.unavailableSources });
    },
    async open(input: unknown): Promise<{ opened: true }> {
      const { sourceIds, attachmentId } = SourceAttachmentOpenRequestSchema.parse(input);
      const selected = await belonging(sourceIds), registry = load();
      // A stable content ID deduplicates separate UI batches, but grants no access without a current source link.
      const attachment = selected.attachments.find(item => {
        const hash = item.hash ?? registry.files.find(file => file.id === item.id)?.hash;
        return item.id === attachmentId || !!hash && contentId(hash) === attachmentId;
      });
      if (!attachment) throw new WorkflowError('VALIDATION', '此附件不属于当前有效来源，未打开文件');
      const result = ensure(attachment, registry);
      if (!result.file || result.item.status !== 'available') throw new WorkflowError('VALIDATION', result.item.message ?? '原附件暂时不可用');
      if (result.changed) writePrivate(registryPath(), JSON.stringify(manifestSchema.parse(registry)));
      const path = pathFor(result.file);
      // Recheck the registered controlled file and its content immediately before handing it to the OS.
      const bytes = readPrivate(path, MAX_BYTES);
      if (!bytes || digest(bytes) !== result.file.hash || resourceFilePath(path).kind !== 'file') throw new WorkflowError('VALIDATION', '附件副本已变化，未打开文件');
      let error: string;
      try { error = await options.openPath(path); }
      catch { throw new WorkflowError('VALIDATION', '系统未能打开附件，请检查默认应用；附件资料已保留'); }
      if (error) throw new WorkflowError('VALIDATION', '系统未能打开附件，请检查默认应用；附件资料已保留');
      return { opened: true };
    },
  };
}
