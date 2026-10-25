import { readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

const root = realpathSync(process.argv[2] ?? '.'), sha = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
const keys = ['format', 'formatVersion', 'releaseId', 'packageVersion', 'nodeMajor', 'storageSchema', 'backendOnly', 'entrypoint', 'files'];
if (Object.keys(manifest).some(key => !keys.includes(key)) || manifest.format !== 'ultimate-calendar-backend-release' || manifest.formatVersion !== 1 || manifest.backendOnly !== true || manifest.storageSchema !== 1 || manifest.nodeMajor !== 24 || manifest.entrypoint !== 'dist-server/cli.mjs' || !/^backend-[0-9A-Za-z._-]+$/.test(manifest.releaseId) || !Array.isArray(manifest.files) || manifest.files.length < 5 || manifest.files.length > 64) throw Error('Invalid backend release manifest');
const expected = new Set(['release-manifest.json', 'SHA256SUMS']);
let total = 0;
for (const file of manifest.files) {
  if (Object.keys(file).sort().join(',') !== 'mode,path,sha256,size' || typeof file.path !== 'string' || !/^(?:dist-server\/cli\.mjs|LICENSE|deploy\/[A-Za-z0-9._-]+)$/.test(file.path) || file.path.split('/').includes('..') || expected.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.size) || file.size < 1 || ![0o644, 0o755].includes(file.mode)) throw Error('Invalid release file entry');
  expected.add(file.path); const path = resolve(root, file.path), actual = relative(root, realpathSync(path)), info = lstatSync(path);
  if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.size || sha(readFileSync(path)) !== file.sha256) throw Error(`Release file verification failed: ${file.path}`);
  total += file.size;
}
if (!expected.has(manifest.entrypoint) || total > 64 * 1024 * 1024) throw Error('Invalid backend payload size/entrypoint');
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`, path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Release links are forbidden');
    if (entry.isDirectory()) walk(path, `${name}/`);
    else if (!entry.isFile() || !expected.delete(name)) throw Error('Unexpected release file');
  }
}
walk(root); if (expected.size) throw Error('Incomplete release');
const sums = readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
if (sums.length !== manifest.files.length + 1) throw Error('Invalid checksum list');
for (const row of sums) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(row);
  if (!match || !['release-manifest.json', ...manifest.files.map(file => file.path)].includes(match[2]) || sha(readFileSync(join(root, match[2]))) !== match[1]) throw Error('Checksum list verification failed');
}
process.stdout.write(`VERIFIED ${manifest.releaseId}\n`);
