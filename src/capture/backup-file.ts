import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { IdSchema } from '../shared/contracts';
import { CaptureConfigSchema, GroupCoverageSchema, capturePlatform, type CaptureConfig } from '../shared/capture';
import { nowInstant } from '../domain/time';
import { captureBackupSchemas, captureMessageId } from './store';

const TABLES = ['capture_meta', 'capture_selections', 'capture_messages', 'capture_blobs', 'capture_attachments', 'capture_chunks', 'capture_batches', 'capture_batch_messages', 'capture_coverage'] as const;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const count = (db: DatabaseSync, table: typeof TABLES[number]) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']);
function assert(valid: unknown, message: string): asserts valid { if (!valid) throw Error(message); }
const payload = (row: Record<string, unknown>) => JSON.parse(String(row['payload']));
function noRows(db: DatabaseSync, sql: string, message: string) { assert(!db.prepare(sql).get(), message); }

export interface CaptureBackupSummary { messages: number; attachments: number; config: CaptureConfig; wechatConfig?: CaptureConfig }

/** Validate one payload/BLOB at a time. Never create a base64 copy of the complete attachment archive. */
export function inspectCaptureBackupFile(db: DatabaseSync): CaptureBackupSummary | null {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'capture_*'").all().map(row => String(row['name']));
  if (!tables.length) return null;
  assert(tables.length === TABLES.length && TABLES.every(table => tables.includes(table)), 'QQ 采集备份表不完整或版本不支持');
  assert(db.prepare("SELECT payload FROM capture_meta WHERE id='schemaVersion'").get()?.['payload'] === '1', 'QQ 采集备份版本不支持');
  assert(!db.prepare('PRAGMA foreign_key_check').get(), 'QQ 采集备份关联校验失败');
  for (const table of TABLES.filter(table => table !== 'capture_blobs' && table !== 'capture_batch_messages')) {
    noRows(db, `SELECT 1 FROM ${table} WHERE length(payload)>40000000 LIMIT 1`, 'QQ 采集备份单条记录过大');
  }
  const config = CaptureConfigSchema.parse(payload(db.prepare("SELECT payload FROM capture_meta WHERE id='config'").get() ?? {}));
  assert(config.platform !== 'wechat' && (!config.accountId || capturePlatform(config.accountId) === 'qq'), 'QQ 备份配置的平台不匹配');
  const wechatRow = db.prepare("SELECT payload FROM capture_meta WHERE id='wechat:config'").get();
  const wechatConfig = wechatRow ? CaptureConfigSchema.parse(payload(wechatRow)) : undefined;
  assert(!wechatConfig || wechatConfig.platform === 'wechat' && (!wechatConfig.accountId || capturePlatform(wechatConfig.accountId) === 'wechat'), '微信备份配置的平台不匹配');
  for (const row of db.prepare('SELECT * FROM capture_selections').iterate()) {
    IdSchema.parse(row['account_id']);
    const groups = z.array(IdSchema).max(100).parse(payload(row));
    assert(new Set(groups).size === groups.length, '群选择不能重复');
  }
  for (const row of db.prepare('SELECT * FROM capture_messages').iterate()) {
    const item = captureBackupSchemas.message.parse(payload(row));
    assert(item.id === row['id'] && item.accountId === row['account_id'] && item.groupId === row['group_id']
      && item.messageId === row['message_id'] && item.sentAt === row['sent_at'] && item.importedAt === row['imported_at']
      && Number(item.deleted) === row['deleted'], 'QQ 消息索引与内容不一致');
    assert(captureMessageId(item.accountId, item.groupId, item.messageId) === item.id, '消息标识与 QQ 来源不匹配');
  }
  // Check length in SQLite before materializing bytes into JavaScript.
  noRows(db, `SELECT 1 FROM capture_blobs WHERE typeof(bytes)!='blob' OR length(bytes)>${MAX_ATTACHMENT_BYTES} LIMIT 1`, '附件内容超出单个文件上限');
  for (const row of db.prepare('SELECT hash,bytes FROM capture_blobs').iterate()) {
    assert(row['bytes'] instanceof Uint8Array && createHash('sha256').update(row['bytes']).digest('hex') === row['hash'], '附件内容校验失败');
  }
  const message = db.prepare('SELECT account_id,group_id FROM capture_messages WHERE id=?');
  const blob = db.prepare('SELECT 1 FROM capture_blobs WHERE hash=?');
  const attachment = db.prepare('SELECT 1 FROM capture_attachments WHERE id=?');
  for (const row of db.prepare('SELECT * FROM capture_attachments').iterate()) {
    const item = captureBackupSchemas.attachment.parse(payload(row));
    assert(item.id === row['id'] && item.messageId === row['message_id'] && item.hash === row['hash'], 'QQ 附件索引与内容不一致');
    assert(message.get(item.messageId) && (!item.hash || blob.get(item.hash)), '附件来源或内容不存在');
  }
  for (const row of db.prepare('SELECT * FROM capture_chunks').iterate()) {
    const item = captureBackupSchemas.chunk.parse(payload(row));
    assert(item.id === row['id'] && item.attachmentId === row['attachment_id'] && item.ordinal === row['ordinal'], 'QQ 附件分片索引与内容不一致');
    assert(attachment.get(item.attachmentId), '附件分片来源不存在');
  }
  const members = db.prepare('SELECT message_id,ordinal FROM capture_batch_messages WHERE batch_id=? ORDER BY ordinal');
  for (const row of db.prepare('SELECT * FROM capture_batches').iterate()) {
    const item = captureBackupSchemas.batch.parse(payload(row));
    assert(item.id === row['id'] && item.accountId === row['account_id'] && item.groupId === row['group_id']
      && item.status === row['status'] && item.createdAt === row['created_at'], 'QQ 批次索引与内容不一致');
    assert(new Set(item.messageIds).size === item.messageIds.length && new Set(item.attempts.map(attempt => attempt.id)).size === item.attempts.length, '批次成员或请求尝试重复');
    assert(!['result-ready', 'applied'].includes(item.status) || item.result !== null, '已完成批次缺少结果');
    const actual = members.all(item.id);
    assert(actual.length === item.messageIds.length && actual.every((member, ordinal) => member['ordinal'] === ordinal && member['message_id'] === item.messageIds[ordinal]), 'QQ 批次与消息成员关系不一致');
    for (const id of item.messageIds) {
      const owner = message.get(id);
      assert(owner?.['account_id'] === item.accountId && owner?.['group_id'] === item.groupId, '批次消息来源无效');
    }
  }
  for (const row of db.prepare('SELECT * FROM capture_coverage').iterate()) {
    const item = GroupCoverageSchema.parse(payload(row));
    assert(item.accountId === row['account_id'] && item.groupId === row['group_id'], 'QQ 历史覆盖索引与内容不一致');
  }
  for (const [table, key] of [
    ['capture_messages', 'id'], ['capture_attachments', 'id'], ['capture_chunks', 'id'], ['capture_batches', 'id'],
    ['capture_blobs', 'hash'], ['capture_selections', 'account_id'], ['capture_coverage', 'account_id,group_id'],
    ['capture_chunks', 'attachment_id,ordinal'], ['capture_batch_messages', 'message_id'],
    ['capture_batches', "json_extract(payload,'$.operationId')"],
  ] as const) noRows(db, `SELECT 1 FROM ${table} GROUP BY ${key} HAVING count(*)>1 LIMIT 1`, 'QQ 采集记录存在重复标识');
  noRows(db, 'SELECT 1 FROM capture_batch_messages bm LEFT JOIN capture_batches b ON b.id=bm.batch_id LEFT JOIN capture_messages m ON m.id=bm.message_id WHERE b.id IS NULL OR m.id IS NULL LIMIT 1', 'QQ 批次成员来源不存在');
  return { messages: count(db, 'capture_messages'), attachments: count(db, 'capture_attachments'), config, ...(wechatConfig ? { wechatConfig } : {}) };
}

