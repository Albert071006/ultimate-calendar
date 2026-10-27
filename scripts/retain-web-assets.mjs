import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Run after building the new PWA manifest: old fingerprinted assets remain network fallbacks,
 * not part of the new offline shell. Nothing in an old release is removed or overwritten. */
export async function retainWebAssets(destination, previousDirectories) {
  const target = join(resolve(destination), 'assets');
  await mkdir(target, { recursive: true });
  const retained = [];
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  for (const directory of previousDirectories) {
    const source = join(resolve(directory), 'assets');
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|woff2)$/.test(entry.name)) continue;
      const from = join(source, entry.name), to = join(target, entry.name);
      let existing;
      try { existing = await lstat(to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (!existing.isFile() || await digest(from) !== await digest(to)) throw Error('Fingerprint collision: ' + entry.name);
      } else {
        await copyFile(from, to); retained.push(entry.name);
      }
    }
  }
  return retained;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destination, ...previous] = process.argv.slice(2);
  if (!destination || !previous.length) throw Error('Usage: node scripts/retain-web-assets.mjs <new-dist> <previous-dist> [...]');
  console.log(JSON.stringify({ retained: await retainWebAssets(destination, previous) }));
}
