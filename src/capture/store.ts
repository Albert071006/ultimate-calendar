import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { IdSchema, InstantSchema } from '../shared/contracts';
import {
  AttachmentStatusSchema, CaptureBatchPageSchema, CaptureCleanupRequestSchema, CaptureConfigSchema,
  CaptureMessagePageSchema, CapturePageRequestSchema, CaptureStatsSchema, GroupCoverageSchema,
  type AttachmentSummary, type CaptureBatchView, type CaptureCleanupRequest, type CaptureConfig,
  type CaptureMessageView, type CapturePageRequest, type GroupCoverage,
  capturePlatform, type CapturePlatform,
} from '../shared/capture';
import { nowInstant } from '../domain/time';
import { openDatabase } from '../storage/database';
import { planAttachmentRetention, applyAttachmentRetention, type AttachmentRetentionPolicy } from './retention';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const JsonSchema = z.json();
const MessageInputSchema = z.strictObject({
  accountId: IdSchema, groupId: IdSchema, messageId: IdSchema,
  groupName: z.string().max(1000).default(''), senderId: IdSchema.nullable().default(null),
  senderName: z.string().max(1000).default(''), sentAt: InstantSchema,
  importedAt: InstantSchema.optional(), text: z.string().max(1_000_000).default(''),
  origin: z.enum(['live', 'history']).default('live'),
  segments: z.array(JsonSchema).max(1000).default([]),
  attachments: z.array(z.strictObject({
    id: IdSchema.optional(), name: z.string().max(1000),
    kind: z.enum(['image', 'file', 'voice', 'video', 'other']),
    size: z.number().int().nonnegative().nullable().default(null), locator: JsonSchema.nullable().default(null),
  })).max(100).default([]),
});
export type CapturedMessageInput = z.input<typeof MessageInputSchema>;
export type CapturedAttachmentInput = NonNullable<CapturedMessageInput['attachments']>[number];
const StoredMessageSchema = MessageInputSchema.omit({ attachments: true }).extend({
  id: IdSchema, importedAt: InstantSchema, changed: z.boolean(), deleted: z.boolean(),
});
export type StoredCaptureMessage = z.infer<typeof StoredMessageSchema>;
const StoredAttachmentSchema = z.strictObject({
  id: IdSchema, messageId: IdSchema, name: z.string().max(1000),
  kind: z.enum(['image', 'file', 'voice', 'video', 'other']),
  size: z.number().int().nonnegative().nullable(), locator: JsonSchema.nullable(),
  status: AttachmentStatusSchema, error: z.string().max(2000).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), extractorVersion: z.string().max(500).nullable(),
});
export type StoredCaptureAttachment = z.infer<typeof StoredAttachmentSchema>;
const ChunkSchema = z.strictObject({
  id: IdSchema, attachmentId: IdSchema, ordinal: z.number().int().nonnegative(),
  location: z.string().max(1000), text: z.string().max(1_000_000),
  status: z.enum(['pending', 'ready', 'failed']), error: z.string().max(2000).nullable(),
  imageDataUrl: z.string().max(36_000_000).nullable().default(null),
  sentAt: InstantSchema.nullable().default(null),
});
export type CaptureChunk = z.infer<typeof ChunkSchema>;
export type CaptureChunkInput = Omit<CaptureChunk, 'id' | 'attachmentId' | 'sentAt'> & { id?: string; sentAt?: string | null };
const AttemptSchema = z.strictObject({
  id: IdSchema, startedAt: InstantSchema, finishedAt: InstantSchema.nullable(),
  status: z.enum(['requesting', 'succeeded', 'failed', 'uncertain']), error: z.string().max(2000).nullable(),
});
const BatchSchema = z.strictObject({
  id: IdSchema, operationId: IdSchema, accountId: IdSchema, groupId: IdSchema,
  status: z.enum(['pending', 'preparing', 'requesting', 'uncertain', 'result-ready', 'applied', 'failed']),
  createdAt: InstantSchema, updatedAt: InstantSchema, messageIds: z.array(IdSchema).min(1).max(1000),
  origin: z.enum(['live', 'history']).default('live'),
  attempts: z.array(AttemptSchema).max(1000), error: z.string().max(2000).nullable(),
  result: JsonSchema.nullable(), inputFingerprint: z.string().max(1000).nullable(),
});
export type CaptureBatch = z.infer<typeof BatchSchema>;
const CredentialPauseSchema = z.strictObject({
  reason: z.enum(['AUTH', 'NO_API_KEY']),
  failure: z.strictObject({ batchId: IdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
});
const CredentialChangeSchema = z.strictObject({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().uuid().nullable(), configured: z.boolean(),
});
export const captureBackupSchemas = { message: StoredMessageSchema, attachment: StoredAttachmentSchema, chunk: ChunkSchema, batch: BatchSchema };
const ExportSchema = z.strictObject({
  schemaVersion: z.literal(1), config: CaptureConfigSchema,
  wechatConfig: CaptureConfigSchema.optional(),
  selections: z.array(z.strictObject({ accountId: IdSchema, groupIds: z.array(IdSchema).max(100) })),
  messages: z.array(StoredMessageSchema), attachments: z.array(StoredAttachmentSchema),
  blobs: z.array(z.strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) })),
  chunks: z.array(ChunkSchema), batches: z.array(BatchSchema), coverage: z.array(GroupCoverageSchema),
});
export type CaptureExportState = z.infer<typeof ExportSchema>;
export interface CaptureExport { state: CaptureExportState; fingerprint: string; stats: ReturnType<typeof CaptureStatsSchema.parse> }

