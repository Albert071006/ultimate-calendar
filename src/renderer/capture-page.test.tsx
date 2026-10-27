// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CapturePage } from './components/CapturePage';
import { SourceViewer } from './components/ImportDialog';
import { CaptureConfigSchema, CaptureSnapshotSchema, type CaptureSnapshot } from '../shared/capture';
import { SourceSchema, type DesktopAPI, type Source } from '../shared/contracts';
import { emptyAccountState } from '../shared/account';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const time = '2026-10-23T12:00:00+08:00';
const oldMessage = { id: 'old-message', accountId: '10001', groupId: 'g1', messageId: 'raw-old', groupName: '旧账号群', senderName: '旧群成员', sentAt: time, importedAt: time, text: '旧账号原文', changed: false, deleted: false,
  attachments: [{ id: 'old-attachment', name: '旧账号附件.txt', kind: 'file' as const, status: 'ready' as const, size: 8, error: null, chunkCount: 1 }] };
const oldPage = { items: [oldMessage], total: 1, offset: 0, limit: 30 };
function fixture(initial?: Partial<CaptureSnapshot>, reference?: NonNullable<Source['captureRef']>, modalities?: string[] | null, scope: 'local' | 'cloud' = 'local', platform: 'qq' | 'wechat' = 'qq') {
  let state = CaptureSnapshotSchema.parse({ config: { accountId: '10001', groupIds: [], enabled: false }, connection: 'online', accountLabel: 'QQ 1***1', accountName: '测试同学', error: null,
    lastReceivedAt: null, credentialConfigured: true,
    stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [], ...initial });
  let listener: (state: CaptureSnapshot) => void = () => {};
  const config = vi.fn(async (next: unknown) => { state = { ...state, config: CaptureConfigSchema.parse(next) }; return { ok: true as const, data: structuredClone(state) }; });
  const connect = vi.fn(async () => ({ ok: true as const, data: structuredClone(state) }));
  const action = vi.fn(async (request: { action: string; batchId?: string }) => {
    if (request.action === 'disconnect') state = { ...state, connection: 'disconnected', accountLabel: null, accountName: null, config: { ...state.config, accountId: null, groupIds: [], enabled: false, analysisEnabled: false } };
    return { ok: true as const, data: structuredClone(state) };
  });
  const clear = vi.fn(async () => ({ ok: true as const, data: structuredClone(state) }));
  const batch = { id: 'batch-1', operationId: 'op-1', accountId: '10001', groupId: 'g1', status: 'uncertain' as const, createdAt: time, updatedAt: time, messageCount: 2, attemptCount: 1, error: '未取得响应' };
  const account = emptyAccountState(); account.models.data = [{ id: 'test-model', ...(modalities ? { inputModalities: modalities } : {}) }];
  const api = {
    accountSnapshot: async () => ({ ok: true, data: account }), onAccountChanged: () => () => {},
    captureSnapshot: vi.fn(async () => ({ ok: true, data: structuredClone(state) })),
    captureConfigure: config, captureConnect: connect, captureAction: action, captureCleanup: clear,
    captureGroups: vi.fn(async () => ({ ok: true, data: [{ id: 'g1', name: '课程群' }, { id: 'g2', name: '班级群' }] })),
    captureMessages: vi.fn(async () => ({ ok: true, data: { items: [], total: 0, offset: 0, limit: 30 } })),
    captureBatches: vi.fn(async () => ({ ok: true, data: { items: [batch], total: 1, offset: 0, limit: 30 } })),
    captureChunks: vi.fn(async () => ({ ok: true, data: { items: [], total: 0, offset: 0, limit: 5 } })),
    onCaptureChanged: (next: typeof listener) => { listener = next; return () => {}; },
  } as unknown as DesktopAPI;
  if (platform === 'wechat') {
    for (const suffix of ['Snapshot', 'Configure', 'Connect', 'Groups', 'Messages', 'Batches', 'Action', 'Chunks', 'Cleanup'] as const) {
      const key = `capture${suffix}` as const;
      (api as unknown as Record<string, unknown>)[`wechatCapture${suffix}`] = api[key];
      (api as unknown as Record<string, unknown>)[key] = vi.fn(() => { throw Error('WeChat must not call QQ APIs'); });
    }
    api.onWechatCaptureChanged = api.onCaptureChanged;
    api.onCaptureChanged = vi.fn(() => { throw Error('WeChat must not subscribe to QQ'); });
  }
  const view = render(<CapturePage platform={platform} ui={{ client: api, host: api, ...(modalities !== undefined || scope === 'cloud' ? { snapshot: { settings: { model: 'test-model' }, keyStatus: { scope } } } : {}) } as unknown as PlannerUI} initialReference={reference} />);
  const update = (next: Partial<CaptureSnapshot>) => { state = CaptureSnapshotSchema.parse({ ...state, ...next }); };
  return { api, config, connect, action, clear, unmount: view.unmount, state: () => structuredClone(state), update,
    push(next: CaptureSnapshot) { act(() => listener(next)); }, emit(next: Partial<CaptureSnapshot>) { update(next); act(() => listener(state)); } };
}

