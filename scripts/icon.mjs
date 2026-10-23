import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const size = 256; const data = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + x * 4 + 1;
  const rounded = (left, top, right, bottom, radius) => x >= left && x < right && y >= top && y < bottom && Math.hypot(Math.max(left + radius - x, 0, x - (right - radius)), Math.max(top + radius - y, 0, y - (bottom - radius))) <= radius;
  let color = rounded(4, 4, 252, 252, 48) ? [65, 86, 217, 255] : [0, 0, 0, 0];
  if (rounded(42, 52, 214, 216, 18)) color = [255, 255, 255, 255];
  if (x >= 42 && x < 214 && y >= 91 && y < 99) color = [65, 86, 217, 255];
  if ((x >= 76 && x < 91 || x >= 165 && x < 180) && y >= 35 && y < 72) color = [211, 223, 255, 255];
  if (y >= 123 && y < 184 && x >= 72 && x < 184) {
    const col = Math.floor((x - 72) / 42); const row = Math.floor((y - 123) / 36);
    if (col < 3 && (x - 72) % 42 < 25 && row < 2 && (y - 123) % 36 < 23) color = col === 1 && row === 1 ? [247, 166, 72, 255] : [125, 141, 229, 255];
  }
  data.set(color, i);
}
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const t = Buffer.from(type); const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); t.copy(out, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([t, bytes])), out.length - 4); return out; }
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await mkdir('assets', { recursive: true }); await writeFile('assets/app-icon.png', png); await writeFile('assets/app-icon.ico', Buffer.concat([ico, png]));
