import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privatePath } from './private-file';
import type { RemoteIdentity } from '../shared/remote';

export function remoteReceiptScope(origin: string, { identity, deviceId }: { identity: RemoteIdentity; deviceId: string }) {
  return JSON.stringify({ origin, identity: { protocolVersion: identity.protocolVersion, dataInstanceId: identity.dataInstanceId, generation: identity.generation }, deviceId });
}

export function scopedReceiptFile(legacy: string, scope: string) {
  return join(legacy + '.scopes', createHash('sha256').update(scope).digest('hex') + '.json');
}

export function receiptFiles(legacy: string) {
  const directory = privatePath(legacy + '.scopes');
  return existsSync(directory) ? readdirSync(directory).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(name => join(directory, name)) : [];
}

const active = new Map<string, Promise<unknown>>();
export function withReceiptLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = active.get(file) ?? Promise.resolve();
  const next = previous.then(work, work);
  active.set(file, next);
  const release = () => { if (active.get(file) === next) active.delete(file); };
  void next.then(release, release);
  return next;
}
