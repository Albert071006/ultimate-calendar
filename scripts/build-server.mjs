import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBackupWorker } from './build-backup-worker.mjs';

export async function buildServer(outputDirectory) {
  await buildBackupWorker(join(outputDirectory, 'backup-worker.cjs'));
  await build({
    entryPoints: ['src/server/cli.ts'], outfile: join(outputDirectory, 'cli.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: false,
    banner: { js: "import { createRequire as __ucCreateRequire } from 'node:module'; const require = __ucCreateRequire(import.meta.url);" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildServer('dist-server');
  process.stdout.write('资料服务已构建至 dist-server/cli.mjs（未启动、未部署）\n');
}
