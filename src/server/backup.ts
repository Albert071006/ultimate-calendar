import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseState, type Repository, type StoredState } from '../storage/repository';
import { validateLedgerData, type LedgerService } from '../ledger/service';
import { LedgerDataSchema, LedgerImportPayloadSchema } from '../shared/ledger';

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
  const dataDirectory = dirname(options.repository.path), directory = resolve(options.directory ?? join(dirname(dataDirectory), `${basename(dataDirectory)}-backups`));
  if (!isAbsolute(options.directory ?? directory)) throw Error('安全备份目录必须为绝对路径');
  const delta = relative(directory, resolve(dataDirectory));
  if (!delta || !delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta)) throw Error('安全备份目录不能是资料目录或其上级');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const planner = sanitizePlanner(options.repository.read());
  // Older internal request fingerprints may be literal JSON. Preserve their ID as
  // a replay barrier without exporting a hidden copy of imported source content.
  const ledger = options.ledger.exportJson();
  ledger.sources = ledger.sources.map(source => ({ ...source, label: '账本来源（原文已清理）', content: '', checksum: '' }));
  const now = options.now ?? new Date();
  const value = EnvelopeSchema.parse({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: now.toISOString(), planner, ledger });
  const filename = `safe-auto-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`, target = join(directory, filename), temporary = join(directory, `.safe-backup-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, target); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  // Rotate only our recognized, validated exports. Unknown files and symlinks stay untouched.
  const recognized = readdirSync(directory).filter(name => /^safe-auto-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name)).filter(name => {
    const file = join(directory, name);
    try { if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return false; validateSafeBackup(JSON.parse(readFileSync(file, 'utf8'))); return true; } catch { return false; }
  }).sort().reverse();
  for (const name of recognized.slice(7)) unlinkSync(join(directory, name));
  return target;
}
