/** Read only container metadata before native decoding, to bound allocation on malformed/oversized images. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, size: number) => String.fromCharCode(...bytes.subarray(start, start + size));
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && ascii(0, 3) === 'GIF') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const type = ascii(12, 4);
    if (type === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let p = 2; p + 4 <= bytes.length;) {
      if (bytes[p] !== 0xff) return null;
      while (p < bytes.length && bytes[p] === 0xff) p++;
      const marker = bytes[p++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || marker !== undefined && marker >= 0xd0 && marker <= 0xd7) continue;
      if (p + 2 > bytes.length) return null;
      const length = view.getUint16(p);
      if (length < 2 || p + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker ?? -1) && length >= 7) return { width: view.getUint16(p + 5), height: view.getUint16(p + 3) };
      p += length;
    }
  }
  return null;
}
