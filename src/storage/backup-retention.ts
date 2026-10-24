import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBackupFile } from './backups';
import { readSpaceState, resolveBackupDirectory } from './space-policy';
import type { SpacePolicy } from '../shared/space';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const autoName = new RegExp(`^auto-\\d{4}-\\d{2}-\\d{2}T[0-9T-]+-${UUID}\\.sqlite$`, 'i');
const safetyName = new RegExp(`^before-(?:update|restore)-${UUID}\\.sqlite$`, 'i');
type Entry = { name: string; path: string; bytes: number; time: number; kind: 'auto' | 'safety' };
const verified = new Map<string, { bytes: number; time: number; valid: boolean }>();
export function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce((sum, name) => sum + directoryBytes(join(path, name)), 0);
}
function validStandaloneBackup(path: string): boolean {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) return false;
  try {
    const stat = lstatSync(path), cached = verified.get(path);
    if (cached && cached.bytes === stat.size && cached.time === stat.mtimeMs) return cached.valid;
    inspectBackupFile(path);
    if (verified.size > 30) verified.clear();
    verified.set(path, { bytes: stat.size, time: stat.mtimeMs, valid: true });
    return true;
  } catch { return false; }
}
export function planBackupRetention(directory: string, policy: SpacePolicy) {
  const folder = resolveBackupDirectory(directory);
  const warnings: string[] = [];
  const entries: Entry[] = [];
  const totalBytes = directoryBytes(folder);
  if (existsSync(folder) && !lstatSync(folder).isSymbolicLink()) {
    for (const name of readdirSync(folder)) {
      const kind = autoName.test(name) ? 'auto' : safetyName.test(name) ? 'safety' : null;
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (!kind || !stat.isFile() || stat.isSymbolicLink() || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) continue;
      entries.push({ name, path, kind, bytes: stat.size, time: stat.mtimeMs });
    }
  }
  entries.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  const protectedPaths = new Set<string>();
  const remove = new Set<Entry>();
  for (const kind of ['auto', 'safety'] as const) {
    const group = entries.filter(entry => entry.kind === kind);
    if (!group.length) continue;
    // Keep a verified newest recovery point from both backup families.
    if (!validStandaloneBackup(group[0]!.path)) {
      group.forEach(entry => protectedPaths.add(entry.path));
      warnings.push(`${kind === 'auto' ? '自动' : '更新／恢复前'}备份中最新一份未通过校验，本类备份暂不自动删除。`);
      continue;
    }
    protectedPaths.add(group[0]!.path);
    const keep = kind === 'auto' ? policy.autoBackupKeep : policy.safetyBackupKeep;
    group.slice(keep).forEach(entry => remove.add(entry));
  }
  const managedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let retainedBytes = managedBytes - [...remove].reduce((sum, entry) => sum + entry.bytes, 0);
  const budget = policy.backupBudgetMiB * 1024 * 1024;
  for (const entry of [...entries].reverse()) {
    if (retainedBytes <= budget) break;
    if (remove.has(entry) || protectedPaths.has(entry.path)) continue;
    remove.add(entry); retainedBytes -= entry.bytes;
  }
  if (retainedBytes > budget) warnings.push('为保留最新可用备份，备份占用仍超过目标容量。');
  return { totalBytes, managedBytes, unmanagedBytes: Math.max(0, totalBytes - managedBytes),
    count: entries.length, removable: [...remove], warnings };
}
export function pruneManagedBackups(directory: string, explicit = false) {
  const policy = readSpaceState(directory).policy;
  const plan = planBackupRetention(directory, policy);
  if (!explicit && !policy.enabled) return { deletedCount: 0, deletedBytes: 0, warnings: plan.warnings };
  let deletedCount = 0, deletedBytes = 0;
  const folder = resolveBackupDirectory(directory);
  // Only direct, recognized files beneath the verified application backup directory.
  if (existsSync(folder) && realpathSync(folder).toLowerCase() !== folder.toLowerCase()) return { deletedCount, deletedBytes, warnings: [...plan.warnings, '备份目录是链接，已跳过清理。'] };
  for (const entry of plan.removable) {
    try {
      const stat = lstatSync(entry.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || stat.mtimeMs !== entry.time
        || existsSync(`${entry.path}-wal`) || existsSync(`${entry.path}-shm`)) continue;
      unlinkSync(entry.path); deletedCount++; deletedBytes += entry.bytes;
    } catch { plan.warnings.push('部分旧备份正在使用或无法删除，已保留。'); }
  }
  return { deletedCount, deletedBytes, warnings: [...new Set(plan.warnings)] };
}
