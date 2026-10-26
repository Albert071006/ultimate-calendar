import { readFileSync, writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'release', 'backend');
const sha = value => createHash('sha256').update(value).digest('hex');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw Error('Invalid package version');
// Exact allowlist: never walk the workspace, release directory, frontend or personal data.
const names = ['LICENSE', 'dist-server/cli.mjs', 'deploy/ultimate-calendar.service', 'deploy/server.env.example', 'deploy/check-health.mjs', 'deploy/verify-release.mjs', 'deploy/install-backend.sh', 'deploy/rollback-backend.sh', 'deploy/DEPLOYMENT.md'];
const files = names.map(path => {
  const absolute = join(root, path), info = lstatSync(absolute); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error(`Not a regular release input: ${path}`);
  const raw = readFileSync(absolute), content = path.startsWith('deploy/') ? Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n')) : raw;
  return { path, content, mode: path.endsWith('.sh') ? 0o755 : 0o644, sha256: sha(content), size: content.length };
}).sort((a, b) => a.path.localeCompare(b.path, 'en'));
const entries = files.map(({ path, mode, sha256, size }) => ({ path, mode, sha256, size }));
const releaseId = `backend-${version}-${sha(JSON.stringify(entries)).slice(0, 12)}`;
const manifest = Buffer.from(`${JSON.stringify({ format: 'ultimate-calendar-backend-release', formatVersion: 1, releaseId, packageVersion: version, nodeMajor: 24, storageSchema: 1, backendOnly: true, entrypoint: 'dist-server/cli.mjs', files: entries }, null, 2)}\n`);
const sums = Buffer.from([...files.map(file => `${file.sha256}  ${file.path}`), `${sha(manifest)}  release-manifest.json`].join('\n') + '\n');
const payload = [...files, { path: 'release-manifest.json', content: manifest, mode: 0o644 }, { path: 'SHA256SUMS', content: sums, mode: 0o644 }];
if (payload.reduce((sum, file) => sum + file.content.length, 0) > 64 * 1024 * 1024) throw Error('Backend artifact exceeds its reviewed 64 MiB packaging budget');
// Small deterministic USTAR archive, regular files/directories only. No external tar tool.
function header(path, size, mode, kind = '0') {
  if (Buffer.byteLength(path) > 100) throw Error('Archive path too long');
  const buffer = Buffer.alloc(512); buffer.write(path); const octal = (offset, width, value) => buffer.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0); buffer.fill(32, 148, 156); buffer.write(kind, 156); buffer.write('ustar\0', 257); buffer.write('00', 263);
  const checksum = buffer.reduce((sum, value) => sum + value, 0); buffer.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8); return buffer;
}
const chunks = [], directories = new Set();
for (const file of payload) {
  const path = `${releaseId}/${file.path}`, parts = path.split('/');
  for (let i = 1; i < parts.length; i++) { const directory = parts.slice(0, i).join('/') + '/'; if (!directories.has(directory)) { directories.add(directory); chunks.push(header(directory, 0, 0o755, '5')); } }
  chunks.push(header(path, file.content.length, file.mode), file.content, Buffer.alloc((512 - file.content.length % 512) % 512));
}
chunks.push(Buffer.alloc(1024)); const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
mkdirSync(output, { recursive: true }); const filename = `ultimate-calendar-${releaseId}.tar.gz`, path = join(output, filename);
writeFileSync(path, archive); writeFileSync(`${path}.sha256`, `${sha(archive)}  ${filename}\n`); writeFileSync(join(output, `${releaseId}.manifest.json`), manifest);
process.stdout.write(`${JSON.stringify({ releaseId, archive: path, sha256: sha(archive), bytes: archive.length, payloadFiles: payload.map(file => file.path) }, null, 2)}\n`);
