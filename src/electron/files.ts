import { open } from 'node:fs/promises';
import { basename, extname, win32 } from 'node:path';
import { ImageDataUrlSchema, MAX_IMAGE_BYTES, SelectedImageSchema, type SelectedImage } from '../shared/contracts';
import { WorkflowError } from '../ai/deepseek';
export async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.size === 0) throw new WorkflowError('VALIDATION', '所选文件为空、不是普通文件或超过大小限制');
    const buffer = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new WorkflowError('VALIDATION', '读取期间文件已改变，请重新选择');
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function imageType(bytes: Uint8Array): 'png' | 'jpeg' | null {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  return null;
}
export function imageFromBytes(name: string, bytes: Uint8Array): SelectedImage {
  const kind = imageType(bytes); const extension = extname(name).toLowerCase();
  if (!kind || bytes.length > MAX_IMAGE_BYTES || (kind === 'png' ? extension !== '.png' : !['.jpg', '.jpeg'].includes(extension))) throw new WorkflowError('VALIDATION', '请选择不超过 10 MB 且内容有效的 PNG/JPEG 图片');
  return SelectedImageSchema.parse({ label: basename(name), imageDataUrl: `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}` });
}
export function imageDataUrlValid(value: string): boolean {
  if (!ImageDataUrlSchema.safeParse(value).success) return false;
  const kind = imageType(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64'));
  return !!kind && value.startsWith(`data:image/${kind};base64,`);
}
export function profileFromArgs(args: string[]): string | null {
  const flags = args.filter(arg => arg.startsWith('--planner-profile'));
  if (!flags.length) return null;
  if (flags.length !== 1 || !flags[0]!.startsWith('--planner-profile=')) throw new Error('请仅提供一次 --planner-profile=绝对本地目录');
  const path = flags[0]!.slice('--planner-profile='.length);
  if (!/^[A-Za-z]:[\\/]/.test(path) || /[<>"|?*\x00-\x1f]/.test(path) || path.slice(2).includes(':')) throw new Error('数据目录必须是本地磁盘的绝对目录');
  const normalized = win32.resolve(path);
  if (normalized === win32.parse(normalized).root) throw new Error('数据目录不能是磁盘根目录');
  return normalized;
}