describe('QQ capture page', () => {
  it('shows automatic key synchronization and allows cancelling credential recovery without stopping collection', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', groupIds: ['g1'], enabled: true, analysisEnabled: false }),
      analysisWaitingForKey: true, cloudKeySync: { state: 'ready', revision: null, configured: false, lastSyncedAt: new Date(time).toISOString(), message: null } }, undefined, undefined, 'cloud');
    expect(await screen.findByText('等待有效密钥，更新后自动继续')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止等待密钥' }));
    await waitFor(() => expect(f.action).toHaveBeenCalledExactlyOnceWith({ action: 'pause-analysis' }));
    expect(f.config).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '暂停收集' })).toBeTruthy();
  });
  it('requires explicit selection and a separate start action before collecting', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线');
    expect((screen.getByRole('button', { name: '开始收集' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    const course = await screen.findByRole('checkbox', { name: '课程群 g1' }); fireEvent.click(course);
    fireEvent.click(screen.getByRole('button', { name: '保存群选择' }));
    await waitFor(() => expect(f.config).toHaveBeenCalledTimes(1));
    expect(f.config.mock.calls[0]![0]).toMatchObject({ groupIds: ['g1'], enabled: false, accountId: '10001' });
    await waitFor(() => expect((screen.getByRole('button', { name: '开始收集' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '开始收集' }));
    await waitFor(() => expect(f.config).toHaveBeenCalledTimes(2));
    expect(f.config.mock.calls[1]![0]).toMatchObject({ enabled: true, groupIds: ['g1'] });
  });
  it('clears the password immediately after sending and does not display a saved secret', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线');
    const input = screen.getByLabelText('桥接访问令牌') as HTMLInputElement;
    expect(input.value).toBe(''); expect(input.placeholder).toContain('无需重填');
    fireEvent.change(input, { target: { value: 'fixture-secret-only' } }); fireEvent.click(screen.getByRole('button', { name: '连接此地址' }));
    expect(input.value).toBe(''); await waitFor(() => expect(f.connect).toHaveBeenCalled());
    expect(f.connect.mock.calls[0]).toEqual([{ detect: false, token: 'fixture-secret-only' }]);
    expect(screen.queryByText('fixture-secret-only')).toBeNull();
  });
  it('requires confirmation before retrying a response-unknown paid request', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '分析批次' }));
    fireEvent.click(await screen.findByRole('button', { name: '重试此批' }));
    expect(f.action).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: '重试响应未知的分析' });
    expect(within(dialog).getByText(/重试可能产生重复费用/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重试' }));
    await waitFor(() => expect(f.action).toHaveBeenCalledWith({ action: 'retry', batchId: 'batch-1' }));
  });
  it('keeps collection and analysis pauses separate', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', groupIds: ['g1'], enabled: true, analysisEnabled: true }) });
    await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '暂停分析' }));
    await waitFor(() => expect(f.config).toHaveBeenCalledTimes(1));
    expect(f.config.mock.calls[0]![0]).toMatchObject({ enabled: true, analysisEnabled: false });
    expect(await screen.findByText('自动分析已暂停')).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停收集' })).toBeTruthy();
  });
  it('explains an automatic AUTH pause beside the switch and removes the earlier enable notice', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', groupIds: ['g1'], enabled: true, analysisEnabled: false }) });
    fireEvent.click(await screen.findByRole('button', { name: '开启分析' }));
    expect(await screen.findByText('已开启自动分析。')).toBeTruthy();
    f.emit({ config: { ...f.state().config, analysisEnabled: false }, error: 'DeepSeek 密钥无效，请检查设置' });
    const row = screen.getByRole('button', { name: '开启分析' }).parentElement!;
    expect(within(row).getByRole('alert').textContent).toBe('暂停原因：DeepSeek 密钥无效，请检查设置');
    expect(screen.queryByText('已开启自动分析。')).toBeNull();
    expect(screen.getByRole('button', { name: '暂停收集' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '立即分析' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('polls a cloud collector while this page is open and shows a background pause within two seconds', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', groupIds: ['g1'], analysisEnabled: false }) }, undefined, undefined, 'cloud');
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开启分析' })); });
    expect(screen.getByText('已开启自动分析。')).toBeTruthy();
    f.update({ config: { ...f.state().config, analysisEnabled: false }, error: 'DeepSeek 密钥无效，请检查设置' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(f.api.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText('自动分析已开启')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(f.api.captureSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText('暂停原因：DeepSeek 密钥无效，请检查设置')).toBeTruthy();
    expect(screen.queryByText('已开启自动分析。')).toBeNull();
    f.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(f.api.captureSnapshot).toHaveBeenCalledTimes(2);
  });
  it('uses live events without polling in local mode', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(f.api.captureSnapshot).toHaveBeenCalledTimes(1);
  });
  it('discards an initial snapshot after a newer local background pause event', async () => {
    const f = fixture();
    f.emit({ config: { ...f.state().config, analysisEnabled: false }, error: 'DeepSeek 密钥无效，请检查设置' });
    await act(async () => {});
    expect(screen.getByText('自动分析已暂停')).toBeTruthy();
    expect(screen.getByText('暂停原因：DeepSeek 密钥无效，请检查设置')).toBeTruthy();
  });
  it('discards a slow cloud poll after the user has enabled analysis', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', analysisEnabled: false }) }, undefined, undefined, 'cloud');
    await act(async () => {});
    const stale = f.state();
    let resolveSnapshot!: (value: Awaited<ReturnType<DesktopAPI['captureSnapshot']>>) => void;
    vi.mocked(f.api.captureSnapshot).mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开启分析' })); });
    // The remote desktop echoes snapshot responses as events before returning them.
    f.push(stale);
    await act(async () => { resolveSnapshot({ ok: true, data: stale }); });
    expect(screen.getByText('自动分析已开启')).toBeTruthy();
    expect(screen.getByText('已开启自动分析。')).toBeTruthy();
  });
  it('does not let a late configure response hide a newer automatic pause or announce success', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', analysisEnabled: false }) });
    let resolveConfigure!: (value: { ok: true; data: CaptureSnapshot }) => void;
    const enabled = { ...f.state(), config: { ...f.state().config, analysisEnabled: true } };
    f.config.mockImplementationOnce(() => new Promise(resolve => { resolveConfigure = resolve; }));
    fireEvent.click(await screen.findByRole('button', { name: '开启分析' }));
    f.emit({ error: 'DeepSeek 密钥无效，请检查设置' });
    await act(async () => { resolveConfigure({ ok: true, data: enabled }); });
    expect(screen.getByText('自动分析已暂停')).toBeTruthy();
    expect(screen.getByText('暂停原因：DeepSeek 密钥无效，请检查设置')).toBeTruthy();
    expect(screen.queryByText('已开启自动分析。')).toBeNull();
  });
  it('reviews the cleanup date in Shanghai time before deleting originals', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线');
    fireEvent.change(screen.getByLabelText('删除此日期之前的原文'), { target: { value: '2026-10-17' } });
    fireEvent.click(screen.getByRole('button', { name: '清理所选原文与附件…' })); expect(f.clear).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: '确认清理原文与附件' });
    expect(within(dialog).getByText(/2026-10-17 00:00（北京时间）之前/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(f.clear).toHaveBeenCalledWith({ accountId: '10001', before: '2026-10-17T00:00:00+08:00' }));
  });
  it('discards previous account group drafts when QQ changes accounts', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '课程群 g1' }));
    f.emit({ connection: 'account-changed', accountLabel: 'QQ 2***2', config: CaptureConfigSchema.parse({ accountId: '20002', groupIds: [] }) });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '课程群 g1' })).toBeNull());
    expect(screen.getByText('已勾选 0 个群')).toBeTruthy();
  });
  it('keeps unsaved group choices and endpoint edits through repeated health updates', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '课程群 g1' }));
    fireEvent.change(screen.getByLabelText('本机桥接地址'), { target: { value: 'ws://127.0.0.1:5555' } });
    fireEvent.change(screen.getByLabelText('日历专用桥接类型'), { target: { value: 'snowluma' } });
    for (let index = 0; index < 4; index++) f.emit({ lastReceivedAt: time });
    expect((screen.getByRole('checkbox', { name: '课程群 g1' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('本机桥接地址') as HTMLInputElement).value).toBe('ws://127.0.0.1:5555');
    expect((screen.getByLabelText('日历专用桥接类型') as HTMLSelectElement).value).toBe('snowluma');
    expect(f.config).not.toHaveBeenCalled();
  });
  it('confirms unlinking a changed account and calls the dedicated disconnect action without deleting records', async () => {
    const f = fixture({ connection: 'account-changed' }); await screen.findByText('QQ 账号已变化');
    fireEvent.click(screen.getByRole('button', { name: '解除账号绑定…' }));
    const dialog = screen.getByRole('dialog', { name: '解除 QQ 账号绑定' });
    expect(within(dialog).getByText(/不会删除已经收集的消息、附件、候选或日历事项/)).toBeTruthy();
    expect(f.action).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认解除绑定' }));
    await waitFor(() => expect(f.action).toHaveBeenCalledWith({ action: 'disconnect' }));
    expect(f.clear).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled();
    expect(await screen.findByText('尚未绑定')).toBeTruthy(); expect(screen.getByText('自动分析已暂停')).toBeTruthy();
    expect((screen.getByLabelText('桥接访问令牌') as HTMLInputElement).placeholder).toContain('已保存');
  });
  it('shows the connected nickname and complete bound QQ number for account verification', async () => {
    fixture();
    expect(await screen.findByText('测试同学')).toBeTruthy(); expect(screen.getByText('10001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日历专用 QQ 连接' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '检测日历专用 QQ 组件' })).toBeTruthy();
  });
  it('saves the selected bridge flavor together with the endpoint before a manual connection', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线');
    fireEvent.change(screen.getByLabelText('日历专用桥接类型'), { target: { value: 'snowluma' } });
    fireEvent.change(screen.getByLabelText('本机桥接地址'), { target: { value: 'ws://127.0.0.1:43132' } });
    fireEvent.click(screen.getByRole('button', { name: '连接此地址' }));
    await waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({ flavor: 'snowluma', endpoint: 'ws://127.0.0.1:43132', enabled: false, analysisEnabled: false }));
    expect(f.config.mock.invocationCallOrder[0]!).toBeLessThan(f.connect.mock.invocationCallOrder[0]!);
    expect(await screen.findByText('自动分析已暂停')).toBeTruthy();
  });
  it('allows unlinking a normally connected account after collection is paused', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ accountId: '10001', groupIds: ['g1'], enabled: true }) });
    await screen.findByText('QQ 已在线'); expect(screen.queryByRole('button', { name: '解除账号绑定…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '暂停收集' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除账号绑定…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '解除 QQ 账号绑定' })).getByRole('button', { name: '取消' }));
    expect(f.action).not.toHaveBeenCalled();
  });
  it('targets a source message by its stable ID instead of searching the first page of a busy group', async () => {
    const reference = { accountId: '10001', groupId: 'g1', messageId: 'qqm:stable-id', attachmentId: null, locator: '原消息', transcribed: false };
    const f = fixture(undefined, reference); await screen.findByText('QQ 已在线');
    await waitFor(() => expect(f.api.captureMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: '10001', groupId: 'g1', messageId: 'qqm:stable-id' })));
  });
  it('marks AI transcription and routes source review to capture without allowing ordinary paid reanalysis', () => {
    const reference = { accountId: '10001', groupId: 'g1', messageId: 'qqm:stable-id', attachmentId: 'attachment-1', locator: '第 3 页', transcribed: true };
    const source = SourceSchema.parse({ id: 'source-1', version: 1, createdAt: time, updatedAt: time, kind: 'text', text: '保留的候选依据', importedAt: time, captureRef: reference });
    const open = vi.fn();
    render(<SourceViewer source={source} ui={{ client: {}, host: {}, busy: false } as PlannerUI} onClose={() => {}} settings={() => {}} courses={() => {}} onCapture={open} />);
    expect(screen.getByText('AI 图片转写 · 请对照原件核对')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '提交 / 重试消息分析' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看本机采集记录与附件' })); expect(open).toHaveBeenCalledWith(reference);
  });
  it('shows an explicit warning for a selected model known not to support images', async () => {
    fixture(undefined, undefined, ['text']);
    expect(await screen.findByText(/当前模型不支持图片输入。图片与扫描页会保留/)).toBeTruthy();
    expect(screen.getByText('当前 DeepSeek 模型：test-model')).toBeTruthy();
  });
  it('distinguishes unknown image capabilities from confirmed image support', async () => {
    fixture(undefined, undefined, null);
    expect(await screen.findByText(/接口尚未说明图片能力/)).toBeTruthy();
    expect(screen.queryByText(/模型接口标注支持图片输入/)).toBeNull();
  });
  it('does not query messages, batches or attachment contents without an account binding or explicit source reference', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({}), connection: 'disconnected', accountLabel: null, accountName: null });
    await screen.findByText(/^尚未绑定 QQ 账号，暂不读取/);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    fireEvent.click(screen.getByRole('button', { name: '分析批次' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(f.api.captureMessages).not.toHaveBeenCalled(); expect(f.api.captureBatches).not.toHaveBeenCalled(); expect(f.api.captureChunks).not.toHaveBeenCalled();
  });
  it('immediately hides old account records and attachment details when the account changes', async () => {
    const f = fixture(); vi.mocked(f.api.captureMessages).mockResolvedValueOnce({ ok: true, data: oldPage });
    let resolveChunks!: (value: Awaited<ReturnType<DesktopAPI['captureChunks']>>) => void;
    vi.mocked(f.api.captureChunks).mockImplementationOnce(() => new Promise(resolve => { resolveChunks = resolve; }));
    fireEvent.click(await screen.findByRole('button', { name: /旧账号附件.txt/ }));
    expect(screen.getByRole('dialog', { name: '旧账号附件.txt' })).toBeTruthy();
    await waitFor(() => expect(f.api.captureChunks).toHaveBeenCalledTimes(1));
    f.emit({ config: CaptureConfigSchema.parse({ accountId: '20002', groupIds: [] }), accountName: '新账号昵称' });
    expect(screen.queryAllByText('旧账号原文')).toHaveLength(0); expect(screen.queryByRole('dialog', { name: '旧账号附件.txt' })).toBeNull();
    await act(async () => { resolveChunks({ ok: true, data: { items: [{ id: 'old-chunk', locator: '第 1 行', text: '迟到的旧附件内容', imageDataUrl: null, status: 'ready', error: null }], total: 1, offset: 0, limit: 5 } }); });
    expect(screen.queryByText('迟到的旧附件内容')).toBeNull();
    await waitFor(() => expect(f.api.captureMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: '20002' })));
    expect(vi.mocked(f.api.captureMessages).mock.calls.every(([request]) => !!request.accountId)).toBe(true);
  });
  it('discards a late message page from the previous account after switching accounts', async () => {
    const f = fixture(); let resolveOld!: (value: Awaited<ReturnType<DesktopAPI['captureMessages']>>) => void;
    vi.mocked(f.api.captureMessages).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await waitFor(() => expect(f.api.captureMessages).toHaveBeenCalledTimes(1));
    f.emit({ config: CaptureConfigSchema.parse({ accountId: '20002', groupIds: [] }), accountName: '新账号昵称' });
    await waitFor(() => expect(f.api.captureMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: '20002' })));
    await act(async () => { resolveOld({ ok: true, data: oldPage }); });
    expect(screen.queryAllByText('旧账号原文')).toHaveLength(0); expect(screen.queryByText('旧账号群')).toBeNull();
  });
  it('discards a late group list from the previous binding even when returning to the same QQ number', async () => {
    const f = fixture(); let resolveGroups!: (value: Awaited<ReturnType<DesktopAPI['captureGroups']>>) => void;
    vi.mocked(f.api.captureGroups).mockImplementationOnce(() => new Promise(resolve => { resolveGroups = resolve; }));
    await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    f.emit({ config: CaptureConfigSchema.parse({}), connection: 'disconnected', accountName: null });
    f.emit({ config: CaptureConfigSchema.parse({ accountId: '10001' }), connection: 'online', accountName: '测试同学' });
    await act(async () => { resolveGroups({ ok: true, data: [{ id: 'old-g', name: '过期群列表' }] }); });
    expect(screen.queryByRole('checkbox', { name: '过期群列表 old-g' })).toBeNull();
  });
  it('clears loaded batches after unbinding and never replaces them with a query across all accounts', async () => {
    const f = fixture(); await screen.findByText('QQ 已在线'); fireEvent.click(screen.getByRole('button', { name: '分析批次' }));
    await screen.findByRole('button', { name: '重试此批' });
    const requests = vi.mocked(f.api.captureBatches).mock.calls.length;
    f.emit({ config: CaptureConfigSchema.parse({}), connection: 'disconnected', accountLabel: null, accountName: null });
    expect(screen.queryByRole('button', { name: '重试此批' })).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(f.api.captureBatches).toHaveBeenCalledTimes(requests);
  });
  it('allows an explicitly opened source account while unbound and labels it distinctly', async () => {
    const reference = { accountId: '10001', groupId: 'g1', messageId: 'old-message', attachmentId: null, locator: '指定原消息', transcribed: false };
    const f = fixture({ config: CaptureConfigSchema.parse({}), connection: 'disconnected', accountLabel: null, accountName: null }, reference);
    expect(await screen.findByText('正在查看来源账号 QQ 10001 的指定消息 · 指定原消息')).toBeTruthy();
    await waitFor(() => expect(f.api.captureMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: '10001', groupId: 'g1', messageId: 'old-message' })));
    fireEvent.click(screen.getByRole('button', { name: '结束来源查看' }));
    const requests = vi.mocked(f.api.captureMessages).mock.calls.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(f.api.captureMessages).toHaveBeenCalledTimes(requests); expect(screen.getByText(/^尚未绑定 QQ 账号，暂不读取/)).toBeTruthy();
  });
});


