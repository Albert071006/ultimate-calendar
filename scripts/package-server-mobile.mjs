import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const limit = 128 * 1024 * 1024;
const fixed = ['LICENSE', 'dist-server/cli.mjs', 'deploy/server-mobile/ultimate-calendar.service', 'deploy/nginx.conf.example', 'deploy/check-health.mjs', 'docs/server-mobile-deployment.md', 'docs/windows-cloud-mode.md'];
const allowed = name => fixed.includes(name) || name === 'README.md'
  || /^web\/(?:index\.html|sw\.js|manifest\.webmanifest|assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|woff2?|ttf|svg|png|jpe?g|webp)|icons\/[A-Za-z0-9_-]+\.(?:png|svg)|third-party\/[A-Za-z0-9_-]+\.txt)$/.test(name);
export function serverMobileNames(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Stable version required');
  return [`UltimateCalendar-Server-Mobile-${version}.tar.gz`, 'SHA256SUMS-server.txt'];
}
function header(name, size) {
  if (Buffer.byteLength(name) > 100) throw Error('Archive path exceeds USTAR name limit');
  const block = Buffer.alloc(512); block.write(name);
  const oct = (offset, width, value) => block.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  oct(100, 8, 0o644); oct(108, 8, 0); oct(116, 8, 0); oct(124, 12, size); oct(136, 12, 0);
  block.fill(32, 148, 156); block.write('0', 156); block.write('ustar\0', 257); block.write('00', 263);
  block.write(block.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}
export function createServerMobileArchive(version, inputs) {
  serverMobileNames(version);
  const files = [...inputs].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (new Set(files.map(f => f.name)).size !== files.length || files.some(f => !allowed(f.name))) throw Error('Unapproved or duplicate package input');
  const required = [...fixed, 'README.md', 'web/index.html', 'web/sw.js', 'web/manifest.webmanifest'];
  if (required.some(name => !files.some(f => f.name === name))) throw Error('Server or mobile package input missing');
  const manifest = { format: 'ultimate-calendar-server-mobile', formatVersion: 1, version, nodeMajor: 24, entrypoint: 'dist-server/cli.mjs', staticDirectory: 'web',
    files: files.map(f => ({ path: f.name, size: f.bytes.length, sha256: digest(f.bytes) })) };
  const entries = [...files, { name: 'release-manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }];
  if (entries.reduce((sum, f) => sum + f.bytes.length, 0) > limit) throw Error('Server/mobile package is too large');
  const chunks = [];
  for (const f of entries) chunks.push(header(`UltimateCalendar-Server-Mobile-${version}/${f.name}`, f.bytes.length), f.bytes, Buffer.alloc((512 - f.bytes.length % 512) % 512));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Validate every archive entry before callers extract anything. No links, devices or private files. */
export function readServerMobileArchive(archive, version) {
  serverMobileNames(version);
  const raw = gunzipSync(archive, { maxOutputLength: limit + 2 * 1024 * 1024 }), prefix = `UltimateCalendar-Server-Mobile-${version}/`, entries = new Map();
  let offset = 0;
  while (offset + 512 <= raw.length && raw[offset] !== 0) {
    const block = raw.subarray(offset, offset + 512);
    const field = (start, length) => block.subarray(start, start + length).toString('utf8').split('\0')[0];
    const name = field(0, 100), storedSum = parseInt(field(148, 8).trim(), 8);
    const check = Buffer.from(block); check.fill(32, 148, 156);
    const size = parseInt(field(124, 12), 8);
    if (storedSum !== check.reduce((a, b) => a + b, 0) || field(257, 6) !== 'ustar' || field(156, 1) !== '0' || field(345, 155) || !Number.isSafeInteger(size) || size < 1 || offset + 512 + size > raw.length) throw Error('Invalid archive header');
    if (!name.startsWith(prefix)) throw Error('Archive belongs to another release');
    const relative = name.slice(prefix.length);
    if (!(relative === 'release-manifest.json' || allowed(relative)) || entries.has(relative)) throw Error('Unexpected archive entry');
    entries.set(relative, Buffer.from(raw.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (raw.length - offset < 1024 || raw.subarray(offset).some(byte => byte !== 0)) throw Error('Invalid archive trailer');
  const manifest = JSON.parse(entries.get('release-manifest.json')?.toString() ?? '{}');
  if (manifest.format !== 'ultimate-calendar-server-mobile' || manifest.formatVersion !== 1 || manifest.version !== version || manifest.nodeMajor !== 24 || manifest.entrypoint !== 'dist-server/cli.mjs' || manifest.staticDirectory !== 'web' || !Array.isArray(manifest.files) || manifest.files.length !== entries.size - 1) throw Error('Invalid server/mobile manifest');
  const seen = new Set();
  for (const f of manifest.files) {
    const bytes = entries.get(f.path);
    if (!allowed(f.path) || seen.has(f.path) || !bytes || bytes.length !== f.size || digest(bytes) !== f.sha256) throw Error('Server/mobile content does not match manifest');
    seen.add(f.path);
  }
  for (const name of [...fixed, 'README.md', 'web/index.html', 'web/sw.js', 'web/manifest.webmanifest']) if (!seen.has(name)) throw Error('Server/mobile release incomplete');
  return { entries, manifest };
}

export async function verifyServerMobileArtifacts(version, directory = 'release-server') {
  const [archiveName, sumsName] = serverMobileNames(version), archivePath = join(directory, archiveName);
  const archive = await readFile(archivePath); readServerMobileArchive(archive, version);
  const sums = await readFile(join(directory, sumsName));
  if (sums.toString().trim() !== `${digest(archive)}  ${archiveName}`) throw Error('Server/mobile archive checksum mismatch');
  return [{ name: archiveName, path: archivePath, size: archive.length, sha256: digest(archive) }, { name: sumsName, path: join(directory, sumsName), size: sums.length, sha256: digest(sums) }];
}

async function packageServerMobile() {
  for (const script of ['build-server.mjs', 'build-mobile.mjs']) {
    const child = spawn(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (code !== 0) throw Error(`${script} failed`);
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = [];
  async function add(name, path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Package inputs must be ordinary files');
    let bytes = await readFile(path);
    if (/^(deploy|docs)\//.test(name)) bytes = Buffer.from(bytes.toString().replace(/\r\n/g, '\n'));
    files.push({ name, bytes });
  }
  for (const name of fixed) await add(name, join(root, name));
  // Walk only the freshly built public static directory. Never walk source, data or deployment directories.
  async function web(directory, prefix = 'web') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Links are forbidden in static assets');
      const name = `${prefix}/${entry.name}`, path = join(directory, entry.name);
      if (entry.isDirectory()) await web(path, name); else await add(name, path);
    }
  }
  await web(join(root, 'dist'));
  files.push({ name: 'README.md', bytes: Buffer.from('# 终极日历服务器版与手机端\n\n完整部署步骤见 docs/server-mobile-deployment.md。需要自行准备常在线的云服务器、Node.js 24 和 HTTPS 入口。\n\nweb/ 是手机 PWA，dist-server/cli.mjs 是共用资料与 AI 服务；软件包不含用户资料或密钥。\n') });
  const archive = createServerMobileArchive(version, files), [name, sums] = serverMobileNames(version), directory = join(root, 'release-server');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), archive); await writeFile(join(directory, sums), `${digest(archive)}  ${name}\n`);
  await verifyServerMobileArtifacts(version, directory);
  console.log(`Verified server + mobile archive ${name} (${archive.length} bytes, ${files.length} files); not deployed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageServerMobile();
