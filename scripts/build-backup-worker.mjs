import { build } from 'esbuild';
import { rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function buildBackupWorker(outfile) {
  const temporary = `${outfile}.${randomUUID()}.tmp`;
  try {
    await build({ entryPoints: ['src/storage/backup-worker.ts'], outfile: temporary, bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, define: { 'import.meta.url': 'undefined' } });
    await rename(temporary, outfile);
  } finally { await rm(temporary, { force: true }); }
}
