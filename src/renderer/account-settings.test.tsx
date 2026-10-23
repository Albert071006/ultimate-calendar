// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AccountStateSchema, emptyAccountState, type AccountState } from '../shared/account';
import { SettingsSchema, SnapshotSchema, type DesktopAPI, type KeyStatus, type Settings as SettingsValue, type TokenUsage } from '../shared/contracts';
import { Settings } from './components/Settings';
import { usePlanner } from './hooks/usePlanner';

afterEach(cleanup);
const stamp = new Date().toISOString();
function readyState(): AccountState {
  return AccountStateSchema.parse({ configured: true,
    models: { data: [
      { id: 'deepseek-flash', name: 'Flash fixture', contextWindow: 1000000, maxOutputTokens: 8000, inputModalities: ['text', 'image'] },
      { id: 'deepseek-pro-fixture' },
    ], updatedAt: stamp, loading: false, error: null },
    balance: { data: { isAvailable: true, balances: [
      { currency: 'CNY', total: '12.345678', granted: '2.345678', toppedUp: '10.00' },
      { currency: 'USD', total: '3.14', granted: '0.14', toppedUp: '3.00' },
    ] }, updatedAt: stamp, loading: false, error: null },
    prices: { data: { entries: [{ model: 'deepseek-flash', currency: 'CNY',
      low: { inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4 },
      high: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8 }, updatedAt: stamp,
      sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' }], rule: '合成时段规则' }, updatedAt: stamp, loading: false, error: null },
  });
}
function fixture(settings: Partial<SettingsValue> = {}, initial = readyState(), tokenUsage: TokenUsage[] = [], keyStatus: Partial<KeyStatus> = {}) {
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [],
    settings, journal: [], tokenUsage, keyStatus: { configured: initial.configured, sessionOnly: false, ...keyStatus } });
  let account = initial;
  let changed: ((state: AccountState) => void) | null = null;
  const unsubscribe = vi.fn();
  const saveSettings = vi.fn(async (request: { settings: SettingsValue }) => {
    snapshot.settings = SettingsSchema.parse(request.settings);
    return { ok: true as const, data: snapshot.settings };
  });
  const refreshAccount = vi.fn(async () => ({ ok: true as const, data: structuredClone(account) }));
  const retryApiKey = vi.fn(async () => {
    snapshot.keyStatus = { configured: true, sessionOnly: false };
    return { ok: true as const, data: snapshot.keyStatus };
  });
  const setApiKey = vi.fn(async ({ key }: { key: string | null }) => {
    snapshot.keyStatus = { configured: !!key, sessionOnly: false };
    return { ok: true as const, data: snapshot.keyStatus };
  });
  const courses = vi.fn();
  const api = {
    snapshot: async () => ({ ok: true as const, data: structuredClone(snapshot) }),
    onChanged: () => () => {}, onNavigate: () => () => {},
    accountSnapshot: vi.fn(async () => ({ ok: true as const, data: structuredClone(account) })), refreshAccount,
    onAccountChanged: (listener: (state: AccountState) => void) => { changed = listener; return unsubscribe; },
    saveSettings, retryApiKey, setApiKey,
  } as unknown as DesktopAPI;
  function Harness() { const ui = usePlanner(api, api); return ui.snapshot ? <Settings snapshot={ui.snapshot} ui={ui} courses={courses} /> : null; }
  const view = render(<Harness />);
  return { ...view, api, snapshot, saveSettings, refreshAccount, retryApiKey, setApiKey, courses, unsubscribe, emit(next: AccountState) { account = next; act(() => changed?.(next)); } };
}

describe('DeepSeek account settings', () => {
  it('groups account, rates and usage together and keeps infrequent settings collapsed without losing saved values', async () => {
    const f = fixture({ campus: '示例大学北校区', termStart: '2026-08-31', termWeeks: 20,
      periodMap: [{ period: 1, startTime: '08:30', endTime: '09:15' }], locationContext: '合成地点背景',
      closeToTray: false, autoLaunch: true, courseReminders: true, blockLeadMinutes: [15], taskLeadMinutes: [60, 30],
    });
    await screen.findByText('12.345678');
    expect(f.container.querySelectorAll('form > .settings-group')).toHaveLength(4);
    const ai = screen.getByRole('region', { name: 'AI 与费用' });
    expect(within(ai).getByText('API 使用记录')).toBeTruthy();
    expect(within(ai).getByText('模型单价与调用费用')).toBeTruthy();
    for (const selector of ['.settings-campus', '.settings-pricing', '.settings-key', '.api-usage', '.settings-backup', '.operation-history']) {
      expect((f.container.querySelector(selector) as HTMLDetailsElement).open).toBe(false);
    }
    expect(screen.getByText(/示例大学北校区 · 学期始于 2026-08-31 · 20 周 · 1 节/)).toBeTruthy();
    const original = structuredClone(f.snapshot.settings);
    fireEvent.click(screen.getByRole('button', { name: '保存全部设置' }));
    await waitFor(() => expect(f.saveSettings).toHaveBeenCalledTimes(1));
    expect(f.saveSettings.mock.calls[0]![0].settings).toEqual(original);
    expect(f.setApiKey).not.toHaveBeenCalled();
  });

  it('retains folded campus, term, reminders and manual-price drafts through account updates and submits them once', async () => {
    const f = fixture({ pricingMode: 'manual', tokenPrices: { model: 'deepseek-flash', inputPerMillion: 1,
      cachedInputPerMillion: 0.02, outputPerMillion: 4, currency: 'CNY', updatedAt: '2026-10-23T08:00:00+08:00' } });
    await screen.findByText('12.345678');
    fireEvent.click(screen.getByText('日历与校园'));
    fireEvent.change(screen.getByLabelText('学校与校区'), { target: { value: '合成校园草稿' } });
    fireEvent.change(screen.getByLabelText('第一教学周周一'), { target: { value: '2026-08-31' } });
    fireEvent.change(screen.getByLabelText('节次时间（每行：节次,开始,结束）'), { target: { value: '1,08:30,09:15\n2,09:20,10:05' } });
    fireEvent.click(screen.getByText('日历与校园'));
    fireEvent.click(screen.getByText('提前提醒与提醒时刻'));
    fireEvent.change(screen.getByLabelText('任务截止提前分钟'), { target: { value: '25,5' } });
    fireEvent.click(screen.getByText('提前提醒与提醒时刻'));
    fireEvent.click(screen.getByText('模型单价与调用费用'));
    fireEvent.change(screen.getByLabelText('输入 / 百万 token'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('模型单价与调用费用'));
    const fresh = readyState(); fresh.balance.data!.balances[0]!.total = '11.88'; f.emit(fresh);
    expect(screen.getByText('11.88')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存全部设置' }));
    await waitFor(() => expect(f.saveSettings).toHaveBeenCalledTimes(1));
    expect(f.saveSettings.mock.calls[0]![0].settings).toMatchObject({ campus: '合成校园草稿', termStart: '2026-08-31',
      periodMap: [{ period: 1, startTime: '08:30', endTime: '09:15' }, { period: 2, startTime: '09:20', endTime: '10:05' }],
      taskLeadMinutes: [25, 5], tokenPrices: { inputPerMillion: 2.5, outputPerMillion: 4 }, model: 'deepseek-flash' });
    expect((f.container.querySelector('.settings-campus') as HTMLDetailsElement).open).toBe(false);
  });

  it('saves a key and opens course management independently without submitting settings drafts', async () => {
    const f = fixture(); await screen.findByText('12.345678');
    const keys = f.container.querySelector('.settings-key') as HTMLDetailsElement;
    fireEvent.click(keys.querySelector('summary')!);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-test-key' } });
    fireEvent.change(screen.getByLabelText('学校与校区'), { target: { value: '尚未保存草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
    await waitFor(() => expect(f.setApiKey).toHaveBeenCalledWith({ key: 'synthetic-test-key' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存全部设置' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('学校与校区') as HTMLInputElement).value).toBe('尚未保存草稿');
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-enter-key' } });
    expect(fireEvent.keyDown(screen.getByLabelText('API Key'), { key: 'Enter' })).toBe(false);
    await waitFor(() => expect(f.setApiKey).toHaveBeenCalledWith({ key: 'synthetic-enter-key' }));
    fireEvent.click(screen.getByText('日历与校园'));
    fireEvent.click(screen.getByRole('button', { name: '打开课程与导入校对' }));
    expect(f.courses).toHaveBeenCalledTimes(1);
    expect(f.saveSettings).not.toHaveBeenCalled();
  });

  it('reveals a collapsed invalid required field so native validation can focus it', async () => {
    const f = fixture({ pricingMode: 'manual' }); await screen.findByText('12.345678');
    const pricing = f.container.querySelector('.settings-pricing') as HTMLDetailsElement;
    expect(pricing.open).toBe(false);
    fireEvent.invalid(screen.getByLabelText('输入 / 百万 token'));
    expect(pricing.open).toBe(true);
    expect(f.saveSettings).not.toHaveBeenCalled();
  });

  it('saves editable campus context without requiring or changing an API key', async () => {
    const f = fixture();
    const campus = await screen.findByLabelText('学校与校区');
    expect((campus as HTMLInputElement).value).toBe('');
    fireEvent.change(campus, { target: { value: '示例大学北校区' } });
    fireEvent.change(screen.getByLabelText('地点理解补充'), { target: { value: '校内简称按所在校区理解，保留原名。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全部设置' }));
    await waitFor(() => expect(f.saveSettings).toHaveBeenCalledTimes(1));
    expect(f.saveSettings.mock.calls[0]![0].settings).toMatchObject({ campus: '示例大学北校区', locationContext: '校内简称按所在校区理解，保留原名。' });
    expect(f.snapshot.keyStatus.configured).toBe(true);
  });
  it('distinguishes a temporary load failure and recovers without entering or displaying a key', async () => {
    const f = fixture({}, emptyAccountState(), [], { configured: false, loadError: 'decrypt' });
    expect(await screen.findByText('已保存的密钥暂未载入 · 原文件已保留')).toBeTruthy();
    expect(screen.queryByText('尚未配置密钥 · 本地手动功能可正常使用')).toBeNull();
    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '重新读取已保存密钥' }));
    expect(await screen.findByText('密钥已保存 · 系统加密保护 · 无需重复填写')).toBeTruthy();
    expect(f.retryApiKey).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('无需重复输入');
    expect(screen.queryByRole('button', { name: '重新读取已保存密钥' })).toBeNull();
  });

  it('shows discovered models, optional metadata, separate decimal balances and official rates', async () => {
    fixture();
    expect(await screen.findByText('12.345678')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '账户余额 · 官方查询' })).toBeTruthy();
    expect(screen.getByText('余额直接来自 DeepSeek 账户，不根据 token 推算。')).toBeTruthy();
    fireEvent.click(screen.getByText('模型单价与调用费用'));
    const balanceHeading = screen.getByRole('heading', { name: '账户余额 · 官方查询' });
    const keyInput = screen.getByLabelText('API Key');
    expect(balanceHeading.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('3.14')).toBeTruthy();
    expect(screen.getByText('充值余额 10.00 · 赠送余额 2.345678')).toBeTruthy();
    const models = screen.getByRole('combobox', { name: '可用模型' }) as HTMLSelectElement;
    expect(models.value).toBe('deepseek-flash');
    expect(screen.getByRole('option', { name: 'Flash fixture · deepseek-flash' })).toBeTruthy();
    expect(screen.getByText(/上下文：1,000,000/)).toBeTruthy();
    expect(screen.getByText('输入 · 缓存命中')).toBeTruthy();
    expect(screen.getByText('空闲时段')).toBeTruthy();
    expect(screen.getByText('合成时段规则')).toBeTruthy();
    fireEvent.change(models, { target: { value: 'deepseek-pro-fixture' } });
    expect(screen.getByText(/上下文：接口未提供/)).toBeTruthy();
    expect(screen.getByText(/暂未获取此模型与币种的官方价格/)).toBeTruthy();
  });

  it('preserves a model absent from discovery and keeps edits through account refresh', async () => {
    const f = fixture({ model: 'previous-model' });
    await screen.findByText('12.345678');
    expect((screen.getByRole('combobox', { name: '可用模型' }) as HTMLSelectElement).value).toBe('previous-model');
    fireEvent.click(screen.getByRole('button', { name: '手动填写模型名称' }));
    fireEvent.change(screen.getByRole('textbox', { name: '模型名称' }), { target: { value: 'new-manual-model' } });
    fireEvent.change(screen.getByRole('textbox', { name: '任务截止提前分钟' }), { target: { value: '60,30' } });
    const next = readyState(); next.balance.data!.balances[0]!.total = '11.1234';
    f.emit(next);
    expect(screen.getByText('11.1234')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '模型名称' }) as HTMLInputElement).value).toBe('new-manual-model');
    expect((screen.getByRole('textbox', { name: '任务截止提前分钟' }) as HTMLInputElement).value).toBe('60,30');
    fireEvent.click(screen.getByRole('button', { name: '保存全部设置' }));
    await waitFor(() => expect(f.saveSettings).toHaveBeenCalledTimes(1));
    expect(f.saveSettings.mock.calls[0]![0].settings).toMatchObject({ model: 'new-manual-model', taskLeadMinutes: [60, 30], pricingMode: 'auto' });
  });

  it('retains cached balance on failures and refresh does not block settings edits', async () => {
    const f = fixture(); await screen.findByText('12.345678');
    const failure = readyState(); failure.balance.error = '网络暂不可用'; failure.balance.updatedAt = '2020-01-01T00:00:00Z';
    f.emit(failure);
    expect(screen.getByText('12.345678')).toBeTruthy();
    expect(screen.getByText(/网络暂不可用；以下保留上次结果/)).toBeTruthy();
    expect(screen.getByText(/余额更新于.*已过期/)).toBeTruthy();
    let done!: (value: { ok: true; data: AccountState }) => void;
    f.refreshAccount.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '刷新账户与价格' }));
    expect((screen.getByRole('button', { name: '正在刷新…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存全部设置' }) as HTMLButtonElement).disabled).toBe(false);
    const fresh = readyState(); fresh.balance.data!.balances[0]!.total = '9.99'; f.emit(fresh);
    await act(async () => done({ ok: true, data: failure }));
    expect(screen.getByText('9.99')).toBeTruthy();
    expect(screen.queryByText('12.345678')).toBeNull();
  });

  it('disables previous manual rates on model change and binds newly entered rates to the new model', async () => {
    const f = fixture({ pricingMode: 'manual', tokenPrices: { model: 'deepseek-flash', inputPerMillion: 99, cachedInputPerMillion: 88, outputPerMillion: 77, currency: 'CNY', updatedAt: '2026-10-23T08:00:00+08:00' } });
    await screen.findByText('12.345678');
    fireEvent.change(screen.getByRole('combobox', { name: '可用模型' }), { target: { value: 'deepseek-pro-fixture' } });
    expect((screen.getByRole('combobox', { name: '费率来源' }) as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByText(/手动单价已停用/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: '费率来源' }), { target: { value: 'manual' } });
    const input = screen.getByRole('spinbutton', { name: '输入 / 百万 token' }) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '输出 / 百万 token' }), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全部设置' }));
    await waitFor(() => expect(f.saveSettings).toHaveBeenCalledTimes(1));
    expect(f.saveSettings.mock.calls[0]![0].settings.tokenPrices).toMatchObject({ model: 'deepseek-pro-fixture', inputPerMillion: 5, outputPerMillion: 10, cachedInputPerMillion: null });
  });

  it('shows missing key without inventing zero balance and unsubscribes on unmount', async () => {
    const f = fixture({}, emptyAccountState());
    expect(await screen.findByText('保存密钥后自动读取可用模型和余额。')).toBeTruthy();
    expect(screen.queryByText('账户余额不足，暂时无法调用 API')).toBeNull();
    expect(screen.queryByText('0.00')).toBeNull();
    f.unmount(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('shows loading then fresh data and keeps legacy usage readable alongside a cost range', async () => {
    const loading = emptyAccountState(); loading.configured = true;
    loading.balance.loading = true; loading.models.loading = true; loading.prices.loading = true;
    const common = { operationId: 'fixture', createdAt: '2026-10-23T08:00:00+08:00', model: 'deepseek-flash', purpose: 'command' as const, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, totalTokens: 1100, currency: 'CNY' as const };
    const f = fixture({}, loading, [
      { ...common, id: 'legacy', estimatedCost: 0.002 },
      { ...common, id: 'range', estimatedCost: 0.0014, estimatedCostMax: 0.0028, pricingSource: 'official', pricingUpdatedAt: '2026-10-23T07:00:00+08:00' },
    ]);
    expect(await screen.findByText('正在刷新余额…')).toBeTruthy();
    expect(screen.getByText('正在刷新模型列表…')).toBeTruthy();
    fireEvent.click(screen.getByText('API 使用记录').closest('summary')!);
    expect(screen.getByText('0.002000 CNY')).toBeTruthy();
    expect(screen.getByText('0.001400 – 0.002800 CNY')).toBeTruthy();
    expect(screen.getByText(/官方费率估算 · 费率/)).toBeTruthy();
    f.emit(readyState());
    expect(screen.queryByText('正在刷新余额…')).toBeNull();
    expect(screen.getByText('12.345678')).toBeTruthy();
  });
});
