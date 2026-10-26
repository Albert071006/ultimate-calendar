import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopEdition, desktopStartup } from './desktop-edition';
import { initializeBackupDirectory } from '../storage/space-policy';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const documents = mkdtempSync(join(tmpdir(), 'calendar-edition-')); roots.push(documents);
  mkdirSync(join(documents, '终极日历'));
  return { documents, connection: join(documents, '终极日历', 'desktop-connection.json') };
}

describe('independent local desktop edition', () => {
  it.each(['broken-json', JSON.stringify({ profile: 'invalid-profile', configFile: 'missing.json' })])('ignores existing cloud selection without reading or modifying it (%s)', value => {
    const f = fixture(); writeFileSync(f.connection, value);
    const selected = desktopStartup([], f.documents, true);
    expect(selected).toEqual({ profile: null, directory: join(f.documents, '终极日历本地版', '数据'), remoteConfig: null });
    expect(readFileSync(f.connection, 'utf8')).toBe(value);
    expect(() => desktopStartup([], f.documents, false)).toThrow();
  });
  it('preserves standard startup and keeps data, backups, app ID and updates distinct', () => {
    const f = fixture();
    expect(desktopStartup([], f.documents, false).directory).toBe(join(f.documents, '终极日历', '数据'));
    const local = desktopStartup([], f.documents, true), edition = desktopEdition(true);
    expect(initializeBackupDirectory(local.directory, f.documents, false, edition.directoryName)).toBe(join(f.documents, '终极日历本地版', '备份'));
    expect(edition.appId).not.toBe(desktopEdition(false).appId);
    expect(edition.updateChannel).toBe('local');
    expect(desktopEdition(false).updateChannel).toBe('latest');
  });
  it.each(['--planner-remote-config=C:\\synthetic\\remote.json', '--planner-capture-only'])('rejects cloud-only launch flag %s before opening any config', flag => {
    expect(() => desktopStartup([flag], 'unused', true)).toThrow('不接受云端');
  });
  it('supports an explicit isolated developer profile and never borrows production backups', () => {
    const f = fixture(), profile = 'C:\\synthetic\\local-profile';
    expect(desktopStartup([`--planner-profile=${profile}`], f.documents, true)).toMatchObject({ profile, directory: profile, remoteConfig: null });
    const isolated = join(f.documents, 'test-profile');
    expect(initializeBackupDirectory(isolated, f.documents, true, desktopEdition(true).directoryName)).toBe(join(isolated, 'backups'));
  });
});
