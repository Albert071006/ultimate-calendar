import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { load, JSON_SCHEMA } from 'js-yaml';

export function releaseArtifactNames(version, edition = 'standard') {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('A stable x.y.z version is required');
  if (!['standard', 'local'].includes(edition)) throw Error('Unknown desktop edition');
  const installer = `UltimateCalendar-${edition === 'local' ? 'Local-' : ''}Setup-${version}.exe`;
  return [installer, `${installer}.blockmap`, edition === 'local' ? 'local.yml' : 'latest.yml', edition === 'local' ? 'SHA256SUMS-local.txt' : 'SHA256SUMS.txt'];
}

export const allReleaseArtifactNames = version => ['standard', 'local'].flatMap(edition => releaseArtifactNames(version, edition));

export async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function writeChecksums(directory, version, edition = 'standard') {
  const files = releaseArtifactNames(version, edition), names = files.slice(0, -1);
  const lines = await Promise.all(names.map(async name => `${await hashFile(join(directory, name))}  ${name}`));
  await writeFile(join(directory, files[3]), `${lines.join('\n')}\n`);
}

export async function verifyReleaseArtifacts(directory, version, edition = 'standard') {
  const names = releaseArtifactNames(version, edition);
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
  const metadataName = names[2], checksumsName = names[3];
  const info = load(await readFile(join(directory, metadataName), 'utf8'), { schema: JSON_SCHEMA });
  const sha512 = await hashFile(installer.path, 'sha512', 'base64');
  if (!info || info.version !== version) throw Error(`${metadataName} version does not match package.json`);
  if (!Array.isArray(info.files) || info.files.length !== 1 || info.files[0].url !== installer.name || info.path !== installer.name)
    throw Error(`${metadataName} must reference exactly the versioned ${edition} installer`);
  if (info.files[0].sha512 !== sha512 || info.sha512 !== sha512) throw Error(`${metadataName} SHA-512 does not match installer bytes`);
  if (info.files[0].size !== installer.size) throw Error(`${metadataName} size does not match installer`);
  if (typeof info.releaseDate !== 'string' || !Number.isFinite(Date.parse(info.releaseDate))) throw Error(`${metadataName} has no valid release date`);
  const map = JSON.parse(gunzipSync(await readFile(blockmap.path), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'));
  if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1) throw Error('Unsupported or invalid installer blockmap');
  const part = map.files[0];
  if (part.offset !== 0 || !Array.isArray(part.sizes) || !part.sizes.length || !Array.isArray(part.checksums)
    || part.sizes.length !== part.checksums.length || part.sizes.some(size => !Number.isSafeInteger(size) || size <= 0)
    || part.checksums.some(value => typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    || part.sizes.reduce((sum, size) => sum + size, 0) !== installer.size) throw Error('Installer blockmap is incomplete or has the wrong file size');
  const sums = (await readFile(join(directory, checksumsName), 'utf8')).trim().split(/\r?\n/);
  const expected = artifacts.slice(0, -1).map(file => `${file.sha256}  ${file.name}`);
  if (sums.length !== expected.length || expected.some(line => !sums.includes(line))) throw Error(`${checksumsName} does not match release artifacts`);
  return artifacts;
}

export async function verifyAllReleaseArtifacts(version, standardDirectory = 'release', localDirectory = 'release-local') {
  return (await Promise.all([
    verifyReleaseArtifacts(standardDirectory, version, 'standard'),
    verifyReleaseArtifacts(localDirectory, version, 'local'),
  ])).flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const all = process.argv.includes('--all');
  if (all) await verifyAllReleaseArtifacts(version);
  else {
    const { desktopEdition } = await import('./desktop-edition.mjs');
    const edition = desktopEdition();
    const directory = process.argv.slice(2).find(arg => !arg.startsWith('--')) || (edition === 'local' ? 'release-local' : 'release');
    await verifyReleaseArtifacts(directory, version, edition);
  }
  console.log(`Release ${version}: ${all ? 'all eight' : 'all four'} artifacts verified`);
}
