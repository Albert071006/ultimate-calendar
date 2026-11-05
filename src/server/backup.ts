import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseState, readDatabaseState, type Repository, type StoredState } from '../storage/repository';
import { openDatabase } from '../storage/database';
import { readLedgerDatabase, validateLedgerData, type LedgerService } from '../ledger/service';
import { LedgerDataSchema, LedgerImportPayloadSchema, type LedgerImportPayload } from '../shared/ledger';

export const SOURCE_PLACEHOLDER = '原文已清理；此处保留提炼结果。';
/** Source payloads can occur in snapshots, journals and internal receipts. */
export function redactEvidence<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactEvidence(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'captureRef').map(([key, item]) => [key, redactEvidence(item)]));
  if ('imageDataUrl' in record && 'importedAt' in record && ['image', 'text'].includes(String(record.kind))) {
    next.kind = 'text'; next.text = SOURCE_PLACEHOLDER; next.imageDataUrl = null;
    next.label = record.label === '采集电脑提炼' ? '采集电脑提炼' : '手机导入（原文已清理）';
  }
  if ('sourceQuote' in record) { next.sourceQuote = ''; next.temporalEvidence = []; }
  return next as T;
}
const EnvelopeSchema = z.strictObject({
  format: z.literal('ultimate-calendar-safe-backup'), formatVersion: z.literal(1), createdAt: z.string().datetime(),
  planner: z.unknown(), ledger: LedgerImportPayloadSchema,
});
// Bounded per-process cache: the persistent worker reuses only unchanged files.
// Restoring a backup never consults this rotation-only cache.
const validatedBackups = new Map<string, Map<string, string>>();
function backupFileIdentity(file: string): string | null {
  const stat = lstatSync(file, { bigint: true });
  return stat.isFile() && !stat.isSymbolicLink()
    ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':') : null;
}
function sanitizePlanner(input: StoredState): StoredState {
  const planner = parseState(redactEvidence(input));
  for (const operation of planner.operations) if (operation.fingerprint.startsWith('{')) operation.fingerprint = `redacted:${createHash('sha256').update(operation.fingerprint).digest('hex')}`;
  return planner;
}
/** Validate the complete format and money/relationship semantics before any restore writes. */
export function validateSafeBackup(input: unknown) {
  const envelope = EnvelopeSchema.parse(input), planner = parseState(envelope.planner);
  const { format: _format, formatVersion: _version, ...fields } = envelope.ledger;
  const ledger = LedgerDataSchema.parse({ ...fields, revision: 0 }); validateLedgerData(ledger);
  ledger.sources = ledger.sources.map(source => ({ ...source, label: '账本来源（原文已清理）', content: '', checksum: '' }));
  return { planner: sanitizePlanner(planner), ledger };
}
export function createSafeBackup(options: { repository: Repository; ledger: LedgerService; directory?: string; now?: Date }): string {
  if (options.repository.path !== ':memory:') return createSafeBackupFromDatabase({ databasePath: options.repository.path, directory: options.directory, now: options.now });
  return writeSafeBackup({ dataDirectory: dirname(options.repository.path), planner: options.repository.read(), ledger: options.ledger.exportJson(), directory: options.directory, now: options.now });
}
/** One read transaction pins planner AND ledger to the same committed WAL snapshot. */
export function createSafeBackupFromDatabase(options: { databasePath: string; directory?: string; now?: Date }): string {
  const db = openDatabase(options.databasePath, true);
  let planner: StoredState, ledger: LedgerImportPayload;
  try {
    db.exec('BEGIN');
    planner = readDatabaseState(db);
    const { entries, balanceSnapshots, rules, audit, sources, accounts } = readLedgerDatabase(db);
    ledger = { format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots, rules, audit, sources, ...(accounts !== undefined ? { accounts } : {}) };
    db.exec('COMMIT');
  } finally { db.close(); }
  return writeSafeBackup({ ...options, dataDirectory: dirname(options.databasePath), planner, ledger });
}
function writeSafeBackup(options: { dataDirectory: string; planner: StoredState; ledger: LedgerImportPayload; directory?: string; now?: Date }): string {
  const dataDirectory = options.dataDirectory, directory = resolve(options.directory ?? join(dirname(dataDirectory), `${basename(dataDirectory)}-backups`));
  if (!isAbsolute(options.directory ?? directory)) throw Error('安全备份目录必须为绝对路径');
  const delta = relative(directory, resolve(dataDirectory));
  if (!delta || !delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta)) throw Error('安全备份目录不能是资料目录或其上级');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const planner = sanitizePlanner(options.planner);
  // Older internal request fingerprints may be literal JSON. Preserve their ID as
  // a replay barrier without exporting a hidden copy of imported source content.
  const ledger = options.ledger;
  ledger.sources = ledger.sources.map(source => ({ ...source, label: '账本来源（原文已清理）', content: '', checksum: '' }));
  const now = options.now ?? new Date();
  const value = EnvelopeSchema.parse({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: now.toISOString(), planner, ledger });
  const filename = `safe-auto-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`, target = join(directory, filename), temporary = join(directory, `.safe-backup-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    const identity = backupFileIdentity(temporary);
    validateSafeBackup(JSON.parse(readFileSync(temporary, 'utf8')));
    if (!identity || backupFileIdentity(temporary) !== identity) throw Error('安全备份校验期间文件发生变化');
    // Publish only a completely read-back-validated export. A failed export
    // must not appear as a recovery point or trigger retention of old files.
    renameSync(temporary, target);
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  // Rotate only our recognized, validated exports. Unknown files and symlinks stay untouched.
  let cache = validatedBackups.get(directory);
  if (!cache) {
    if (validatedBackups.size >= 16) validatedBackups.delete(validatedBackups.keys().next().value!);
    cache = new Map(); validatedBackups.set(directory, cache);
  }
  // The renamed file was validated in staging; restore still validates anew.
  const targetIdentity = backupFileIdentity(target);
  if (!targetIdentity) throw Error('安全备份文件无法确认');
  cache.set(filename, targetIdentity);
  const names = readdirSync(directory).filter(name => /^safe-auto-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name));
  const present = new Set(names);
  for (const name of cache.keys()) if (!present.has(name)) cache.delete(name);
  const recognized = names.filter(name => {
    const file = join(directory, name);
    try {
      const identity = backupFileIdentity(file);
      if (!identity) { cache.delete(name); return false; }
      if (cache.get(name) === identity) return true;
      cache.delete(name);
      validateSafeBackup(JSON.parse(readFileSync(file, 'utf8')));
      if (backupFileIdentity(file) !== identity) return false;
      cache.set(name, identity); return true;
    } catch { cache.delete(name); return false; }
  }).sort().reverse();
  for (const name of recognized.slice(7)) {
    const file = join(directory, name);
    if (backupFileIdentity(file) === cache.get(name)) unlinkSync(file);
    cache.delete(name);
  }
  return target;
}
