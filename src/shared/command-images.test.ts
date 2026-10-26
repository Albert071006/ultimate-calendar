import { describe, expect, it } from 'vitest';
import { CommandRequestSchema, MAX_IMAGE_BYTES } from './contracts';
import { imageDataUrlByteLength, imageDataUrlSignatureValid } from './images';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH0cAAAAASUVORK5CYII=';
const image = { imageDataUrl: png, label: '合成图片.png' };
const request = { operationId: 'image-boundary', text: '查看这张图片', image };

describe('assistant image boundary', () => {
  it('accepts a current image without text but not an empty message or only an old image', () => {
    expect(CommandRequestSchema.parse({ ...request, text: '  ' }).text).toBe('');
    expect(CommandRequestSchema.safeParse({ operationId: 'blank', text: '' }).success).toBe(false);
    expect(CommandRequestSchema.safeParse({ operationId: 'blank', text: '', history: [{ role: 'user', text: '', image }] }).success).toBe(false);
  });

  it('checks actual PNG/JPEG magic, declared type and exact image fields at the shared boundary', () => {
    expect(imageDataUrlSignatureValid(png)).toBe(true);
    expect(imageDataUrlByteLength(png)).toBe(Buffer.from(png.split(',')[1]!, 'base64').length);
    for (const imageDataUrl of ['data:image/png;base64,aGVsbG8=', png.replace('image/png', 'image/jpeg'), 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,!!!!']) {
      expect(CommandRequestSchema.safeParse({ ...request, image: { ...image, imageDataUrl } }).success).toBe(false);
      expect(CommandRequestSchema.safeParse({ ...request, history: [{ role: 'user', text: '', image: { ...image, imageDataUrl } }] }).success).toBe(false);
    }
    expect(CommandRequestSchema.parse({ ...request, image: { label: 'synthetic.jpg', imageDataUrl: 'data:image/jpeg;base64,/9j/' } }).image).toBeDefined();
    expect(CommandRequestSchema.safeParse({ ...request, image: { ...image, path: 'C:/untrusted' } }).success).toBe(false);
    expect(CommandRequestSchema.safeParse({ ...request, history: [{ role: 'assistant', text: '', image }] }).success).toBe(false);
  });

  it('bounds image count and total decoded bytes including history before model or transport use', () => {
    const history = Array.from({ length: 3 }, () => ({ role: 'user' as const, text: '', image }));
    expect(CommandRequestSchema.safeParse({ ...request, history }).success).toBe(true);
    expect(CommandRequestSchema.safeParse({ ...request, history: [...history, history[0]] }).success).toBe(false);
    const largeImage = (size: number) => {
      const bytes = Buffer.alloc(size); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
      return { label: 'synthetic.png', imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    };
    const half = largeImage(MAX_IMAGE_BYTES / 2);
    expect(CommandRequestSchema.safeParse({ ...request, image: half, history: [{ role: 'user', text: '', image: half }] }).success).toBe(true);
    expect(CommandRequestSchema.safeParse({ ...request, image: half, history: [{ role: 'user', text: '', image: largeImage(MAX_IMAGE_BYTES / 2 + 1) }] }).success).toBe(false);
  });

  it('does not insert image defaults into legacy text requests or their history', () => {
    const legacy = { operationId: 'legacy', text: '明天有什么课', selected: [], history: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好' }] };
    expect(CommandRequestSchema.parse(legacy)).toEqual(legacy);
    expect(JSON.stringify(CommandRequestSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  });
});
