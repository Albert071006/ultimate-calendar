import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { detectLibreOffice, libreOfficeProgramDirectories } from './libreoffice-discovery';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-libreoffice-discovery-'));
  temporaryDirectories.push(directory);
  return directory;
}
async function file(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'synthetic executable path; never launched');
}

describe('LibreOffice component discovery', () => {
  it('checks custom and standard installation paths, quoted PATH entries, and removes duplicates', () => {
    const base = join(tmpdir(), 'office discovery'), custom = join(base, 'custom');
    const programFiles = join(base, 'Program Files'), pathDirectory = join(base, 'from path');
    const paths = libreOfficeProgramDirectories({
      PLANNER_LIBREOFFICE_DIR: custom,
      ProgramFiles: programFiles,
      ProgramW6432: programFiles,
      PATH: [`"${pathDirectory}"`, pathDirectory, '.', ''].join(delimiter),
    });
    expect(paths.slice(0, 4)).toEqual([custom, join(custom, 'program'), join(programFiles, 'LibreOffice', 'program'), pathDirectory]);
    expect(paths.filter(path => path === pathDirectory)).toHaveLength(1);
    expect(paths).not.toContain('.');
  });
  it('requires the bundled Python and continues past incomplete installations', async () => {
    const root = await fixture(), incomplete = join(root, 'incomplete'), complete = join(root, 'complete');
    await file(join(incomplete, 'soffice.exe'));
    await file(join(complete, 'soffice.exe'));
    await file(join(complete, 'python.exe'));
    expect(await detectLibreOffice([incomplete, complete])).toEqual({ sofficePath: join(complete, 'soffice.exe'), pythonPath: join(complete, 'python.exe') });
  });
  it('detects the versioned Python distribution shipped by LibreOffice', async () => {
    const base = await fixture(), pythonPath = join(base, 'python-core-test', 'bin', 'python.exe');
    await file(join(base, 'soffice.exe'));
    await file(pythonPath);
    expect(await detectLibreOffice([base])).toEqual({ sofficePath: join(base, 'soffice.exe'), pythonPath });
  });
  it('returns unavailable when no complete runtime is present', async () => {
    const base = await fixture();
    await file(join(base, 'python.exe'));
    expect(await detectLibreOffice([base, join(base, 'absent')])).toBeNull();
  });
});
