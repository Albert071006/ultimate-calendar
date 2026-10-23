import { spawn } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { build } from 'electron-builder';

const result = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const code = await new Promise((resolveCode, reject) => {
  result.once('error', reject);
  result.once('exit', resolveCode);
});
if (code !== 0) process.exit(code ?? 1);

// electron-builder honors ELECTRON_BUILDER_CACHE when set and otherwise uses
// its platform default. Build artifacts stay in the configured release folder.
const files = await build({ win: ['nsis'], x64: true });
const destination = process.env.PLANNER_INSTALLER_COPY_DIR;
if (destination) {
  await mkdir(destination, { recursive: true });
  for (const path of files) {
    if (!path.endsWith('.exe')) continue;
    const target = join(destination, basename(path));
    if (resolve(path) !== resolve(target)) await copyFile(path, target);
    console.log(`Installer copied: ${target}`);
  }
}
