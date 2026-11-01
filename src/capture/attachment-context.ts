import { z } from 'zod';
import type { CaptureBatch, CaptureStore, StoredCaptureMessage } from './store';
import { isAddressedElsewhere } from './recipients';

export const MAX_ATTACHMENT_CONTEXT_CHARACTERS = 20_000;
const MAX_ATTACHMENTS = 3, MAX_CHUNKS = 100;
export const AttachmentContextSchema = z.strictObject({
  items: z.array(z.strictObject({
    name: z.string().max(1000), completeness: z.enum(['complete', 'partial']), reason: z.string().max(500),
    chunks: z.array(z.strictObject({ locator: z.string().max(1000), text: z.string().max(MAX_ATTACHMENT_CONTEXT_CHARACTERS) })).max(MAX_CHUNKS),
  })).max(MAX_ATTACHMENTS),
  complete: z.boolean(), omitted: z.number().int().nonnegative(),
});
type AttachmentContext = z.infer<typeof AttachmentContextSchema>;

/** Reuse bounded local extraction only: never download, parse, OCR or analyse again. */
export function cachedAttachmentContext(store: CaptureStore, batch: CaptureBatch, messages: StoredCaptureMessage[]): Map<string, AttachmentContext> {
  const current = store.batchMessages(batch.id).filter(message => !message.deleted && !message.changed);
  const until = Math.max(...current.map(message => Date.parse(message.sentAt)));
  if (!Number.isFinite(until)) return new Map();
  const since = until - 24 * 3600_000;
  const eligible = [...new Map(messages.map(message => [message.id, message])).values()]
    .filter(message => message.accountId === batch.accountId && message.groupId === batch.groupId && !message.deleted && !message.changed
      && Date.parse(message.sentAt) >= since && Date.parse(message.sentAt) <= until)
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt) || b.id.localeCompare(a.id)).slice(0, 20);
  const result = new Map<string, AttachmentContext>();
  let budget = MAX_ATTACHMENT_CONTEXT_CHARACTERS, remaining = MAX_ATTACHMENTS;
  for (const message of eligible) {
    if (isAddressedElsewhere(message)) continue;
    const attachments = store.attachments(message.id);
    if (!attachments.length) continue;
    const context: AttachmentContext = { items: [], complete: true, omitted: 0 };
    for (const attachment of attachments) {
      if (!remaining || budget <= 0) { context.omitted++; context.complete = false; continue; }
      remaining--;
      const originalName = attachment.name.replaceAll('\\', '/').split('/').at(-1) || '附件';
      const name = originalName.slice(0, budget); budget -= name.length;
      const item: AttachmentContext['items'][number] = { name, completeness: 'complete', reason: '', chunks: [] };
      const partial = (reason: string) => { item.completeness = 'partial'; if (!item.reason) item.reason = reason; context.complete = false; };
      if (name.length < originalName.length) partial('上下文文件名达到限额而截断，不能据此认定名单没有本人');
      if (attachment.status !== 'ready' || attachment.error) partial('附件未完整解析或已不可用，仅能参考现有缓存，不能据此认定名单没有本人');
      if (attachment.kind === 'image') partial('图片没有完整文字核对结果，不能据此认定名单没有本人');
      if (attachment.kind !== 'file') partial('非文字文档的上下文不完整，不能据此认定名单没有本人');
      // Images/replies are not re-sent as paid visual input through historical context.
      if (attachment.kind === 'file') {
        for (let offset = 0; offset < MAX_CHUNKS; offset++) {
          if (budget <= 0) { partial('上下文文字达到限额，不能据此认定名单没有本人'); break; }
          const page = store.listChunks(attachment.id, { offset, limit: 1 }), chunk = page.items[0];
          if (!chunk) { if (!offset) partial('没有已解析文字缓存，不能据此认定名单没有本人'); break; }
          if (chunk.status !== 'ready' || chunk.error || chunk.imageDataUrl) partial('部分片段未完成文字识别，不能据此认定名单没有本人');
          if (chunk.status === 'ready' && chunk.text.trim()) {
            const locator = chunk.location.slice(0, budget); budget -= locator.length;
            const text = chunk.text.slice(0, budget); budget -= text.length;
            if (text) item.chunks.push({ locator, text });
            if (text.length < chunk.text.length || locator.length < chunk.location.length) partial('上下文文字达到限额而截断，不能据此认定名单没有本人');
          } else if (!chunk.text.trim()) partial('片段缺少可核对文字，不能据此认定名单没有本人');
          if (offset + 1 >= page.total) break;
          if (budget <= 0 || offset + 1 >= MAX_CHUNKS) { partial('上下文未包含全部片段，不能据此认定名单没有本人'); break; }
        }
      }
      context.items.push(item);
    }
    result.set(message.id, context);
  }
  return result;
}
