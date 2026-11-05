import { parentPort } from 'node:worker_threads';
import { dirname } from 'node:path';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { createSafeBackupFromDatabase } from '../server/backup';
import { createBackupFromDatabase, inspectBackupFile } from './backups';
import { pruneManagedBackups } from './backup-retention';
import type { BackupJob } from './backup-worker-client';

if (!parentPort) throw Error('备份组件仅能在后台 worker 中运行');
parentPort.on('message', (job: BackupJob) => {
  try {
    if (job.kind === 'safe') parentPort!.postMessage({ path: createSafeBackupFromDatabase(job) });
    else if (job.kind === 'desktop') {
      const temporary = `${job.target}.tmp`;
      try {
        if (existsSync(job.target)) throw Error('备份目标已存在');
        createBackupFromDatabase(job.databasePath, temporary);
        inspectBackupFile(temporary);
        renameSync(temporary, job.target);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      pruneManagedBackups(dirname(job.databasePath));
      parentPort!.postMessage({ path: job.target });
    } else throw Error('未知备份任务');
  } catch { parentPort!.postMessage({ error: 'BACKUP_FAILED' }); }
});
