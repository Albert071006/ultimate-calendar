import { inflateRawSync } from 'node:zlib';
import { DOCUMENT_LIMITS, DocumentError } from './types';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of bytes) result = CRC_TABLE[(result ^ byte) & 0xff]! ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}
type Entry = { name: string; method: number; compressed: number; expanded: number; offset: number; crc: number; flags: number };

/** In-memory ZIP reader. Central-directory promises are checked again against actual inflated bytes. */
export function readOfficeZip(bytes: Buffer): Map<string, Buffer> {
  const fail = (message = 'Office 文件的 ZIP 结构损坏'): never => { throw new DocumentError(message); };
  if (bytes.length < 22) fail();
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0) fail();
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 0xffff || directoryOffset === 0xffffffff) fail('不支持分卷或 ZIP64 Office 文件');
  if (count > DOCUMENT_LIMITS.zipEntries) fail('文档内部条目过多，需手动查看');
  if (directoryOffset + directorySize !== end) fail();
  const entries: Entry[] = [], names = new Set<string>(); let p = directoryOffset, claimedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || bytes.readUInt32LE(p) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(p + 8), method = bytes.readUInt16LE(p + 10), compressed = bytes.readUInt32LE(p + 20), expanded = bytes.readUInt32LE(p + 24);
    const nameSize = bytes.readUInt16LE(p + 28), extraSize = bytes.readUInt16LE(p + 30), commentSize = bytes.readUInt16LE(p + 32), offset = bytes.readUInt32LE(p + 42);
    if (flags & 1) throw new DocumentError('文件已加密，需先手动解密', 'encrypted');
    if (p + 46 + nameSize + extraSize + commentSize > end || bytes.readUInt16LE(p + 34)) fail();
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameSize);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { return fail('文档内部文件名编码无法识别'); }
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /(^|\/)\.\.?($|\/)/.test(name) || name.includes(':') || names.has(name.toLowerCase())) fail('文档包含重复或越界的内部路径');
    names.add(name.toLowerCase());
    if (![0, 8].includes(method) || [compressed, expanded, offset].includes(0xffffffff)) fail('文档使用不支持的 ZIP 压缩格式');
    claimedTotal += expanded;
    if (claimedTotal > DOCUMENT_LIMITS.expandedBytes) fail('文档解压内容超过 200 MB，需手动查看');
    const unixMode = bytes.readUInt32LE(p + 38) >>> 16;
    if ((unixMode & 0xf000) === 0xa000) fail('文档内部不允许符号链接');
    entries.push({ name, method, compressed, expanded, offset, crc: bytes.readUInt32LE(p + 16), flags });
    p += 46 + nameSize + extraSize + commentSize;
  }
  if (p !== end) fail();
  const output = new Map<string, Buffer>(); let actualTotal = 0; const ranges: [number, number][] = [];
  for (const entry of entries) {
    const o = entry.offset;
    if (o + 30 > directoryOffset || bytes.readUInt32LE(o) !== 0x04034b50 || bytes.readUInt16LE(o + 6) !== entry.flags || bytes.readUInt16LE(o + 8) !== entry.method) fail();
    const nameLength = bytes.readUInt16LE(o + 26), start = o + 30 + nameLength + bytes.readUInt16LE(o + 28), finish = start + entry.compressed;
    if (finish > directoryOffset || start > directoryOffset || bytes.subarray(o + 30, o + 30 + nameLength).toString('utf8') !== entry.name) fail();
    ranges.push([o, finish]);
    let inflated: Buffer;
    try { inflated = entry.method === 0 ? Buffer.from(bytes.subarray(start, finish)) : inflateRawSync(bytes.subarray(start, finish), { maxOutputLength: Math.min(DOCUMENT_LIMITS.expandedBytes - actualTotal, entry.expanded + 1) }); }
    catch { return fail('文档解压失败或实际解压内容超过限额'); }
    actualTotal += inflated.length;
    if (inflated.length !== entry.expanded || actualTotal > DOCUMENT_LIMITS.expandedBytes || crc32(inflated) !== entry.crc) fail('文档内容校验失败或解压内容超过限额');
    if (!entry.name.endsWith('/')) output.set(entry.name, inflated);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1]![1])) fail('文档内部条目相互重叠');
  return output;
}
