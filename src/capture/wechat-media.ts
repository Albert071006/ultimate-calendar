import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const mediaBytes = new WeakMap<object, Buffer>();
export type WechatAttachmentLocation = Readonly<{ type: 'wechat-local-media'; fileName: string }>;
const MAX_BYTES = 25 * 1024 * 1024;
const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Returned bytes are authenticated by a live selected-message RPC, never by a renderer path. */
export async function readWechatMediaLocation(workdir: string, result: { path: string; name?: string; size: number; sha256: string }): Promise<WechatAttachmentLocation> {
  if (!isAbsolute(workdir) || !isAbsolute(result.path) || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(result.sha256)) throw Error('微信附件结果无效');
  const root = resolve(workdir), target = resolve(result.path), inside = relative(root, target);
  const fileName = result.name ?? basename(target);
  if (!fileName || fileName.length > 512 || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(fileName) || !/\.[A-Za-z0-9]{1,16}$/.test(fileName)) throw Error('微信附件文件名无效');
  const parts = inside.split(sep);
  if (isAbsolute(inside) || parts.length !== 3 || !/^reader-[A-Za-z0-9_-]+$/.test(parts[0]!) || parts[1] !== 'media' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,16}$/.test(parts[2]!)) throw Error('微信附件不在受限缓存目录中');
  // Resolve and inspect each ancestor, including the configured root. Windows junctions
  // are symlinks to lstat; realpath equivalence rejects redirected/reparse paths as well.
  let current = target;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || normalized(await realpath(current)) !== normalized(current)) throw Error('微信附件缓存含链接或重定向');
    if (current === target ? !info.isFile() : !info.isDirectory()) throw Error('微信附件缓存类型无效');
    const parent = resolve(current, '..'); if (parent === current) break; current = parent;
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== result.size || before.size > MAX_BYTES) throw Error('微信附件大小或链接状态已改变');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw Error('微信附件读取不完整'); offset += read.bytesRead; }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || normalized(await realpath(target)) !== normalized(target) || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw Error('微信附件内容已变化');
    const location = Object.freeze({ type: 'wechat-local-media' as const, fileName }); mediaBytes.set(location, bytes); return location;
  } finally { await file.close(); }
}

export function hasWechatMediaLocation(value: unknown): value is WechatAttachmentLocation { return !!value && typeof value === 'object' && mediaBytes.has(value); }
export function consumeWechatMediaLocation(value: WechatAttachmentLocation): Buffer {
  const bytes = mediaBytes.get(value); if (!bytes) throw Error('微信附件读取凭据已失效');
  mediaBytes.delete(value); return bytes;
}
