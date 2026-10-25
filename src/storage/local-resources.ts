import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readPrivate, writePrivate } from '../remote/private-file';

export const LOCAL_RESOURCES_FILE = 'resource-locations.json';
const LocationSchema = z.strictObject({ id: z.string().uuid(), kind: z.enum(['file', 'folder']), path: z.string().min(1).max(32768), updatedAt: z.string().datetime() });
export const LocalResourceRegistrySchema = z.strictObject({ format: z.literal(1), deviceId: z.string().uuid(), deviceName: z.string().min(1).max(240), locations: z.array(LocationSchema).max(50000) })
  .refine(value => new Set(value.locations.map(location => location.id)).size === value.locations.length, '资料位置编号重复');
export type LocalResourceRegistry = z.infer<typeof LocalResourceRegistrySchema>;
export type LocalResourceLocation = LocalResourceRegistry['locations'][number];
export function readLocalResources(directory: string): LocalResourceRegistry | null {
  const value = readPrivate(join(directory, LOCAL_RESOURCES_FILE), 16 * 1024 * 1024);
  return value ? LocalResourceRegistrySchema.parse(JSON.parse(value.toString('utf8'))) : null;
}
export function writeLocalResources(directory: string, value: LocalResourceRegistry): void {
  writePrivate(join(directory, LOCAL_RESOURCES_FILE), JSON.stringify(LocalResourceRegistrySchema.parse(value)));
}
export function newLocalResources(): LocalResourceRegistry {
  return { format: 1, deviceId: randomUUID(), deviceName: hostname().slice(0, 240) || '这台电脑', locations: [] };
}
/** Exported only into an on-device backup. Shared planner exports never read this table. */
export function includeLocalResourcesInBackup(db: DatabaseSync, directory: string): void {
  const registry = readLocalResources(directory); if (!registry) return;
  db.exec('CREATE TABLE IF NOT EXISTS local_resource_registry (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO local_resource_registry(id,payload) VALUES(1,?)').run(JSON.stringify(registry));
}
export function readLocalResourcesFromBackup(db: DatabaseSync): LocalResourceRegistry | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_resource_registry'").get()) return null;
  const rows = db.prepare('SELECT id,payload FROM local_resource_registry').all();
  if (rows.length !== 1 || rows[0]!['id'] !== 1) throw Error('备份中的本机资料位置无效');
  return LocalResourceRegistrySchema.parse(JSON.parse(String(rows[0]!['payload'])));
}
/** Restore missing locations only. A more recent relocation must not be rolled back by an older backup. */
export function mergeLocalResources(directory: string, incoming: LocalResourceRegistry | null): void {
  if (!incoming) return;
  const current = readLocalResources(directory);
  // A backup from another computer must not silently claim ownership of its absolute paths.
  if (!current) return;
  if (current.deviceId !== incoming.deviceId) return;
  const locations = new Map(incoming.locations.map(location => [location.id, location]));
  for (const location of current.locations) locations.set(location.id, location);
  writeLocalResources(directory, { ...current, locations: [...locations.values()] });
}
export function writeLocalResourcesCompanion(directory: string, backupPath: string): void {
  const registry = readLocalResources(directory); if (!registry) return;
  writePrivate(`${backupPath}.local-resources.json`, JSON.stringify(registry));
}
export function readLocalResourcesCompanion(backupPath: string): LocalResourceRegistry | null {
  const path = `${backupPath}.local-resources.json`;
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) throw Error('本机资料位置备份不是文件');
  const bytes = readPrivate(path, 16 * 1024 * 1024);
  return bytes ? LocalResourceRegistrySchema.parse(JSON.parse(bytes.toString('utf8'))) : null;
}
