import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { load, JSON_SCHEMA } from 'js-yaml';

export function releaseArtifactNames(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('A stable x.y.z version is required');
  const installer = `UltimateCalendar-Setup-${version}.exe`;
  return [installer, `${installer}.blockmap`, 'latest.yml', 'SHA256SUMS.txt'];
}

export async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function writeChecksums(directory, version) {
  const names = releaseArtifactNames(version).slice(0, -1);
  const lines = await Promise.all(names.map(async name => `${await hashFile(join(directory, name))}  ${name}`));
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
}

export async function verifyReleaseArtifacts(directory, version) {
  const names = releaseArtifactNames(version);
  const artifacts = await Promise.all(names.map(async name => {
    const path = join(directory, name), details = await stat(path);
    if (!details.isFile() || details.size === 0) throw Error(`Missing or empty release artifact: ${name}`);
    return { name, path, size: details.size, sha256: await hashFile(path) };
  }));
  const [installer, blockmap] = artifacts;
  const handle = await open(installer.path);
  try {
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    if (header.toString() !== 'MZ') throw Error('Installer is not a Windows executable');
  } finally { await handle.close(); }
  const info = load(await readFile(join(directory, 'latest.yml'), 'utf8'), { schema: JSON_SCHEMA });
  const sha512 = await hashFile(installer.path, 'sha512', 'base64');
  if (!info || info.version !== version) throw Error('latest.yml version does not match package.json');
  if (!Array.isArray(info.files) || info.files.length !== 1 || info.files[0].url !== installer.name || info.path !== installer.name)
    throw Error('latest.yml must reference exactly the versioned local installer');
  if (info.files[0].sha512 !== sha512 || info.sha512 !== sha512) throw Error('latest.yml SHA-512 does not match installer bytes');
  if (info.files[0].size !== installer.size) throw Error('latest.yml size does not match installer');
  if (typeof info.releaseDate !== 'string' || !Number.isFinite(Date.parse(info.releaseDate))) throw Error('latest.yml has no valid release date');
  const map = JSON.parse(gunzipSync(await readFile(blockmap.path), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'));
  if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1) throw Error('Unsupported or invalid installer blockmap');
  const part = map.files[0];
  if (part.offset !== 0 || !Array.isArray(part.sizes) || !part.sizes.length || !Array.isArray(part.checksums)
    || part.sizes.length !== part.checksums.length || part.sizes.some(size => !Number.isSafeInteger(size) || size <= 0)
    || part.checksums.some(value => typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    || part.sizes.reduce((sum, size) => sum + size, 0) !== installer.size) throw Error('Installer blockmap is incomplete or has the wrong file size');
  const sums = (await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  const expected = artifacts.slice(0, -1).map(file => `${file.sha256}  ${file.name}`);
  if (sums.length !== expected.length || expected.some(line => !sums.includes(line))) throw Error('SHA256SUMS.txt does not match release artifacts');
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  await verifyReleaseArtifacts(process.argv[2] || 'release', version);
  console.log(`Release ${version}: all four artifacts verified`);
}
