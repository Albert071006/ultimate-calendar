import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPackageFiles, backendRuntimeFiles } from '../deploy/backend-files.mjs';
import { createRepository, newEntity } from '../src/storage/repository';
import { buildServer } from './build-server.mjs';

it('backs up a synthetic task with the worker from an unpacked backend-only release', async () => {
  const workspace = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const temp = mkdtempSync(join(workspace, '.backend-package-test-'));
  const project = join(temp, 'package-input'), extracted = join(temp, 'extracted');
  const run = (command, args, cwd) => execFileSync(command, args, {
    cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DEEPSEEK_API_KEY: '', VAPID_SUBJECT: '' },
  });
  try {
    // Stage the real packager in an isolated project so it only writes a disposable archive.
    for (const name of ['scripts/package-backend.mjs', ...backendPackageFiles.filter(name => !backendRuntimeFiles.includes(name))]) {
      const path = join(project, name);
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(workspace, name), path);
    }
    writeFileSync(join(project, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    await buildServer(join(project, 'dist-server'));
    const pack = JSON.parse(run(process.execPath, ['scripts/package-backend.mjs'], project));
    mkdirSync(extracted);
    run('tar', ['-xzf', pack.archive, '-C', extracted], temp);

    const payload = join(extracted, pack.releaseId);
    const verify = () => run(process.execPath, ['deploy/verify-release.mjs', payload], payload);
    expect(verify()).toContain(`VERIFIED ${pack.releaseId}`);
    const manifestPath = join(payload, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files.map(file => file.path)).toContain('dist-server/backup-worker.cjs');

    const data = join(temp, 'synthetic-data'), backups = join(temp, 'synthetic-backups');
    const repository = createRepository(join(data, 'planner.sqlite'), { automaticBackup() {} });
    const title = 'Synthetic backend package task';
    try { repository.transact(state => newEntity(state, 'task', { title })); }
    finally { repository.close(); }
    run(process.execPath, [manifest.entrypoint, 'backup', '--data-dir', data, '--backup-dir', backups], payload);
    const backupFiles = readdirSync(backups);
    expect(backupFiles).toHaveLength(1);
    const backupFile = join(backups, backupFiles[0]);
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    expect(backup.format).toBe('ultimate-calendar-safe-backup');
    expect(backup.planner.entities.task).toMatchObject([{ title }]);
    run(process.execPath, [manifest.entrypoint, 'restore', '--data-dir', join(temp, 'restored'), '--backup-file', backupFile], payload);

    // Even a manifest that omits the missing worker must fail verification.
    rmSync(join(payload, 'dist-server/backup-worker.cjs'));
    manifest.files = manifest.files.filter(file => file.path !== 'dist-server/backup-worker.cjs');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(verify).toThrow(/Invalid backend release manifest/);
  } finally {
    const path = realpathSync(temp);
    if (dirname(path) !== workspace || !basename(path).startsWith('.backend-package-test-')) throw Error('Invalid test directory');
    rmSync(path, { recursive: true, force: true });
  }
}, 60_000);
