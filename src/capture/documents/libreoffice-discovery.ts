import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { delimiter, isAbsolute, join, normalize } from 'node:path';
import type { LibreOfficeConfig } from './libreoffice';

/** Windows installations only: require LibreOffice's own Python beside soffice. */
export function libreOfficeProgramDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.PLANNER_LIBREOFFICE_DIR) {
    candidates.push(env.PLANNER_LIBREOFFICE_DIR, join(env.PLANNER_LIBREOFFICE_DIR, 'program'));
  }
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) candidates.push(join(env[key], 'LibreOffice', 'program'));
  }
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory) candidates.push(directory);
  }
  candidates.push('C:\\Software\\LibreOffice\\program', 'C:\\Software\\LibreOffice\\runtime\\program');
  const seen = new Set<string>();
  return candidates.filter(isAbsolute).map(normalize).filter(directory => {
    const key = directory.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function detectLibreOffice(directories = libreOfficeProgramDirectories()): Promise<LibreOfficeConfig | null> {
  for (const base of directories) {
    const sofficePath = join(base, 'soffice.exe');
    if (!existsSync(sofficePath)) continue;
    if (existsSync(join(base, 'python.exe'))) return { sofficePath, pythonPath: join(base, 'python.exe') };
    try {
      for (const entry of await readdir(base)) if (entry.startsWith('python-core-')) {
        const pythonPath = join(base, entry, 'bin', 'python.exe');
        if (existsSync(pythonPath)) return { sofficePath, pythonPath };
      }
    } catch { /* An incomplete installation is skipped; extraction reports missing components. */ }
  }
  return null;
}