function json(value: unknown): string {
  const serialized = JSON.stringify(JsonSchema.parse(value));
  if (serialized.length > 40_000_000) throw Error('采集记录过大');
  return serialized;
}
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function captureMessageId(accountId: string, groupId: string, messageId: string): string {
  return `${capturePlatform(accountId) === 'wechat' ? 'wxm' : 'qqm'}:${digest(JSON.stringify([IdSchema.parse(accountId), IdSchema.parse(groupId), IdSchema.parse(messageId)]))}`;
}
function parsePayload<T>(row: Record<string, unknown> | undefined, schema: z.ZodType<T>): T | null {
  return row ? schema.parse(JSON.parse(row['payload'] as string)) : null;
}
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw Error(`${label}存在重复标识`); }
export function validateCaptureState(value: unknown): CaptureExportState {
  const state = ExportSchema.parse(value);
  if (state.config.platform === 'wechat' || state.config.accountId && capturePlatform(state.config.accountId) !== 'qq') throw Error('QQ 备份配置的平台不匹配');
  if (state.wechatConfig && (state.wechatConfig.platform !== 'wechat' || state.wechatConfig.accountId && capturePlatform(state.wechatConfig.accountId) !== 'wechat')) throw Error('微信备份配置的平台不匹配');
  for (const name of ['messages', 'attachments', 'chunks', 'batches'] as const) unique(state[name].map(item => item.id), name);
  unique(state.blobs.map(item => item.hash), '附件内容');
  unique(state.selections.map(item => item.accountId), '账号选择');
  unique(state.coverage.map(item => `${item.accountId}\0${item.groupId}`), '历史覆盖');
  const messages = new Map(state.messages.map(item => [item.id, item]));
  const attachments = new Map(state.attachments.map(item => [item.id, item]));
  const blobs = new Set(state.blobs.map(item => item.hash));
  const batched = new Set<string>();
  unique(state.batches.map(item => item.operationId), '批次提交');
  for (const message of state.messages) if (captureMessageId(message.accountId, message.groupId, message.messageId) !== message.id) throw Error('消息标识与采集来源不匹配');
  for (const attachment of state.attachments) {
    if (!messages.has(attachment.messageId) || (attachment.hash && !blobs.has(attachment.hash))) throw Error('附件来源或内容不存在');
  }
  for (const blob of state.blobs) {
    const bytes = Buffer.from(blob.bytes, 'base64');
    // Buffer decoding is permissive; a canonical round trip checks every byte without a large-input regex stack.
    if (bytes.toString('base64') !== blob.bytes) throw Error('附件内容编码无效');
    if (bytes.length > MAX_ATTACHMENT_BYTES || digest(bytes) !== blob.hash) throw Error('附件内容校验失败');
  }
  for (const chunk of state.chunks) if (!attachments.has(chunk.attachmentId)) throw Error('附件分片来源不存在');
  unique(state.chunks.map(chunk => `${chunk.attachmentId}\0${chunk.ordinal}`), '附件分片位置');
  for (const batch of state.batches) {
    unique(batch.messageIds, '批次消息'); unique(batch.attempts.map(attempt => attempt.id), '请求尝试');
    for (const id of batch.messageIds) {
      const message = messages.get(id);
      if (!message || message.accountId !== batch.accountId || message.groupId !== batch.groupId || batched.has(id)) throw Error('批次消息来源或成员关系无效');
      batched.add(id);
    }
    if (['result-ready', 'applied'].includes(batch.status) && batch.result === null) throw Error('已完成批次缺少结果');
  }
  for (const selection of state.selections) unique(selection.groupIds, '群选择');
  return state;
}

