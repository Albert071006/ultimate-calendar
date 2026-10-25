import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { PLAN_FILE_EXAMPLE, MAX_PLAN_FILE_BYTES } from '../shared/plan-import';
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), file: vi.fn(), write: vi.fn(), preview: vi.fn(), confirm: vi.fn(), registry: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/synthetic-documents' }, dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save } }));
vi.mock('./files', () => ({ boundedFile: mocks.file }));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }));
vi.mock('../plan-import/service', () => ({ createPlanImportService: () => ({ preview: mocks.preview, confirm: mocks.confirm }) }));
vi.mock('../storage/local-resources', () => ({ readLocalResources: mocks.registry }));
import { createNativePlanImport } from './plan-import';
import { dispatchRequest } from './ipc';
const host = () => createNativePlanImport({ directory: 'C:/synthetic-import', resourceDirectory: 'C:/synthetic-resources', window: () => ({} as BrowserWindow), changed: vi.fn(), scope: async () => 'synthetic', snapshot: vi.fn(), mutate: vi.fn() });
beforeEach(() => { vi.resetAllMocks(); mocks.open.mockResolvedValue({ canceled: false, filePaths: ['C:/synthetic-plan.json'] }); mocks.file.mockResolvedValue(Buffer.from(JSON.stringify(PLAN_FILE_EXAMPLE))); });

describe('native plan file boundary', () => {
  it('only reads a user-selected bounded file and never writes during preview', async () => {
    mocks.preview.mockResolvedValue({ token: 'synthetic-preview' });
    expect(await host().planImportOpen()).toEqual({ ok: true, data: { token: 'synthetic-preview' } });
    expect(mocks.file).toHaveBeenCalledWith('C:/synthetic-plan.json', MAX_PLAN_FILE_BYTES);
    expect(mocks.confirm).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await host().planImportOpen()).toEqual({ ok: true, data: null });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid JSON, UTF-8, oversized files and bad relations before planning', async () => {
    for (const bytes of [Buffer.from('{invalid'), Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ ...PLAN_FILE_EXAMPLE, tasks: [] }))]) {
      mocks.file.mockResolvedValue(bytes);
      await expect(host().planImportOpen()).rejects.toThrow();
    }
    mocks.file.mockRejectedValue(Error('too big'));
    await expect(host().planImportOpen()).rejects.toThrow(/1 MB/);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it('accepts BOM but refuses forged local resource references', async () => {
    mocks.file.mockResolvedValue(Buffer.from('\uFEFF' + JSON.stringify(PLAN_FILE_EXAMPLE)));
    await host().planImportOpen(); expect(mocks.preview).toHaveBeenCalledTimes(1);
    mocks.file.mockResolvedValue(Buffer.from(JSON.stringify({ ...PLAN_FILE_EXAMPLE, resources: [{ id: 'course-notes', kind: 'file', name: '讲义.pdf', deviceId: 'fake', deviceName: '电脑' }] })));
    await expect(host().planImportOpen()).rejects.toThrow(/尚未.*登记/);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it('saves a template with a new planId and respects cancellation', async () => {
    mocks.save.mockResolvedValue({ canceled: true }); expect(await host().planImportTemplate()).toEqual({ ok: true, data: { saved: false } }); expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-template.json' });
    await host().planImportTemplate(); const first = JSON.parse(mocks.write.mock.calls[0]![1]);
    await host().planImportTemplate(); expect(JSON.parse(mocks.write.mock.calls[1]![1]).planId).not.toBe(first.planId);
    expect(first).toMatchObject({ format: 'ultimate-calendar-plan', version: 1 });
  });
  it('rejects untrusted senders and extra confirmation fields at IPC', async () => {
    const trusted = { senderId: 1, frameId: 2, url: 'app://synthetic' }, handler = vi.fn();
    expect((await dispatchRequest('planImportOpen', undefined, { ...trusted, senderId: 3 }, trusted, { planImportOpen: handler })).ok).toBe(false);
    expect((await dispatchRequest('planImportConfirm', { token: 'x', confirmed: true }, trusted, trusted, { planImportConfirm: handler })).ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
