/** Call after data URL syntax validation; works in both browser and Node without Buffer. */
export function imageDataUrlByteLength(value: string): number {
  const payload = value.slice(value.indexOf(',') + 1);
  return payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}

/** Check file magic as well as the declared MIME type, without decoding the whole image. */
export function imageDataUrlSignatureValid(value: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,/.exec(value);
  if (!match) return false;
  try {
    const bytes = atob(value.slice(match[0].length, match[0].length + 12));
    const signature = match[1] === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
    return signature.every((byte, index) => bytes.charCodeAt(index) === byte);
  } catch { return false; }
}