/** Shares the planner file, but owns only capture_* tables and its own schema version. */
export function createCaptureStore(path: string, internal: { platform?: CapturePlatform; database?: DatabaseSync; skipInitialize?: boolean; skipRecovery?: boolean; externalTransaction?: boolean } = {}) {
  const platform = internal.platform ?? 'qq';
  const metaKey = (key: string) => platform === 'qq' ? key : `wechat:${key}`;
  const ownsAccount = (accountId: string) => capturePlatform(accountId) === platform;
  const requireAccount = (accountId: string) => { IdSchema.parse(accountId); if (!ownsAccount(accountId)) throw Error('账号不属于当前采集平台'); return accountId; };
  const scope = (column = 'account_id') => `substr(${column},1,7)${platform === 'wechat' ? '=' : '!='}'wechat:'`;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = internal.database ?? openDatabase(path);
  if (!internal.skipInitialize) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_meta (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_selections (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_messages (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, message_id TEXT NOT NULL,
      sent_at TEXT NOT NULL, imported_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
      UNIQUE(account_id, group_id, message_id));
    CREATE INDEX IF NOT EXISTS capture_messages_group_time ON capture_messages(account_id,group_id,sent_at);
    CREATE TABLE IF NOT EXISTS capture_blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES capture_messages(id) ON DELETE CASCADE,
      hash TEXT REFERENCES capture_blobs(hash), payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS capture_attachments_message ON capture_attachments(message_id);
    CREATE TABLE IF NOT EXISTS capture_chunks (
      id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES capture_attachments(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(attachment_id,ordinal));
    CREATE TABLE IF NOT EXISTS capture_batches (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS capture_batches_status ON capture_batches(status,created_at);
    CREATE TABLE IF NOT EXISTS capture_batch_messages (
      batch_id TEXT NOT NULL REFERENCES capture_batches(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL UNIQUE REFERENCES capture_messages(id), ordinal INTEGER NOT NULL,
      PRIMARY KEY(batch_id,message_id));
    CREATE TABLE IF NOT EXISTS capture_coverage (
      account_id TEXT NOT NULL, group_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id,group_id));
  `);
  const version = db.prepare('SELECT payload FROM capture_meta WHERE id=?').get('schemaVersion');
  if (version && version['payload'] !== '1') { db.close(); throw Error('采集数据库版本不受支持'); }
  db.prepare('INSERT OR IGNORE INTO capture_meta(id,payload) VALUES(?,?)').run('schemaVersion', '1');
  db.prepare('INSERT OR IGNORE INTO capture_meta(id,payload) VALUES(?,?)').run('config', json(CaptureConfigSchema.parse({})));
  if (platform === 'wechat') db.prepare('INSERT OR IGNORE INTO capture_meta(id,payload) VALUES(?,?)').run(metaKey('config'), json(CaptureConfigSchema.parse({ platform })));
  db.prepare('INSERT OR IGNORE INTO capture_meta(id,payload) VALUES(?,?)').run('revision', '0');
  for (const table of ['capture_selections', 'capture_messages', 'capture_attachments', 'capture_blobs', 'capture_chunks', 'capture_batches', 'capture_batch_messages', 'capture_coverage']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_revision_${event.toLowerCase()} AFTER ${event} ON ${table}
      BEGIN UPDATE capture_meta SET payload=CAST(payload AS INTEGER)+1 WHERE id='revision'; END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS capture_config_revision AFTER UPDATE ON capture_meta WHEN NEW.id='config'
    BEGIN UPDATE capture_meta SET payload=CAST(payload AS INTEGER)+1 WHERE id='revision'; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS capture_wechat_config_revision AFTER UPDATE ON capture_meta WHEN NEW.id='wechat:config'
    BEGIN UPDATE capture_meta SET payload=CAST(payload AS INTEGER)+1 WHERE id='revision'; END`);
  }
  function transaction<T>(work: () => T): T {
    if (internal.externalTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function config(): CaptureConfig { return parsePayload(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get(metaKey('config')), CaptureConfigSchema) ?? CaptureConfigSchema.parse(platform === 'wechat' ? { platform } : {}); }
  function credentialPause() { return parsePayload(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get(metaKey('credentialPause')), CredentialPauseSchema); }
  function clearCredentialPause() { db.prepare('DELETE FROM capture_meta WHERE id=?').run(metaKey('credentialPause')); }
  function writeConfig(next: CaptureConfig) {
    db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(metaKey('config'), json(next));
    if (next.accountId) db.prepare('INSERT INTO capture_selections(account_id,payload) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload').run(next.accountId, json(next.groupIds));
  }
  function message(id: string): StoredCaptureMessage | null { return parsePayload(db.prepare(`SELECT payload FROM capture_messages WHERE id=? AND ${scope()}`).get(IdSchema.parse(id)), StoredMessageSchema); }
  function attachment(id: string): StoredCaptureAttachment | null { return parsePayload(db.prepare(`SELECT a.payload FROM capture_attachments a JOIN capture_messages m ON m.id=a.message_id WHERE a.id=? AND ${scope('m.account_id')}`).get(IdSchema.parse(id)), StoredAttachmentSchema); }
  function batch(id: string): CaptureBatch | null { return parsePayload(db.prepare(`SELECT payload FROM capture_batches WHERE id=? AND ${scope()}`).get(IdSchema.parse(id)), BatchSchema); }
  function saveMessage(value: StoredCaptureMessage) {
    db.prepare('INSERT INTO capture_messages(id,account_id,group_id,message_id,sent_at,imported_at,deleted,payload) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,payload=excluded.payload')
      .run(value.id, value.accountId, value.groupId, value.messageId, value.sentAt, value.importedAt, Number(value.deleted), json(value));
  }
  function saveAttachment(value: StoredCaptureAttachment) {
    db.prepare('INSERT INTO capture_attachments(id,message_id,hash,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,payload=excluded.payload')
      .run(value.id, value.messageId, value.hash, json(StoredAttachmentSchema.parse(value)));
  }
  function saveBatch(value: CaptureBatch) {
    db.prepare('INSERT INTO capture_batches(id,account_id,group_id,status,created_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload')
      .run(value.id, value.accountId, value.groupId, value.status, value.createdAt, json(BatchSchema.parse(value)));
  }
  function attachments(messageId: string): StoredCaptureAttachment[] {
    if (!message(messageId)) return [];
    return db.prepare('SELECT payload FROM capture_attachments WHERE message_id=? ORDER BY rowid').all(IdSchema.parse(messageId)).map(row => parsePayload(row, StoredAttachmentSchema)!);
  }
  function chunks(attachmentId: string): CaptureChunk[] {
    if (!attachment(attachmentId)) return [];
    return db.prepare('SELECT payload FROM capture_chunks WHERE attachment_id=? ORDER BY ordinal').all(IdSchema.parse(attachmentId)).map(row => parsePayload(row, ChunkSchema)!);
  }
  function viewMessage(value: StoredCaptureMessage): CaptureMessageView {
    return { platform: capturePlatform(value.accountId), id: value.id, accountId: value.accountId, groupId: value.groupId, messageId: value.messageId,
      groupName: value.groupName, senderName: value.senderName, sentAt: value.sentAt, importedAt: value.importedAt,
      text: value.text, changed: value.changed, deleted: value.deleted,
      attachments: attachments(value.id).map(item => ({ id: item.id, name: item.name, kind: item.kind, status: item.status,
        size: item.size, error: item.error,
        chunkCount: Number(db.prepare('SELECT count(*) AS n FROM capture_chunks WHERE attachment_id=?').get(item.id)!['n']),
      } satisfies AttachmentSummary)) };
  }
  function viewBatch(value: CaptureBatch): CaptureBatchView {
    return { platform: capturePlatform(value.accountId), id: value.id, operationId: value.operationId, accountId: value.accountId, groupId: value.groupId,
      status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, messageCount: value.messageIds.length,
      attemptCount: value.attempts.length, error: value.error };
  }
  function filters(request: CapturePageRequest): { query: ReturnType<typeof CapturePageRequestSchema.parse>; where: string; args: string[] } {
    const query = CapturePageRequestSchema.parse(request); const clauses: string[] = [scope()]; const args: string[] = [];
    if (query.accountId !== undefined) { clauses.push('account_id=?'); args.push(query.accountId); }
    if (query.groupId !== undefined) { clauses.push('group_id=?'); args.push(query.groupId); }
    if (query.messageId !== undefined) { clauses.push('id=?'); args.push(query.messageId); }
    return { query, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }
  function statistics() {
    const count = (sql: string) => Number(db.prepare(sql).get()!['n']);
    const attachmentScope = `EXISTS(SELECT 1 FROM capture_messages m WHERE m.id=capture_attachments.message_id AND ${scope('m.account_id')})`;
    return CaptureStatsSchema.parse({
      messages: count(`SELECT count(*) AS n FROM capture_messages WHERE deleted=0 AND ${scope()}`),
      attachments: count(`SELECT count(*) AS n FROM capture_attachments WHERE json_extract(payload,'$.status')!='deleted' AND ${attachmentScope}`),
      attachmentBytes: count(`SELECT coalesce(sum(length(bytes)),0) AS n FROM capture_blobs WHERE EXISTS(SELECT 1 FROM capture_attachments JOIN capture_messages m ON m.id=capture_attachments.message_id WHERE capture_attachments.hash=capture_blobs.hash AND ${scope('m.account_id')})`),
      pendingMessages: count(`SELECT count(*) AS n FROM capture_messages m WHERE deleted=0 AND ${scope('m.account_id')} AND NOT EXISTS(SELECT 1 FROM capture_batch_messages bm WHERE bm.message_id=m.id)`),
      batches: count(`SELECT count(*) AS n FROM capture_batches WHERE ${scope()}`),
      pendingBatches: count(`SELECT count(*) AS n FROM capture_batches WHERE status IN ('pending','preparing','requesting','result-ready') AND ${scope()}`),
      uncertainBatches: count(`SELECT count(*) AS n FROM capture_batches WHERE status='uncertain' AND ${scope()}`),
      failedAttachments: count(`SELECT count(*) AS n FROM capture_attachments WHERE json_extract(payload,'$.status') IN ('failed','too-large','encrypted','unsupported') AND ${attachmentScope}`),
    });
  }
  function recoverInterrupted(at = nowInstant()) {
    InstantSchema.parse(at);
    return transaction(() => {
      let uncertain = 0; let pending = 0;
      for (const row of db.prepare(`SELECT payload FROM capture_batches WHERE status IN ('requesting','preparing') AND ${scope()}`).all()) {
        const value = parsePayload(row, BatchSchema)!;
        if (value.status === 'requesting') {
          const savedResponse = value.result && typeof value.result === 'object' && !Array.isArray(value.result) && value.result['pendingResponse'];
          if (savedResponse) {
            value.status = 'pending'; value.error = '上次回答已保存，恢复后先校验本地结果，不重复调用 AI'; pending++;
          } else {
            value.status = 'uncertain'; value.error = '上次分析请求已发出，但未保存到响应；请确认后手动重试，避免重复付费'; uncertain++;
            const attempt = value.attempts.at(-1); if (attempt?.status === 'requesting') { attempt.status = 'uncertain'; attempt.finishedAt = at; attempt.error = value.error; }
          }
        } else { value.status = 'pending'; value.error = null; pending++; }
        value.updatedAt = at; saveBatch(value);
      }
      for (const row of db.prepare(`SELECT a.payload FROM capture_attachments a JOIN capture_messages m ON m.id=a.message_id WHERE json_extract(a.payload,'$.status') IN ('downloading','extracting') AND ${scope('m.account_id')}`).all()) {
        const value = parsePayload(row, StoredAttachmentSchema)!; value.status = 'pending'; value.error = null; saveAttachment(value);
      }
      return { uncertain, pending };
    });
  }

  // These mutations run within the caller's transaction, including the durable sync acknowledgement.
  function pauseForCredentials(reason: 'AUTH' | 'NO_API_KEY', failedBatchId?: string): boolean {
    const active = config(), previous = credentialPause();
    if (!active.analysisEnabled && !previous) return false;
    const failed = failedBatchId ? batch(failedBatchId) : null;
    if (failedBatchId && (!failed || failed.status !== 'failed')) throw Error('只能恢复凭据明确失败的批次');
    const value = CredentialPauseSchema.parse({ reason, failure: failed ? { batchId: failed.id, fingerprint: digest(json(failed)) } : previous?.failure ?? null });
    db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(metaKey('credentialPause'), json(value));
    writeConfig({ ...active, analysisEnabled: false });
    return true;
  }
  function resumeAfterCredentials(at: string): boolean {
    const pause = credentialPause(); if (!pause) return false;
    const value = pause.failure ? batch(pause.failure.batchId) : null;
    // Exact saved failure only: manual changes, uncertain requests and cleaned sources never retry.
    if (value?.status === 'failed' && digest(json(value)) === pause.failure!.fingerprint && !value.messageIds.some(id => !message(id) || message(id)!.deleted)) {
      value.status = 'pending'; value.error = null; value.updatedAt = at; saveBatch(value);
    }
    writeConfig({ ...config(), analysisEnabled: true }); clearCredentialPause();
    return true;
  }
  const store = {
    path, platform, config,
    credentialPause, clearCredentialPause,
    // Private local state: a user configuration or restored backup cannot grant automatic resume.
    pauseForCredentials(reason: 'AUTH' | 'NO_API_KEY', failedBatchId?: string) { return transaction(() => pauseForCredentials(reason, failedBatchId)); },
    resumeAfterCredentials(at = nowInstant()) { InstantSchema.parse(at); return transaction(() => resumeAfterCredentials(at)); },
    applyCredentialChange(input: z.infer<typeof CredentialChangeSchema>, at = nowInstant()) {
      const next = CredentialChangeSchema.parse(input); InstantSchema.parse(at);
      return transaction(() => {
        const previous = parsePayload(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get(metaKey('credentialChange')), CredentialChangeSchema);
        if (previous?.sourceId === next.sourceId && previous.revision === next.revision) return { changed: false, resumed: false, paused: false };
        const resumed = next.configured && resumeAfterCredentials(at);
        const paused = !next.configured && pauseForCredentials('NO_API_KEY');
        // Commit the acknowledgement with the queue/config changes. A lost worker receipt cannot resume twice.
        db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(metaKey('credentialChange'), json(next));
        return { changed: true, resumed, paused };
      });
    },
    fingerprint(): string { return `capture-v1:${db.prepare("SELECT payload FROM capture_meta WHERE id='revision'").get()?.['payload'] ?? '0'}`; },
    saveConfig(value: unknown): CaptureConfig {
      const next = CaptureConfigSchema.parse(platform === 'wechat' && value && typeof value === 'object' ? { ...value, platform } : value);
      if (next.platform && next.platform !== platform || next.accountId && !ownsAccount(next.accountId)) throw Error('采集配置不属于当前平台');
      return transaction(() => {
        const previous = config();
        if (previous.endpoint !== next.endpoint || previous.flavor !== next.flavor) {
          // Cursors are provider-specific. Preserve source records while invalidating every old bridge frontier.
          const updatedAt = nowInstant();
          for (const row of db.prepare(`SELECT payload FROM capture_coverage WHERE ${scope()}`).all()) {
            const coverage = parsePayload(row, GroupCoverageSchema)!;
            db.prepare('UPDATE capture_coverage SET payload=? WHERE account_id=? AND group_id=?').run(json({ ...coverage,
              status: 'not-started', cursor: null, earliestAt: null, fetchedCount: 0, updatedAt,
              error: '桥接地址或协议已改变，下次补采将重新检查最近七天；已收消息保留',
            }), coverage.accountId, coverage.groupId);
          }
        }
        writeConfig(next); return next;
      });
    },
    selectedGroups(accountId: string): string[] {
      requireAccount(accountId);
      const row = db.prepare('SELECT payload FROM capture_selections WHERE account_id=?').get(IdSchema.parse(accountId));
      return row ? z.array(IdSchema).parse(JSON.parse(row['payload'] as string)) : [];
    },
    ingest(inputs: CapturedMessageInput[], at = nowInstant()): { inserted: number; duplicates: number; ignored: number; ids: string[] } {
      InstantSchema.parse(at); if (inputs.length > 10_000) throw Error('单次消息导入过多');
      const parsed = inputs.map(input => MessageInputSchema.parse(input));
      return transaction(() => {
        const active = config(); const result = { inserted: 0, duplicates: 0, ignored: 0, ids: [] as string[] };
        for (const input of parsed) {
          if (!ownsAccount(input.accountId) || !active.enabled || input.accountId !== active.accountId || !active.groupIds.includes(input.groupId)) { result.ignored++; continue; }
          const id = captureMessageId(input.accountId, input.groupId, input.messageId);
          if (message(id)) { result.duplicates++; continue; }
          const { attachments: incoming, ...fields } = input;
          saveMessage({ ...fields, id, importedAt: input.importedAt ?? at, changed: false, deleted: false });
          for (const [index, item] of incoming.entries()) {
            const attachmentId = item.id ?? `qqa:${digest(`${id}:${index}`)}`;
            if (db.prepare('SELECT 1 FROM capture_attachments WHERE id=?').get(attachmentId)) throw Error('附件标识重复');
            const unsupported = item.kind === 'voice' || item.kind === 'video';
            saveAttachment({ id: attachmentId, messageId: id, name: item.name, kind: item.kind, size: item.size,
              locator: item.locator, status: unsupported ? 'unsupported' : 'pending', error: unsupported ? '语音和视频需手动查看' : null,
              hash: null, extractorVersion: null });
          }
          result.inserted++; result.ids.push(id);
        }
        return result;
      });
    },
    message, messageByKey(accountId: string, groupId: string, messageId: string) { return message(captureMessageId(accountId, groupId, messageId)); },
    messageView(id: string) { const value = message(id); return value ? viewMessage(value) : null; },
    listMessages(request: CapturePageRequest = {}) {
      const { query, where, args } = filters(request);
      const total = Number(db.prepare(`SELECT count(*) AS n FROM capture_messages ${where}`).get(...args)!['n']);
      const items = db.prepare(`SELECT payload FROM capture_messages ${where} ORDER BY sent_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, query.limit, query.offset).map(row => viewMessage(parsePayload(row, StoredMessageSchema)!));
      return CaptureMessagePageSchema.parse({ items, total, offset: query.offset, limit: query.limit });
    },
    markMessageChanged(id: string) { const value = message(id); if (!value) return false; value.changed = true; saveMessage(value); return true; },
    sealBatches(options: { now?: string; force?: boolean; accountId?: string; groupId?: string; maxMessages?: number } = {}): CaptureBatch[] {
      const at = InstantSchema.parse(options.now ?? nowInstant());
      const max = z.number().int().min(1).max(1000).parse(options.maxMessages ?? 100);
      return transaction(() => {
        const active = config(); if (!active.accountId) return [];
        const sealed: CaptureBatch[] = [];
        if (options.accountId && options.accountId !== active.accountId) return [];
        for (const groupId of active.groupIds) {
          if (options.groupId && options.groupId !== groupId) continue;
          for (const origin of ['live', 'history'] as const) {
          while (true) {
            const rows = db.prepare(`SELECT m.payload FROM capture_messages m WHERE account_id=? AND group_id=? AND deleted=0
              AND coalesce(json_extract(m.payload,'$.origin'),'live')=?
              AND NOT EXISTS(SELECT 1 FROM capture_batch_messages bm WHERE bm.message_id=m.id)
              ORDER BY imported_at,id LIMIT ?`).all(active.accountId, groupId, origin, max);
            const values = rows.map(row => parsePayload(row, StoredMessageSchema)!);
            if (!values.length) break;
            const oldest = values[0]!;
            if (!options.force && Date.parse(at) - Date.parse(oldest.importedAt) < active.intervalSeconds * 1000) break;
            const id = `qqb:${randomUUID()}`;
            const value: CaptureBatch = { id, operationId: `qq-apply:${id}`, accountId: active.accountId, groupId,
              status: 'pending', origin, createdAt: at, updatedAt: at, messageIds: values.map(item => item.id), attempts: [], error: null, result: null, inputFingerprint: null };
            saveBatch(value);
            for (const [ordinal, messageId] of value.messageIds.entries()) db.prepare('INSERT INTO capture_batch_messages(batch_id,message_id,ordinal) VALUES(?,?,?)').run(id, messageId, ordinal);
            sealed.push(value);
          }
          }
        }
        return sealed;
      });
    },
    batch, batchMessages(id: string) { const value = batch(id); return value ? value.messageIds.map(message).filter((item): item is StoredCaptureMessage => item !== null) : []; },
    contextMessagesBefore(id: string): StoredCaptureMessage[] {
      const value = batch(id); if (!value) return [];
      const dates = value.messageIds.map(message).filter((item): item is StoredCaptureMessage => item !== null && !item.deleted).map(item => Date.parse(item.sentAt));
      if (!dates.length) return [];
      const before = Math.min(...dates), since = before - 24 * 3600_000;
      return db.prepare(`SELECT payload FROM capture_messages WHERE account_id=? AND group_id=? AND deleted=0
        AND coalesce(json_extract(payload,'$.changed'),0)=0 AND length(json_extract(payload,'$.text'))>0
        AND julianday(sent_at)>=julianday(?) AND julianday(sent_at)<julianday(?)
        ORDER BY julianday(sent_at) DESC,id DESC LIMIT 20`)
        .all(value.accountId, value.groupId, new Date(since).toISOString(), new Date(before).toISOString())
        .map(row => parsePayload(row, StoredMessageSchema)!);
    },
    listBatches(request: CapturePageRequest = {}) {
      const { query, where, args } = filters(request);
      const total = Number(db.prepare(`SELECT count(*) AS n FROM capture_batches ${where}`).get(...args)!['n']);
      const items = db.prepare(`SELECT payload FROM capture_batches ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, query.limit, query.offset).map(row => viewBatch(parsePayload(row, BatchSchema)!));
      return CaptureBatchPageSchema.parse({ items, total, offset: query.offset, limit: query.limit });
    },
    claimBatch(at = nowInstant()): CaptureBatch | null {
      InstantSchema.parse(at);
      return transaction(() => {
        const active = config(); if (!active.analysisEnabled || !active.accountId || !active.groupIds.length) return null;
        const turn = Number(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get(metaKey('priorityTurn'))?.['payload'] ?? 0);
        const preferred = turn % 4 === 3 ? 'history' : 'live';
        const value = parsePayload(db.prepare(`SELECT payload FROM capture_batches WHERE account_id=? AND group_id IN (${active.groupIds.map(() => '?').join(',')})
          AND status IN ('pending','result-ready') ORDER BY CASE WHEN status='result-ready' THEN 0 ELSE 1 END,
          CASE WHEN coalesce(json_extract(payload,'$.origin'),'live')=? THEN 0 ELSE 1 END,created_at,rowid LIMIT 1`).get(active.accountId, ...active.groupIds, preferred), BatchSchema);
        if (!value) return null;
        if (value.status === 'pending') {
          value.status = 'preparing'; value.updatedAt = at; saveBatch(value);
          db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(metaKey('priorityTurn'), String((turn + 1) % 4));
        }
        return value;
      });
    },
    startAttempt(id: string, inputFingerprint: string, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at); z.string().min(1).max(1000).parse(inputFingerprint);
      return transaction(() => {
        const value = batch(id); if (!value || value.status !== 'preparing') throw Error('仅准备中的批次可发出分析请求');
        value.inputFingerprint = inputFingerprint; value.status = 'requesting'; value.updatedAt = at; value.error = null;
        value.attempts.push({ id: `qqa:${randomUUID()}`, startedAt: at, finishedAt: null, status: 'requesting', error: null });
        saveBatch(value); return value;
      });
    },
    saveResult(id: string, result: unknown, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at); const parsed = JsonSchema.parse(result); if (parsed === null) throw Error('批次结果不能为空');
      return transaction(() => {
        const value = batch(id); if (!value || !['requesting', 'preparing'].includes(value.status)) throw Error('批次状态不可保存分析结果');
        value.result = parsed; value.status = 'result-ready'; value.updatedAt = at; value.error = null;
        const attempt = value.attempts.at(-1); if (attempt?.status === 'requesting') { attempt.status = 'succeeded'; attempt.finishedAt = at; }
        saveBatch(value); return value;
      });
    },
    checkpointResult(id: string, result: unknown, inputFingerprint?: string, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at); const parsed = JsonSchema.parse(result); if (parsed === null) throw Error('阶段结果不能为空');
      if (inputFingerprint !== undefined) z.string().min(1).max(1000).parse(inputFingerprint);
      return transaction(() => {
        const value = batch(id); if (!value || !['requesting', 'preparing'].includes(value.status)) throw Error('批次状态不可保存阶段结果');
        value.result = parsed; value.status = 'preparing'; value.updatedAt = at; value.error = null;
        if (inputFingerprint !== undefined) value.inputFingerprint = inputFingerprint;
        const attempt = value.attempts.at(-1); if (attempt?.status === 'requesting') { attempt.status = 'succeeded'; attempt.finishedAt = at; }
        saveBatch(value); return value;
      });
    },
    /** Retain paid JSON before reference validation; the request is not successful until promoted. */
    savePendingResponse(id: string, result: unknown, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at); const parsed = JsonSchema.parse(result);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed['pendingResponse']) throw Error('缺少待校验的已保存回答');
      return transaction(() => {
        const value = batch(id); if (!value || value.status !== 'requesting') throw Error('仅已发出请求的批次可保存待校验回答');
        value.result = parsed; value.updatedAt = at; value.error = null; saveBatch(value); return value;
      });
    },
    markApplied(id: string, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at);
      const value = batch(id); if (!value || !['result-ready', 'applied'].includes(value.status) || value.result === null) throw Error('只能提交已有结果的批次');
      value.status = 'applied'; value.updatedAt = at; value.error = null; saveBatch(value); return value;
    },
    failBatch(id: string, error: string, uncertain = false, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at); z.string().max(2000).parse(error);
      const value = batch(id); if (!value || value.status === 'applied' || value.status === 'result-ready') throw Error('批次状态不可标记失败');
      value.status = uncertain ? 'uncertain' : 'failed'; value.error = error; value.updatedAt = at;
      const attempt = value.attempts.at(-1); if (attempt?.status === 'requesting') { attempt.status = uncertain ? 'uncertain' : 'failed'; attempt.error = error; attempt.finishedAt = at; }
      saveBatch(value); return value;
    },
    retryBatch(id: string, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at);
      const value = batch(id); if (!value || !['failed', 'uncertain'].includes(value.status)) throw Error('仅失败或响应未知的批次可手动重试');
      if (value.messageIds.some(id => message(id)?.deleted)) throw Error('原文已清理，不能重新分析');
      value.status = 'pending'; value.error = null; value.updatedAt = at; saveBatch(value); return value;
    },
    reanalyzeBatch(id: string, at = nowInstant()): CaptureBatch {
      InstantSchema.parse(at);
      return transaction(() => {
        const value = batch(id); if (!value || !['applied', 'failed', 'uncertain'].includes(value.status)) throw Error('仅已完成、失败或响应未知的批次可重新分析');
        if (value.result && typeof value.result === 'object' && !Array.isArray(value.result) && value.result['attachmentsCleared']) throw Error('附件缓存已清理，不能重新分析不完整的资料；消息正文与已有事项仍保留');
        if (value.messageIds.some(id => message(id)?.deleted)) throw Error('原文已清理，不能重新分析');
        if (value.messageIds.some(id => attachments(id).some(item => item.status === 'deleted'))) throw Error('附件缓存已清理，不能重新分析不完整的资料；消息正文与已有事项仍保留');
        value.operationId = `qq-apply:${randomUUID()}`; value.result = null; value.inputFingerprint = null;
        value.status = 'pending'; value.updatedAt = at; value.error = null;
        for (const id of value.messageIds) for (const item of attachments(id)) {
          if (['failed', 'encrypted', 'too-large'].includes(item.status)) { item.status = 'pending'; item.error = null; saveAttachment(item); }
        }
        saveBatch(value); return value;
      });
    },
    recoverInterrupted,
    getCoverage(accountId: string, groupId: string): GroupCoverage | null {
      requireAccount(accountId);
      return parsePayload(db.prepare('SELECT payload FROM capture_coverage WHERE account_id=? AND group_id=?').get(IdSchema.parse(accountId), IdSchema.parse(groupId)), GroupCoverageSchema);
    },
    listCoverage(accountId?: string): GroupCoverage[] {
      if (accountId) requireAccount(accountId);
      const rows = accountId ? db.prepare('SELECT payload FROM capture_coverage WHERE account_id=? ORDER BY group_id').all(IdSchema.parse(accountId)) : db.prepare(`SELECT payload FROM capture_coverage WHERE ${scope()} ORDER BY account_id,group_id`).all();
      return rows.map(row => parsePayload(row, GroupCoverageSchema)!);
    },
    saveCoverage(value: unknown): GroupCoverage {
      const parsed = GroupCoverageSchema.parse(value);
      requireAccount(parsed.accountId);
      db.prepare('INSERT INTO capture_coverage(account_id,group_id,payload) VALUES(?,?,?) ON CONFLICT(account_id,group_id) DO UPDATE SET payload=excluded.payload').run(parsed.accountId, parsed.groupId, json(parsed)); return parsed;
    },
    attachment, attachments, chunks,
    listChunks(attachmentId: string, options: { offset?: number; limit?: number } = {}) {
      IdSchema.parse(attachmentId);
      const offset = z.number().int().min(0).max(10_000_000).parse(options.offset ?? 0);
      const limit = z.number().int().min(1).max(100).parse(options.limit ?? 5);
      if (!attachment(attachmentId)) return { items: [], total: 0, offset, limit };
      const total = Number(db.prepare('SELECT count(*) AS n FROM capture_chunks WHERE attachment_id=?').get(attachmentId)!['n']);
      const items = db.prepare('SELECT payload FROM capture_chunks WHERE attachment_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(attachmentId, limit, offset).map(row => parsePayload(row, ChunkSchema)!);
      return { items, total, offset, limit };
    },
    putAttachment(id: string, bytes: Uint8Array): StoredCaptureAttachment {
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw Error('附件超过 25 MB 自动处理限制');
      const value = attachment(id); if (!value || value.status === 'deleted') throw Error('附件记录不存在或已删除');
      const hash = digest(bytes);
      return transaction(() => {
        db.prepare('INSERT OR IGNORE INTO capture_blobs(hash,bytes) VALUES(?,?)').run(hash, bytes);
        value.hash = hash; value.size = bytes.length; value.status = 'extracting'; value.error = null; saveAttachment(value); return value;
      });
    },
    readAttachmentBytes(id: string): Buffer | null {
      const value = attachment(id); if (!value?.hash) return null;
      const row = db.prepare('SELECT bytes FROM capture_blobs WHERE hash=?').get(value.hash); return row ? Buffer.from(row['bytes'] as Uint8Array) : null;
    },
    setAttachmentStatus(id: string, status: StoredCaptureAttachment['status'], error: string | null = null): StoredCaptureAttachment {
      const value = attachment(id); if (!value) throw Error('附件记录不存在');
      value.status = AttachmentStatusSchema.parse(status); value.error = z.string().max(2000).nullable().parse(error); saveAttachment(value); return value;
    },
    saveExtraction(id: string, input: { extractorVersion: string; chunks: CaptureChunkInput[]; status?: StoredCaptureAttachment['status']; error?: string | null }): StoredCaptureAttachment {
      const value = attachment(id); if (!value || value.status === 'deleted') throw Error('附件记录不存在或已删除');
      const version = z.string().min(1).max(500).parse(input.extractorVersion);
      if (input.chunks.length > 10_000) throw Error('附件分片过多');
      const next = input.chunks.map(item => ChunkSchema.parse({ ...item, id: item.id ?? `qqc:${digest(`${id}:${item.ordinal}`)}`, attachmentId: id }));
      unique(next.map(item => String(item.ordinal)), '附件分片');
      return transaction(() => {
        db.prepare('DELETE FROM capture_chunks WHERE attachment_id=?').run(id);
        for (const item of next) db.prepare('INSERT INTO capture_chunks(id,attachment_id,ordinal,payload) VALUES(?,?,?,?)').run(item.id, id, item.ordinal, json(item));
        value.extractorVersion = version; value.status = input.status ?? (next.some(item => item.status !== 'ready') ? 'failed' : 'ready');
        value.error = input.error ?? (value.status === 'ready' && next.length === 0 ? '文件未提取到可分析内容' : null);
        if (!next.length && value.status === 'ready') value.status = 'failed';
        saveAttachment(value); return value;
      });
    },
    saveChunk(id: string, input: CaptureChunkInput): CaptureChunk {
      const owner = attachment(id); if (!owner || owner.status === 'deleted') throw Error('附件记录不存在或已删除');
      const item = ChunkSchema.parse({ ...input, id: input.id ?? `qqc:${digest(`${id}:${input.ordinal}`)}`, attachmentId: id });
      db.prepare('INSERT INTO capture_chunks(id,attachment_id,ordinal,payload) VALUES(?,?,?,?) ON CONFLICT(attachment_id,ordinal) DO UPDATE SET payload=excluded.payload').run(item.id, id, item.ordinal, json(item)); return item;
    },
    findExtraction(hash: string, extractorVersion: string): { attachment: StoredCaptureAttachment; chunks: CaptureChunk[] } | null {
      const row = db.prepare(`SELECT a.payload FROM capture_attachments a JOIN capture_messages m ON m.id=a.message_id WHERE a.hash=? AND json_extract(a.payload,'$.extractorVersion')=? AND json_extract(a.payload,'$.status')='ready' AND ${scope('m.account_id')} ORDER BY a.rowid LIMIT 1`).get(hash, extractorVersion);
      const value = parsePayload(row, StoredAttachmentSchema); return value ? { attachment: value, chunks: chunks(value.id) } : null;
    },
    previewAttachmentRetention(policy: AttachmentRetentionPolicy) { return planAttachmentRetention(db, policy).summary; },
    cleanAttachments(policy: AttachmentRetentionPolicy) {
      return transaction(() => applyAttachmentRetention(db, planAttachmentRetention(db, policy)));
    },
    cleanup(request: CaptureCleanupRequest) {
      const parsed = CaptureCleanupRequestSchema.parse(request);
      requireAccount(parsed.accountId);
      return transaction(() => {
        const args = [parsed.accountId]; const clauses = ['account_id=?', 'deleted=0'];
        if (parsed.groupId) { clauses.push('group_id=?'); args.push(parsed.groupId); }
        if (parsed.before) { clauses.push('julianday(sent_at)<julianday(?)'); args.push(parsed.before); }
        const rows = db.prepare(`SELECT payload FROM capture_messages WHERE ${clauses.join(' AND ')}`).all(...args);
        let removedAttachments = 0;
        for (const row of rows) {
          const value = parsePayload(row, StoredMessageSchema)!;
          const member = db.prepare('SELECT b.payload FROM capture_batches b JOIN capture_batch_messages bm ON bm.batch_id=b.id WHERE bm.message_id=?').get(value.id);
          const owner = parsePayload(member, BatchSchema);
          if (owner && ['preparing', 'requesting', 'result-ready'].includes(owner.status)) throw Error('所选消息正在处理或提交，请等待完成后再清理');
          if (owner?.status === 'pending') { owner.status = 'failed'; owner.error = '原文已清理，批次停止分析'; owner.updatedAt = nowInstant(); saveBatch(owner); }
          if (owner) {
            // Checkpoints can contain full document text and page images. Deleting only
            // attachment BLOBs would leave another copy of the originals in this JSON.
            owner.result = owner.status === 'applied' ? { cleaned: true } : null;
            if (owner.status !== 'applied') owner.error = '原文已清理，批次不能重新分析';
            owner.updatedAt = nowInstant(); saveBatch(owner);
          }
          value.text = ''; value.segments = []; value.senderId = null; value.senderName = ''; value.deleted = true; saveMessage(value);
          for (const item of attachments(value.id)) {
            removedAttachments++; item.locator = null; item.hash = null; item.status = 'deleted'; item.error = '原附件已清理';
            db.prepare('DELETE FROM capture_chunks WHERE attachment_id=?').run(item.id); saveAttachment(item);
          }
        }
        db.exec('DELETE FROM capture_blobs WHERE NOT EXISTS(SELECT 1 FROM capture_attachments a WHERE a.hash=capture_blobs.hash)');
        return { messages: rows.length, attachments: removedAttachments, stats: statistics() };
      });
    },
    stats: statistics,
    exportState(): CaptureExport {
      const rows = <T>(table: string, schema: z.ZodType<T>) => db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row => parsePayload(row, schema)!);
      const wechatConfig = parsePayload(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get('wechat:config'), CaptureConfigSchema);
      const state: CaptureExportState = {
        schemaVersion: 1, config: parsePayload(db.prepare('SELECT payload FROM capture_meta WHERE id=?').get('config'), CaptureConfigSchema)!, ...(wechatConfig ? { wechatConfig } : {}), selections: db.prepare('SELECT account_id,payload FROM capture_selections ORDER BY account_id').all().map(row => ({ accountId: row['account_id'] as string, groupIds: z.array(IdSchema).parse(JSON.parse(row['payload'] as string)) })),
        messages: rows('capture_messages', StoredMessageSchema), attachments: rows('capture_attachments', StoredAttachmentSchema),
        blobs: db.prepare('SELECT hash,bytes FROM capture_blobs ORDER BY hash').all().map(row => ({ hash: row['hash'] as string, bytes: Buffer.from(row['bytes'] as Uint8Array).toString('base64') })),
        chunks: rows('capture_chunks', ChunkSchema), batches: rows('capture_batches', BatchSchema), coverage: rows('capture_coverage', GroupCoverageSchema),
      };
      return { state, fingerprint: store.fingerprint(), stats: statistics() };
    },
    inspectState(value: unknown): CaptureExportState { return validateCaptureState(value); },
    replaceState(value: unknown, options: { expectedFingerprint?: string; pause?: boolean; recover?: boolean } = {}) {
      const state = validateCaptureState(value);
      transaction(() => {
        if (options.expectedFingerprint && store.fingerprint() !== options.expectedFingerprint) throw Error('采集数据已变化，请重新预览恢复');
        for (const table of ['capture_batch_messages', 'capture_chunks', 'capture_attachments', 'capture_blobs', 'capture_batches', 'capture_messages', 'capture_selections', 'capture_coverage']) db.exec(`DELETE FROM ${table}`);
        const nextConfig = options.pause === false ? state.config : { ...state.config, enabled: false, analysisEnabled: false };
        db.prepare("DELETE FROM capture_meta WHERE id IN ('credentialPause','credentialChange','priorityTurn','wechat:credentialPause','wechat:credentialChange','wechat:priorityTurn','wechat:config')").run();
        db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run('config', json(nextConfig));
        {
          const originalWechat = state.wechatConfig ?? CaptureConfigSchema.parse({ platform: 'wechat', enabled: false, analysisEnabled: false });
          const nextWechat = options.pause === false ? originalWechat : { ...originalWechat, enabled: false, analysisEnabled: false };
          db.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run('wechat:config', json(nextWechat));
        }
        for (const item of state.selections) db.prepare('INSERT INTO capture_selections(account_id,payload) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload').run(item.accountId, json(item.groupIds));
        for (const item of state.messages) saveMessage(item);
        for (const item of state.blobs) db.prepare('INSERT INTO capture_blobs(hash,bytes) VALUES(?,?)').run(item.hash, Buffer.from(item.bytes, 'base64'));
        for (const item of state.attachments) {
          if (options.recover !== false && ['downloading', 'extracting'].includes(item.status)) { item.status = 'pending'; item.error = null; }
          saveAttachment(item);
        }
        for (const item of state.chunks) db.prepare('INSERT INTO capture_chunks(id,attachment_id,ordinal,payload) VALUES(?,?,?,?)').run(item.id, item.attachmentId, item.ordinal, json(item));
        for (const item of state.batches) {
          if (options.recover !== false && item.status === 'requesting') {
            item.status = 'uncertain'; item.error = '恢复的请求结果未知，请确认后手动重试';
            const attempt = item.attempts.at(-1);
            if (attempt?.status === 'requesting') { attempt.status = 'uncertain'; attempt.error = item.error; attempt.finishedAt = nowInstant(); }
          }
          if (options.recover !== false && item.status === 'preparing') item.status = 'pending';
          saveBatch(item);
          for (const [ordinal, id] of item.messageIds.entries()) db.prepare('INSERT INTO capture_batch_messages(batch_id,message_id,ordinal) VALUES(?,?,?)').run(item.id, id, ordinal);
        }
        for (const item of state.coverage) db.prepare('INSERT INTO capture_coverage(account_id,group_id,payload) VALUES(?,?,?)').run(item.accountId, item.groupId, json(item));
      });
      return statistics();
    },
    close() { if (!internal.database) db.close(); },
  };
  if (!internal.skipRecovery) recoverInterrupted();
  return store;
}
export type CaptureStore = ReturnType<typeof createCaptureStore>;

/** Pure read for an existing SQLite backup connection; does not initialize or recover work. */
export function readCaptureDatabaseState(db: DatabaseSync): CaptureExportState {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_meta'").get()) return emptyCaptureState();
  return validateCaptureState(createCaptureStore(':memory:', { database: db, skipInitialize: true, skipRecovery: true, externalTransaction: true }).exportState().state);
}
/** Caller owns the transaction, making planner and capture replacement atomic together. */
export function replaceCaptureDatabaseState(db: DatabaseSync, state: unknown, options: { recover?: boolean } = {}): void {
  createCaptureStore(':memory:', { database: db, skipInitialize: true, skipRecovery: true, externalTransaction: true }).replaceState(state, { pause: options.recover !== false, recover: options.recover !== false });
}
export function emptyCaptureState(): CaptureExportState {
  return { schemaVersion: 1, config: CaptureConfigSchema.parse({}), selections: [], messages: [], attachments: [], blobs: [], chunks: [], batches: [], coverage: [] };
}