const COLUMNS = {
  capture_selections: ['account_id', 'payload'],
  capture_messages: ['id', 'account_id', 'group_id', 'message_id', 'sent_at', 'imported_at', 'deleted', 'payload'],
  capture_blobs: ['hash', 'bytes'],
  capture_attachments: ['id', 'message_id', 'hash', 'payload'],
  capture_chunks: ['id', 'attachment_id', 'ordinal', 'payload'],
  capture_batches: ['id', 'account_id', 'group_id', 'status', 'created_at', 'payload'],
  capture_batch_messages: ['batch_id', 'message_id', 'ordinal'],
  capture_coverage: ['account_id', 'group_id', 'payload'],
} as const;

/** Caller owns the destination transaction and keeps the validated source read transaction open. */
export function copyCaptureBackupFile(source: DatabaseSync, destination: DatabaseSync, summary: CaptureBackupSummary): void {
  for (const table of ['capture_batch_messages', 'capture_chunks', 'capture_attachments', 'capture_blobs', 'capture_batches', 'capture_messages', 'capture_selections', 'capture_coverage']) destination.exec(`DELETE FROM ${table}`);
  const config = { ...summary.config, enabled: false, analysisEnabled: false };
  destination.prepare("UPDATE capture_meta SET payload=? WHERE id='config'").run(JSON.stringify(config));
  destination.prepare("DELETE FROM capture_meta WHERE id IN ('credentialPause','credentialChange','priorityTurn','wechat:credentialPause','wechat:credentialChange','wechat:priorityTurn','wechat:config')").run();
  destination.prepare('INSERT INTO capture_meta(id,payload) VALUES(?,?)').run('wechat:config', JSON.stringify({ ...(summary.wechatConfig ?? CaptureConfigSchema.parse({ platform: 'wechat' })), enabled: false, analysisEnabled: false }));
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const insert = destination.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    for (const row of source.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).iterate()) {
      if (table === 'capture_attachments') {
        const item = captureBackupSchemas.attachment.parse(payload(row));
        if (['downloading', 'extracting'].includes(item.status)) { item.status = 'pending'; item.error = null; }
        row['payload'] = JSON.stringify(item);
      }
      if (table === 'capture_batches') {
        const item = captureBackupSchemas.batch.parse(payload(row));
        if (item.status === 'requesting') {
          item.status = 'uncertain'; item.error = '恢复的请求结果未知，请确认后手动重试';
          const attempt = item.attempts.at(-1);
          if (attempt?.status === 'requesting') { attempt.status = 'uncertain'; attempt.error = item.error; attempt.finishedAt = nowInstant(); }
        }
        if (item.status === 'preparing') item.status = 'pending';
        row['status'] = item.status; row['payload'] = JSON.stringify(item);
      }
      insert.run(...columns.map(column => row[column]!));
    }
  }
}
