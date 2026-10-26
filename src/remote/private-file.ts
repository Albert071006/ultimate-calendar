import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function privatePath(file: string): string {
  if (!isAbsolute(file) || resolve(file) === parse(resolve(file)).root) throw Error('必须使用明确的绝对文件路径');
  const result = resolve(file);
  for (let path = result; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('私密文件路径不能经过符号链接');
    if (dirname(path) === path) break;
  }
  return result;
}
export function readPrivate(file: string, maxBytes = 1024 * 1024): Buffer | null {
  file = privatePath(file);
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink!==1 || info.size > maxBytes || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw Error('私密文件大小、链接或访问权限无效（Linux 需要 0600）');
  return readFileSync(file);
}
/** Temp and destination stay on one volume. A failed write never destroys the last durable state. */
export function writePrivate(file: string, value: string | Buffer) {
  file = privatePath(file); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.pending-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    if(process.platform!=='win32'){const directory=openSync(dirname(file),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
