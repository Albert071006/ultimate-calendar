import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readPrivate, privatePath } from '../remote/private-file';

const sessionName = /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const marker = '.owner.json';
type Owner = { format: 'wechat-reader-session-v1'; name: string; directoryId: string; parentPid: number; workerPid: number };

function directoryId(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || relative(path, realpathSync.native(path)) !== '')
    throw Error('微信临时目录归属无法核对');
  return `${stat.dev}:${stat.ino}`;
}
function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}
function exited(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function removeSession(root: string, name: string, closed?: Owner) {
  if (!sessionName.test(name)) return;
  const path = join(root, name), ownerFile = path + marker;
  directoryId(root);
  const bytes = readPrivate(ownerFile, 1024);
  if (!bytes) return;
  const owner: Owner = JSON.parse(bytes.toString('utf8'));
  if (owner?.format !== 'wechat-reader-session-v1' || owner.name !== name || !validPid(owner.parentPid) || !validPid(owner.workerPid) ||
      dirname(path) !== root || directoryId(path) !== owner.directoryId) return;
  if (closed) {
    if (owner.parentPid !== process.pid || owner.workerPid !== closed.workerPid || owner.directoryId !== closed.directoryId) return;
  } else if (!exited(owner.workerPid) || (owner.parentPid !== process.pid && !exited(owner.parentPid))) return;
  // fs.rm unlinks nested symlinks/junctions without traversing their targets.
  // The sidecar outlives a partial removal, so locked files can be retried.
  await rm(path, { recursive: true, maxRetries: 3, retryDelay: 100 });
  unlinkSync(ownerFile);
}

export async function reapWechatSessions(workdir: string) {
  const root = privatePath(workdir);
  directoryId(root);
  for (const name of readdirSync(root)) {
    if (!name.endsWith(marker)) continue;
    try { await removeSession(root, name.slice(0, -marker.length)); }
    catch { /* Unverifiable, busy or already recovered by another parent. */ }
  }
}

export function reserveWechatSession(workdir: string) {
  if (!isAbsolute(workdir)) throw Error('微信临时目录必须使用绝对路径');
  const root = privatePath(resolve(workdir));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  directoryId(root);
  const path = join(root, 'session-' + randomUUID());
  mkdirSync(path, { mode: 0o700 });
  const id = directoryId(path), name = basename(path);
  let owner: Owner | undefined;
  return {
    path,
    recordWorker(pid: number | undefined) {
      if (!validPid(pid)) throw Error('未取得微信读取子进程标识');
      const record: Owner = { format: 'wechat-reader-session-v1', name, directoryId: id, parentPid: process.pid, workerPid: pid };
      writeFileSync(path + marker, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true });
      owner = record;
    },
    async finish() {
      if (owner) await removeSession(root, name, owner);
      // No first RPC was sent and the worker never initialized its cache.
      else if (dirname(path) === root && directoryId(path) === id) rmdirSync(path);
    },
  };
}
