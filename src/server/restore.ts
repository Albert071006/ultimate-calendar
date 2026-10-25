import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createLedgerService, readLedgerDatabase, replaceLedgerDatabase, type LedgerService } from '../ledger/service';
import { openDatabase } from '../storage/database';
import { RemoteState } from './state';
import { validateSafeBackup } from './backup';

/** Restore only to a new/empty directory; the original backup and existing stores stay untouched. */
export function restoreSafeBackup(options: { backupFile: string; dataDirectory: string }) {
  if (!isAbsolute(options.backupFile) || !isAbsolute(options.dataDirectory)) throw Error('备份文件与恢复目录必须为绝对路径');
  const requested = resolve(options.dataDirectory);
  if (requested === parse(requested).root) throw Error('恢复目录不能是磁盘根目录');
  const backupStat = lstatSync(options.backupFile);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw Error('请选择普通安全备份 JSON 文件');
  // Parsing and semantic validation happen before creating any staging directory.
  const payload = validateSafeBackup(JSON.parse(readFileSync(options.backupFile, 'utf8')));
  const parent = realpathSync(dirname(requested)), target = join(parent, basename(requested));
  const initial = existsSync(target) ? lstatSync(target) : null;
  if (initial && (!initial.isDirectory() || initial.isSymbolicLink() || readdirSync(target).length)) throw Error('只允许恢复到全新或空目录；不会覆盖已有资料');
  const stage = mkdtempSync(join(parent, '.calendar-restore-'));
  const verifiedStage = realpathSync(stage), stageRelative = relative(parent, verifiedStage);
  const safeStage = dirname(verifiedStage) === parent && stageRelative !== '..' && !stageRelative.includes(sep) && /^\.calendar-restore-[A-Za-z0-9]+$/.test(stageRelative);
  if (!safeStage) throw Error('恢复临时目录超出预期父目录，已停止');
  if (process.platform !== 'win32') chmodSync(stage, 0o700);
  let repository: Repository | undefined, ledger: LedgerService | undefined, state: RemoteState | undefined, published = false;
  try {
    const databasePath = join(stage, 'planner.sqlite');
    repository = createRepository(databasePath, { automaticBackup: () => {} });
    repository.replaceState(payload.planner, db => replaceLedgerDatabase(db, payload.ledger));
    ledger = createLedgerService(databasePath);
    if (JSON.stringify(repository.read()) !== JSON.stringify(payload.planner)) throw Error('恢复后日历资料核对不一致');
    const restoredLedger = ledger.exportJson();
    const { revision: _revision, ...expectedLedger } = payload.ledger;
    if (JSON.stringify(restoredLedger) !== JSON.stringify({ format: 'ultimate-calendar-ledger', formatVersion: 1, ...expectedLedger })) throw Error('恢复后账本核对不一致');
    ledger.close(); ledger = undefined; repository.close(); repository = undefined;
    const verified = openDatabase(databasePath, true);
    try { if (verified.prepare('PRAGMA integrity_check').get()!['integrity_check'] !== 'ok') throw Error('恢复数据库完整性校验失败'); readLedgerDatabase(verified); } finally { verified.close(); }
    // Device sessions, transport receipts, VAPID material and API keys are not in the backup.
    state = new RemoteState(join(stage, 'remote-state.sqlite')); const identity = state.identity(); state.close(); state = undefined;
    if (process.platform !== 'win32') for (const file of readdirSync(stage)) chmodSync(join(stage, file), 0o600);
    const current = existsSync(target) ? lstatSync(target) : null;
    if (initial) {
      if (!current || !current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || readdirSync(target).length) throw Error('恢复目标在处理期间改变，未覆盖');
      // Non-recursive removal atomically refuses any directory that gained contents.
      rmdirSync(target);
    } else if (current) throw Error('恢复目标在处理期间已创建，未覆盖');
    renameSync(stage, target); published = true;
    return { dataDirectory: target, identity, taskCount: payload.planner.entities.task.length, ledgerEntryCount: payload.ledger.entries.length };
  } finally {
    ledger?.close(); repository?.close(); state?.close();
    if (!published && existsSync(stage)) {
      // This exact sibling was newly created by mkdtemp above; never remove the user target.
      const actual = realpathSync(stage);
      if (actual !== verifiedStage || dirname(actual) !== parent || !/^\.calendar-restore-[A-Za-z0-9]+$/.test(basename(actual))) throw Error('临时恢复目录身份改变，未自动清理');
      rmSync(actual, { recursive: true, force: true });
    }
  }
}
