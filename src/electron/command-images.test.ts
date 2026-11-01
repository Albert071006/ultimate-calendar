import { describe, expect, it, vi } from 'vitest';
import { dispatchRequest } from './ipc';
import { CommandRequestSchema } from '../shared/contracts';

const caller = { senderId: 7, frameId: 4, url: 'file:///synthetic/dist/index.html' };
const image = { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', label: '合成截图.png' };

describe('assistant image IPC boundary', () => {
  it('keeps document selection native-only and validates returned names before exposing text to the UI', async () => {
    const selectCommandDocuments = vi.fn(async () => ({ ok: true, data: [{ label: '合成名单.csv', text: 'S123,合成姓名' }] }));
    expect(await dispatchRequest('selectCommandDocuments', { path: 'C:/private.csv' }, caller, caller, { selectCommandDocuments })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(selectCommandDocuments).not.toHaveBeenCalled();
    expect(await dispatchRequest('selectCommandDocuments', undefined, caller, caller, { selectCommandDocuments })).toMatchObject({ ok: true, data: [{ label: '合成名单.csv' }] });
    expect(await dispatchRequest('selectCommandDocuments', undefined, caller, caller, { selectCommandDocuments: async () => ({ ok: true, data: [{ label: 'C:/private.csv', text: 'private' }] }) })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });
  it('preserves current and historical images exactly and rejects invalid image content before dispatch', async () => {
    const command = vi.fn(async () => ({ ok: true, data: { reply: '合成说明', mutationResult: null, items: [] } }));
    const request = { operationId: 'image', text: '比较图片', image, history: [{ role: 'user' as const, text: '', image }] };
    expect((await dispatchRequest('command', request, caller, caller, { command })).ok).toBe(true);
    expect(command).toHaveBeenCalledWith(CommandRequestSchema.parse(request));
    command.mockClear();
    const badImage = { ...image, imageDataUrl: 'data:image/png;base64,aGVsbG8=' };
    for (const input of [{ ...request, image: badImage }, { ...request, history: [{ role: 'user', text: '', image: badImage }] }, { ...request, history: [{ role: 'assistant', text: '', image }] }]) {
      expect(await dispatchRequest('command', input, caller, caller, { command })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect((await dispatchRequest('command', request, { ...caller, frameId: 8 }, caller, { command })).ok).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });
});
