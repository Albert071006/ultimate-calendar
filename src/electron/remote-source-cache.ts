import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { CourseImportRequestSchema, IdSchema, ImportSourceRequestSchema, SourceSchema, type CourseImportRequest, type ImportSourceRequest, type Source } from '../shared/contracts';
import { nowInstant } from '../domain/time';
import { privatePath, readPrivate, writePrivate } from '../remote/private-file';
import { WorkflowError } from '../ai/deepseek';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CacheEntrySchema = z.discriminatedUnion('state', [
  z.strictObject({ version: z.literal(1), state: z.literal('remembered'), origin: z.enum(['manual', 'course-image']), contentHash: z.string().regex(/^[a-f0-9]{64}$/), source: SourceSchema }),
  z.strictObject({ version: z.literal(1), state: z.literal('forgotten'), sourceId: IdSchema }),
]);
type CacheEntry = z.infer<typeof CacheEntrySchema>;
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function evidenceHash(source: Source) {
  return digest(JSON.stringify({ kind: source.kind, text: source.text, imageDataUrl: source.imageDataUrl, label: source.label, sentAt: source.sentAt, purpose: source.purpose }));
}
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkflowError('VALIDATION', '本机导入依据的格式或大小无效。');
  return parsed.data;
}

/** Immutable manual-import evidence only. Never merge these Sources into cloud snapshots or mutation input. */
export function createRemoteSourceCache(profileDirectory: string) {
  if (!isAbsolute(profileDirectory) || resolve(profileDirectory) === parse(resolve(profileDirectory)).root) throw new WorkflowError('VALIDATION', '本机依据缓存需要明确的独立资料目录。');
  const directory = privatePath(join(profileDirectory, 'private', 'manual-source-cache'));
  function sourceId(value: unknown) {
    const id = validated(IdSchema, value);
    if (id.startsWith('distilled-source:')) throw new WorkflowError('VALIDATION', 'QQ 提炼依据应通过本机采集服务读取。');
    return id;
  }
  function file(id: string) { return privatePath(join(directory, `${digest(id)}.json`)); }
  function load(id: string): CacheEntry | null {
    try {
      const bytes = readPrivate(file(id), MAX_FILE_BYTES);
      if (!bytes) return null;
      const entry = CacheEntrySchema.parse(JSON.parse(bytes.toString('utf8')));
      if (entry.state === 'forgotten') {
        if (entry.sourceId !== id) throw Error();
      } else if (entry.source.id !== id || entry.source.captureRef || entry.contentHash !== evidenceHash(entry.source)) throw Error();
      return entry;
    } catch { throw new WorkflowError('STORAGE', '本机导入依据无法核验，已保留文件。'); }
  }
  function save(id: string, entry: CacheEntry) {
    try {
      const encoded = JSON.stringify(CacheEntrySchema.parse(entry));
      if (Buffer.byteLength(encoded, 'utf8') > MAX_FILE_BYTES) throw Error();
      writePrivate(file(id), encoded);
    } catch { throw new WorkflowError('STORAGE', '本机导入依据保存失败，未清空已有文件。'); }
  }
  function rememberSource(source: Source, origin: 'manual' | 'course-image') {
    const id = sourceId(source.id);
    if (source.captureRef) throw new WorkflowError('VALIDATION', 'QQ 原始依据不能写入手动导入缓存。');
    const entry = load(id), contentHash = evidenceHash(source);
    if (entry?.state === 'forgotten') throw new WorkflowError('CONFLICT', '这份本机依据已删除；迟到的导入回执不会恢复原文。');
    if (entry) {
      if (entry.origin !== origin || entry.contentHash !== contentHash) throw new WorkflowError('CONFLICT', '同一来源已有不同的本机依据，未覆盖原文。');
      return; // Import retries may contain newer cloud metadata; the original evidence stays immutable.
    }
    save(id, { version: 1, state: 'remembered', origin, contentHash, source });
  }
  return {
    remember(importRequest: ImportSourceRequest, returnedSource: Source): void {
      const request = validated(ImportSourceRequestSchema, importRequest), returned = validated(SourceSchema, returnedSource);
      if (returned.captureRef || returned.purpose !== 'message') throw new WorkflowError('VALIDATION', '这里只保留手动导入的本机依据。');
      // The server can already have removed its raw text/image. Keep the validated submitted evidence.
      rememberSource(validated(SourceSchema, { ...returned, ...request.source }), 'manual');
    },
    rememberCourseImage(request: Extract<CourseImportRequest, { kind: 'image' }>, returnedSourceId: string): void {
      const input = validated(CourseImportRequestSchema, request), id = sourceId(returnedSourceId);
      if (input.kind !== 'image') throw new WorkflowError('VALIDATION', '这里只保留本机导入的课表截图。');
      const cachedAt = nowInstant();
      // These timestamps describe creation of this local evidence copy, not cloud metadata or message send time.
      rememberSource(validated(SourceSchema, { id, version: 1, createdAt: cachedAt, updatedAt: cachedAt, importedAt: cachedAt,
        kind: 'image', imageDataUrl: input.imageDataUrl, text: '', label: '本机保留的课表截图', sentAt: null,
        purpose: 'courses', status: 'saved', error: null }), 'course-image');
    },
    read(value: string): Source | null {
      const id = validated(IdSchema, value);
      if (id.startsWith('distilled-source:')) return null; // Let the caller fall back to its collector-owned evidence resolver.
      const entry = load(id);
      return entry?.state === 'remembered' ? entry.source : null;
    },
    forget(value: string): void {
      const id = validated(IdSchema, value);
      if (id.startsWith('distilled-source:')) return;
      const entry = load(id);
      if (entry?.state === 'forgotten') return;
      // Keep only an ID tombstone so a late successful network response cannot resurrect deleted evidence.
      save(id, { version: 1, state: 'forgotten', sourceId: id });
    },
  };
}
