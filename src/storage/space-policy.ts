import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SpacePolicySchema, type SpacePolicy } from '../shared/space';

const StateSchema = z.strictObject({
  policy: SpacePolicySchema,
  backupDirectory: z.string().refine(path => isAbsolute(path) && resolve(path) !== parse(path).root, '备份目录必须为磁盘根目录以外的绝对路径').optional(),
  lastRunAt: z.string().nullable().default(null),
  lastResult: z.string().nullable().default(null),
});
export type SpaceState = z.infer<typeof StateSchema>;
export function readSpaceState(directory: string): SpaceState {
  const path = join(directory, 'space-management.json');
  if (!existsSync(path)) return { policy: SpacePolicySchema.parse({}), lastRunAt: null, lastResult: null };
  // A damaged configuration must never silently enable deletion with default rules.
  return StateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function writeSpaceState(directory: string, value: SpaceState): void {
  const state = StateSchema.parse(value);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'space-management.json');
  const temporary = join(directory, `space-management-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) rmSync(temporary); }
}
export function saveSpacePolicy(directory: string, policy: SpacePolicy): void {
  writeSpaceState(directory, { ...readSpaceState(directory), policy: SpacePolicySchema.parse(policy) });
}

function safeBackupDirectory(dataDirectory: string, chosen: string): string {
  const folder = resolve(chosen);
  if (!isAbsolute(chosen) || folder === parse(folder).root) throw Error('备份目录必须为磁盘根目录以外的绝对路径');
  const dataFromBackup = relative(folder, resolve(dataDirectory));
  const outside = dataFromBackup === '..' || dataFromBackup.startsWith(`..${sep}`) || isAbsolute(dataFromBackup);
  if (!outside) {
    throw Error('备份目录不能是资料目录本身或其上级目录');
  }
  return folder;
}

/** Host-selected filesystem location; this is deliberately not accepted through renderer IPC. */
export function resolveBackupDirectory(dataDirectory: string): string {
  const chosen = readSpaceState(dataDirectory).backupDirectory;
  return safeBackupDirectory(dataDirectory, chosen ?? join(dataDirectory, 'backups'));
}

/** Main calls this before opening repositories. Isolated runs cannot inherit a production backup path. */
export function initializeBackupDirectory(dataDirectory: string, documentsDirectory: string, isolatedProfile = false, applicationDirectory = '终极日历'): string {
  const state = readSpaceState(dataDirectory);
  const chosen = isolatedProfile ? join(dataDirectory, 'backups') : state.backupDirectory ?? join(documentsDirectory, applicationDirectory, '备份');
  const backupDirectory = safeBackupDirectory(dataDirectory, chosen);
  mkdirSync(backupDirectory, { recursive: true });
  if (state.backupDirectory !== backupDirectory) writeSpaceState(dataDirectory, { ...state, backupDirectory });
  return backupDirectory;
}
