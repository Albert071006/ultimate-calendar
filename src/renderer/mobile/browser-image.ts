import type { SelectedImage } from '../../shared/contracts';

export async function readBrowserImage(file: File): Promise<SelectedImage> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('请选择 PNG 或 JPEG 图片。');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('截图大小须大于 0 且不超过 10 MB。');
  const imageDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取截图。'));
    reader.onerror = () => reject(new Error('截图读取失败，请重新选择。'));
    reader.onabort = () => reject(new Error('已取消读取截图。'));
    reader.readAsDataURL(file);
  });
  const bytes = atob(imageDataUrl.split(',')[1]!.slice(0, 32));
  const png = bytes.startsWith('\x89PNG\r\n\x1a\n');
  const jpeg = bytes.startsWith('\xff\xd8\xff');
  if (!(file.type === 'image/png' ? png : jpeg)) throw new Error('图片内容与文件格式不符，请重新选择 PNG 或 JPEG。');
  return { imageDataUrl, label: file.name.slice(0, 2000) };
}
