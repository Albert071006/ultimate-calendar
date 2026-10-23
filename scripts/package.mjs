import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { build } from 'electron-builder';
import { verifyReleaseArtifacts, writeChecksums } from './release-artifacts.mjs';

const result = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const code = await new Promise((resolveCode, reject) => {
  result.once('error', reject);
  result.once('exit', resolveCode);
});
if (code !== 0) process.exit(code ?? 1);

// electron-builder honors ELECTRON_BUILDER_CACHE when set and otherwise uses
// its platform default. Build artifacts stay in the configured release folder.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const releaseNotes = await readFile(`docs/release-notes/${version}.md`, 'utf8');
// A CI tag or GH_TOKEN must never silently turn a local build into a release.
const files = await build({ win: ['nsis'], x64: true, publish: 'never', config: { releaseInfo: { releaseNotes } } });
await writeChecksums('release', version);
await verifyReleaseArtifacts('release', version);
console.log(`Verified release ${version}: installer, blockmap, latest.yml and SHA256SUMS.txt`);
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
