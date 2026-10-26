// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SnapshotSchema } from '../shared/contracts';
import type { AiConfigurationStatus } from '../shared/ai-configuration';
import type { PlannerUI } from './hooks/usePlanner';
import { Settings } from './components/Settings';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const initial: AiConfigurationStatus = { provider: 'deepseek', configured: false, editable: true, source: 'none', revision: null };
const revision = '33333333-3333-4333-8333-333333333333';
const changed: AiConfigurationStatus = { ...initial, configured: true, source: 'managed', revision };
const ok = (cloudConfiguration: AiConfigurationStatus) => ({ ok: true as const, data: { configured: cloudConfiguration.configured, sessionOnly: false, scope: 'cloud' as const, cloudConfiguration } });
function setup(status = initial) {
  const host = { retryApiKey: vi.fn().mockResolvedValue(ok(status)), setApiKey: vi.fn().mockResolvedValue(ok(changed)), accountState: vi.fn(), saveSettings: vi.fn() };
  const ui = { host, busy: false, refresh: vi.fn().mockResolvedValue(undefined) } as unknown as PlannerUI;
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: status.configured, sessionOnly: false, scope: 'cloud' } });
  render(<Settings snapshot={snapshot} ui={ui} courses={() => {}} section="ai" />);
  return host;
}
async function ready() { await screen.findByText('已读取云端当前配置。'); }
it('automatically observes another device change but preserves the revision of a typed draft', async () => {
  vi.useFakeTimers(); const host = setup(); await act(async () => {});
  host.retryApiKey.mockResolvedValue(ok(changed));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText('云端已配置 · 不显示完整密钥')).toBeTruthy();
  const field = screen.getByLabelText('API Key') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'synthetic-key-after-phone-save' } });
  host.retryApiKey.mockResolvedValue(ok({ ...changed, revision: '44444444-4444-4444-8444-444444444444' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(host.retryApiKey).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.submit(field.closest('form')!); });
  expect(host.setApiKey).toHaveBeenCalledExactlyOnceWith({ key: 'synthetic-key-after-phone-save', expectedRevision: revision });
});
it('uses the cloud panel, submits the observed revision once and immediately clears the password input', async () => {
  const host = setup(); await ready();
  const field = screen.getByLabelText('API Key') as HTMLInputElement;
  let resolve!: (value: ReturnType<typeof ok>) => void;
  host.setApiKey.mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.change(field, { target: { value: 'synthetic-key-never-use-for-auth' } });
  fireEvent.click(screen.getByRole('button', { name: '保存云端密钥' }));
  expect(field.value).toBe('');
  expect(host.setApiKey).toHaveBeenCalledExactlyOnceWith({ key: 'synthetic-key-never-use-for-auth', expectedRevision: null });
  fireEvent.submit(field.closest('form')!);
  expect(host.setApiKey).toHaveBeenCalledTimes(1);
  resolve(ok(changed));
  await screen.findByText('云端密钥已保存，手机和电脑的生活助手共用。');
  expect(host.accountState).not.toHaveBeenCalled(); expect(host.saveSettings).not.toHaveBeenCalled();
  expect(screen.queryByText(/系统加密保护/)).toBeNull();
});
it('does not overwrite a phone change on conflict and requires a fresh explicit read before another write', async () => {
  const host = setup(); await ready();
  host.setApiKey.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'synthetic conflict', retryable: false } });
  host.retryApiKey.mockResolvedValue(ok(changed));
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-replacement-key' } });
  fireEvent.click(screen.getByRole('button', { name: '保存云端密钥' }));
  await screen.findByText('云端配置已变更，本次未覆盖。请重新读取，再按需填写。');
  await waitFor(() => expect(host.retryApiKey).toHaveBeenCalledTimes(2));
  expect((screen.getByRole('button', { name: '保存云端密钥' }) as HTMLButtonElement).disabled).toBe(true);
  expect(host.setApiKey).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重新读取云端配置' })); await ready();
  host.setApiKey.mockResolvedValue(ok(changed));
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-second-replacement' } });
  fireEvent.click(screen.getByRole('button', { name: '保存云端密钥' }));
  await waitFor(() => expect(host.setApiKey).toHaveBeenLastCalledWith({ key: 'synthetic-second-replacement', expectedRevision: revision }));
});
it('checks uncertain results without retrying the secret and keeps editing blocked if the read also fails', async () => {
  const host = setup(); await ready();
  host.setApiKey.mockRejectedValue(Error('synthetic secret-bearing transport error'));
  host.retryApiKey.mockRejectedValue(Error('offline'));
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-uncertain-key' } });
  fireEvent.click(screen.getByRole('button', { name: '保存云端密钥' }));
  await screen.findByText('本次保存结果尚未确认，未自动重发。请重新读取云端配置。');
  await waitFor(() => expect(host.retryApiKey).toHaveBeenCalledTimes(2));
  expect(host.setApiKey).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText(/secret-bearing/)).toBeNull();
  expect((screen.getByRole('button', { name: '保存云端密钥' }) as HTMLButtonElement).disabled).toBe(true);
});
it('confirms shared deletion and submits null with the observed revision', async () => {
  const host = setup(changed); await ready();
  host.setApiKey.mockResolvedValue(ok({ ...initial, revision }));
  fireEvent.click(screen.getByRole('button', { name: '清除云端密钥' }));
  expect(host.setApiKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认清除两端共用密钥' }));
  await screen.findByText('云端密钥已清除，手机和电脑的生活助手将共同停用这份密钥。');
  expect(host.setApiKey).toHaveBeenCalledExactlyOnceWith({ key: null, expectedRevision: revision });
});
it('disables edits for externally managed configuration', async () => {
  const host = setup({ ...changed, editable: false, source: 'external', revision: null }); await ready();
  expect((screen.getByLabelText('API Key') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '保存云端密钥' }) as HTMLButtonElement).disabled).toBe(true);
  expect(host.setApiKey).not.toHaveBeenCalled();
});
