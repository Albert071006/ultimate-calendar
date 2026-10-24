import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRepository } from './repository';
import { createBackup } from './backups';
import { planBackupRetention, pruneManagedBackups } from './backup-retention';
import { saveSpacePolicy, readSpaceState } from './space-policy';
import { SpacePolicySchema } from '../shared/space';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-space-')); dirs.push(directory);
  const repo = createRepository(join(directory, 'planner.sqlite'));
  const folder = join(directory, 'backups'); mkdirSync(folder);
  const policy = SpacePolicySchema.parse({ autoBackupKeep: 2, safetyBackupKeep: 1 });
  saveSpacePolicy(directory, policy);
  repo.close();
  // A closed repository cannot back up: use a short-lived connection for each fixture.
  return { directory, folder, policy, backup: (kind: 'auto' | 'safety', age: number) => {
    const live = createRepository(join(directory, 'planner.sqlite'));
    const name = kind === 'auto' ? `auto-2026-01-01T00-00-00-000-08-00-${randomUUID()}.sqlite` : `before-restore-${randomUUID()}.sqlite`;
    const path = join(folder, name); createBackup(live, path); live.close();
    utimesSync(path, new Date(2026, 0, 1 - age), new Date(2026, 0, 1 - age)); return path;
  } };
}
describe('managed backup rotation', () => {
  it('rotates recognized backups only and preserves manual files and database', () => {
    const x = setup(), newest = x.backup('auto', 0), second = x.backup('auto', 1), old = x.backup('auto', 2);
    const safe = x.backup('safety', 0), olderSafe = x.backup('safety', 1);
    const manual = join(x.folder, 'before-investigation.sqlite'); writeFileSync(manual, 'keep');
    mkdirSync(join(x.folder, 'historical')); writeFileSync(join(x.folder, 'historical', 'file'), 'keep');
    const result = pruneManagedBackups(x.directory);
    expect(result.deletedCount).toBe(2);
    expect([newest, second, safe, manual, join(x.directory, 'planner.sqlite')].every(existsSync)).toBe(true);
    expect(existsSync(old)).toBe(false); expect(existsSync(olderSafe)).toBe(false);
  });
  it('keeps newest valid recovery points even above the target capacity', () => {
    const x = setup(), a = x.backup('auto', 0), b = x.backup('safety', 0); x.backup('auto', 1);
    const plan = planBackupRetention(x.directory, { ...x.policy, backupBudgetMiB: 0.001 });
    expect(plan.removable).toHaveLength(1);
    expect(plan.removable.map(item => item.path)).not.toContain(a); expect(plan.removable.map(item => item.path)).not.toContain(b);
    expect(plan.warnings.join()).toContain('最新可用备份');
  });
  it('does not rotate when newest backup is invalid or automatic cleaning is disabled', () => {
    const x = setup(), newest = x.backup('auto', 0), old = x.backup('auto', 1); x.backup('auto', 2);
    writeFileSync(newest, 'corrupt');
    expect(pruneManagedBackups(x.directory).deletedCount).toBe(0); expect(existsSync(old)).toBe(true);
    const y = setup(); y.backup('auto', 0); y.backup('auto', 1); const older = y.backup('auto', 2);
    saveSpacePolicy(y.directory, { ...y.policy, enabled: false });
    expect(pruneManagedBackups(y.directory).deletedCount).toBe(0); expect(existsSync(older)).toBe(true);
    expect(pruneManagedBackups(y.directory, true).deletedCount).toBe(1);
  });
  it('excludes files with SQLite sidecars and never follows linked directories', () => {
    const x = setup(); x.backup('auto', 0); x.backup('auto', 1); const busy = x.backup('auto', 2);
    writeFileSync(`${busy}-wal`, 'in use');
    const external = setup(), externalBackup = external.backup('auto', 3);
    symlinkSync(external.folder, join(x.folder, 'linked'), 'junction');
    expect(pruneManagedBackups(x.directory).deletedCount).toBe(0);
    expect(existsSync(busy)).toBe(true); expect(existsSync(externalBackup)).toBe(true);
  });
  it('rejects corrupt configuration without enabling default cleanup', () => {
    const x = setup(); writeFileSync(join(x.directory, 'space-management.json'), '{}broken');
    expect(() => readSpaceState(x.directory)).toThrow(); expect(() => pruneManagedBackups(x.directory)).toThrow();
  });
});
