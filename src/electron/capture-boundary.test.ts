import { describe, expect, it } from 'vitest';
import { dispatchRequest } from './ipc';
import { CaptureConfigSchema, CaptureSnapshotSchema } from '../shared/capture';

const caller = { senderId: 7, frameId: 4, url: 'file:///C:/app/dist/index.html' };
function snapshot() {
  return CaptureSnapshotSchema.parse({ config: {}, connection: 'disconnected', accountLabel: null, error: null, lastReceivedAt: null, credentialConfigured: false,
    stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [] });
}
describe('QQ desktop boundary', () => {
  it('rejects arbitrary actions, remote URLs and credentials on configuration DTOs before invoking main handlers', async () => {
    let calls = 0;
    const handlers = { captureConfigure: async () => { calls++; return { ok: true, data: snapshot() }; }, captureAction: async () => { calls++; return { ok: true, data: snapshot() }; } };
    for (const input of [{ ...CaptureConfigSchema.parse({}), endpoint: 'ws://external.invalid:3001' }, { ...CaptureConfigSchema.parse({}), token: 'synthetic-private' }]) {
      expect((await dispatchRequest('captureConfigure', input, caller, caller, handlers)).ok).toBe(false);
    }
    expect((await dispatchRequest('captureAction', { action: 'send_group_msg', groupId: 'g1', message: 'forbidden' }, caller, caller, handlers)).ok).toBe(false);
    expect((await dispatchRequest('captureAction', { action: 'reanalyze' }, caller, caller, handlers)).ok).toBe(false);
    expect((await dispatchRequest('captureAction', { action: 'analyze' }, { ...caller, frameId: 99 }, caller, handlers)).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it('rejects credential, raw locator and filesystem fields in returned capture DTOs', async () => {
    const secret = 'synthetic-private';
    const connected = await dispatchRequest('captureConnect', { token: secret }, caller, caller, { captureConnect: async () => ({ ok: true, data: { ...snapshot(), token: secret } }) });
    expect(connected.ok).toBe(false); expect(JSON.stringify(connected)).not.toContain(secret);
    const chunks = await dispatchRequest('captureChunks', { attachmentId: 'a1' }, caller, caller, { captureChunks: async () => ({ ok: true, data: { items: [{ id: 'c1', locator: '第 1 页', text: '', imageDataUrl: null, status: 'ready', error: null, path: 'C:/private', url: 'https://private.invalid' }], total: 1, offset: 0, limit: 5 } }) });
    expect(chunks.ok).toBe(false); expect(JSON.stringify(chunks)).not.toContain('private');
  });
});