describe('WeChat capture page', () => {
  it.each([
    { modalities: ['text'], message: /当前模型不支持图片输入/ },
    { modalities: ['text', 'image'], message: /模型接口标注支持图片输入/ },
    { modalities: null, message: /接口尚未说明图片能力/ },
  ])('uses current model capabilities for cached WeChat media: $modalities', async ({ modalities, message }) => {
    const f = fixture({ config: CaptureConfigSchema.parse({ platform: 'wechat', accountId: 'wechat:synthetic-user' }), platform: 'wechat' }, undefined, modalities, 'local', 'wechat');
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText(/电脑微信已缓存或下载的图片和文件/)).toBeTruthy();
    expect(screen.queryByText(/当前微信采集只分析文字与卡片标题/)).toBeNull();
    expect(f.config).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
  });
  it('takes an unavailable attachment to its own batch without starting analysis or discarding paid progress', async () => {
    const accountId = 'wechat:synthetic-user', messageId = 'wxm:synthetic-image';
    const f = fixture({ config: CaptureConfigSchema.parse({ platform: 'wechat', accountId, groupIds: ['g1'], enabled: true }), platform: 'wechat' }, undefined, undefined, 'local', 'wechat');
    const attachment = { id: 'wechat-image', name: '合成通知.png', kind: 'image' as const, status: 'failed' as const, size: null, error: '请在微信中打开或下载后重试', chunkCount: 0 };
    vi.mocked(f.api.wechatCaptureMessages).mockResolvedValue({ ok: true, data: { ...oldPage, items: [{ ...oldMessage, id: messageId, accountId, attachments: [attachment] }] } });
    vi.mocked(f.api.wechatCaptureBatches).mockResolvedValue({ ok: true, data: { items: [{ id: 'wechat-batch', operationId: 'wechat-operation', accountId, groupId: 'g1', status: 'failed', createdAt: time, updatedAt: time, messageCount: 1, attemptCount: 0, error: '等待在微信下载附件' }], total: 1, offset: 0, limit: 30 } });
    fireEvent.click(await screen.findByRole('button', { name: /合成通知.png/ }));
    const dialog = screen.getByRole('dialog', { name: '合成通知.png' });
    expect(within(dialog).getByText(/先在电脑微信中打开或下载/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '查看对应分析批次' }));
    await waitFor(() => expect(f.api.wechatCaptureBatches).toHaveBeenCalledWith({ accountId, groupId: 'g1', messageId, offset: 0, limit: 30 }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(f.action).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '重试此批' }));
    await waitFor(() => expect(f.action).toHaveBeenCalledExactlyOnceWith({ action: 'retry', batchId: 'wechat-batch' }));
    fireEvent.click(screen.getByRole('button', { name: '返回批次列表' }));
    await waitFor(() => expect(f.api.wechatCaptureBatches).toHaveBeenLastCalledWith({ accountId, groupId: 'g1', offset: 0, limit: 30 }));
    expect(f.api.captureBatches).not.toHaveBeenCalled(); expect(f.api.captureAction).not.toHaveBeenCalled();
  });
  it('uses independent WeChat routes and requires saving selected groups before starting', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ platform: 'wechat', accountId: 'wechat:synthetic-user', groupIds: [], enabled: false }), platform: 'wechat' }, undefined, undefined, 'local', 'wechat');
    await screen.findByText('微信 已在线');
    expect(screen.queryByLabelText('桥接访问令牌')).toBeNull();
    expect(screen.queryByRole('button', { name: '连接此地址' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '连接本机微信' }));
    await waitFor(() => expect(f.connect).toHaveBeenCalledExactlyOnceWith({}));
    fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '课程群 g1' }));
    fireEvent.click(screen.getByRole('button', { name: '保存群选择' }));
    await waitFor(() => expect(f.config).toHaveBeenCalledTimes(1));
    expect(f.config.mock.calls[0]![0]).toMatchObject({ platform: 'wechat', accountId: 'wechat:synthetic-user', groupIds: ['g1'], enabled: false });
    await waitFor(() => expect((screen.getByRole('button', { name: '开始收集' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '开始收集' }));
    await waitFor(() => expect(f.config).toHaveBeenCalledTimes(2));
    expect(f.config.mock.calls[1]![0]).toMatchObject({ enabled: true, groupIds: ['g1'] });
    expect(f.api.captureSnapshot).not.toHaveBeenCalled();
    expect(f.api.captureConfigure).not.toHaveBeenCalled();
    expect(f.api.onCaptureChanged).not.toHaveBeenCalled();
  });
  it('shows WeChat search actions for stored source messages', async () => {
    const f = fixture({ config: CaptureConfigSchema.parse({ platform: 'wechat', accountId: 'wechat:synthetic-user' }), platform: 'wechat' }, undefined, undefined, 'local', 'wechat');
    vi.mocked(f.api.wechatCaptureMessages).mockResolvedValue({ ok: true, data: { ...oldPage, items: [{ ...oldMessage, accountId: 'wechat:synthetic-user', attachments: [] }] } });
    expect(await screen.findByRole('button', { name: '复制 微信 搜索关键词' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制 QQ 搜索关键词' })).toBeNull();
  });
});
