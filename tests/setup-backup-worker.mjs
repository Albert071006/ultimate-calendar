import { buildBackupWorker } from '../scripts/build-backup-worker.mjs';
export default async function setup() { await buildBackupWorker('dist-server/backup-worker.cjs'); }
