import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WorkflowError } from '../ai/deepseek';
import { RemoteClientError } from '../remote/node-client';
import { privatePath, readPrivate } from '../remote/private-file';
import { validateSafeBackup } from '../server/backup';
import { remoteOutputs } from '../server/protocol';
import { MAX_CLOUD_BACKUP_BYTES } from '../shared/cloud-management';
import type { ApiResult } from '../shared/contracts';
import type { RemoteMethod } from '../shared/remote';

type Rpc = (method: RemoteMethod, input?: unknown) => Promise<unknown>;
type Download = { totalBytes: number; sha256: string; chunks: AsyncIterable<Buffer>; finish?(): Promise<void> };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new WorkflowError('STORAGE', '云端安全备份校验失败，请重新导出。');

export async function openRemoteBackup(rpc: Rpc): Promise<ApiResult<Download>> {
  let response: unknown;
  try { response = await rpc('backupExportStart'); }
  catch (error) {
    // Previous servers reject unknown RPC names at the HTTP boundary. Only
    // negotiate here: a rejected or corrupt chunk must fail its own download.
    if (!(error instanceof RemoteClientError) || ![400, 404].includes(error.status)) throw error;
    const legacy = remoteOutputs.backupExportData.parse(await rpc('backupExportData'));
    if (!legacy.ok) return legacy;
    const bytes = Buffer.from(legacy.data.content);
    return { ok: true, data: { totalBytes: bytes.length, sha256: digest(bytes), chunks: (async function* () { yield bytes; })() } };
  }
  const result = remoteOutputs.backupExportStart.parse(response);
  if (!result.ok) return result;
  const { downloadId, totalBytes, sha256, chunkBytes } = result.data;
  async function* chunks() {
    for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
      const part = remoteOutputs.backupExportChunk.parse(await rpc('backupExportChunk', { downloadId, offset }));
      if (!part.ok) throw new WorkflowError(part.error.code, part.error.message);
      const bytes = Buffer.from(part.data.data, 'base64');
      if (part.data.downloadId !== downloadId || part.data.offset !== offset ||
          bytes.length !== Math.min(chunkBytes, totalBytes - offset) || bytes.toString('base64') !== part.data.data) throw invalid();
      yield bytes;
    }
  }
  return { ok: true, data: { totalBytes, sha256, chunks: chunks(), async finish() {
    // An expired ticket or a disconnected client is also reclaimed by the server TTL.
    try { await rpc('backupExportFinish', { downloadId }); } catch { /* preserve the download result */ }
  } } };
}

/** Publish only a complete, synced and independently read-back-verified file. */
export async function saveRemoteBackup(path: string, download: Download, beforePublish?: () => Promise<void>) {
  const target = privatePath(path), parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, '.pending-backup-' + randomUUID());
  const writer = await open(staging, 'wx', 0o600);
  let published = false;
  try {
    try {
      for await (const chunk of download.chunks) await writer.writeFile(chunk);
      await writer.sync();
    } finally { await writer.close(); }
    const saved = readPrivate(staging, MAX_CLOUD_BACKUP_BYTES);
    if (!saved || saved.length !== download.totalBytes || digest(saved) !== download.sha256) throw invalid();
    validateSafeBackup(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)));
    await beforePublish?.();
    await rename(staging, target);
    published = true;
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { if (!published) await unlink(staging); }
}
