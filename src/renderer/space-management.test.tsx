// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HostCapabilities } from '../shared/client';
import { SpacePolicySchema, type SpaceSnapshot } from '../shared/space';
import { SpaceManagement } from './components/SpaceManagement';

afterEach(cleanup);
const MiB = 1024 * 1024;
function setup(value: Partial<SpaceSnapshot> = {}) {
  let snapshot: SpaceSnapshot = {
    policy: SpacePolicySchema.parse({}), backupDirectory: 'C:\\Synthetic\\Documents\\终极日历\\备份', databaseBytes: 180 * MiB, reusableBytes: 4 * MiB, cacheBytes: 3 * MiB,
    backupBytes: 600 * MiB, managedBackupBytes: 400 * MiB, unmanagedBackupBytes: 200 * MiB,
    backupCount: 6, removableBackupCount: 2, removableBackupBytes: 100 * MiB,
    attachments: { totalBytes: 160 * MiB, eligibleBytes: 100 * MiB, protectedBytes: 60 * MiB, reclaimableBytes: 80 * MiB, remainingBytes: 80 * MiB,
      selectedAttachments: 4, protectedAttachments: 2, overBudgetBytes: 0 },
    lastRunAt: null, lastResult: null, warnings: [], ...value,
  };
  const api = {
    spaceSnapshot: vi.fn(async () => ({ ok: true as const, data: snapshot })),
    spaceConfigure: vi.fn(async (policy: SpaceSnapshot['policy']) => {
      snapshot = { ...snapshot, policy }; return { ok: true as const, data: snapshot };
    }),
    spaceCleanup: vi.fn(async (_request: { clearCache: boolean }) => ({ ok: true as const, data: { ...snapshot, lastResult: '已清理 2 份备份、4 个附件。' } })),
  };
  return { api, host: api as unknown as HostCapabilities };
}

describe('space management', () => {
  it('does not call absent host methods or load hidden settings', () => {
    const { rerender, container } = render(<SpaceManagement host={{} as HostCapabilities} />);
    expect(container.textContent).toBe('');
    const { api, host } = setup();
    rerender(<SpaceManagement host={host} active={false} />);
    expect(api.spaceSnapshot).not.toHaveBeenCalled();
  });

  it('saves rules separately without submitting the surrounding settings form or running cleanup', async () => {
    const { api, host } = setup(); const submit = vi.fn(event => event.preventDefault());
    const { container } = render(<form onSubmit={submit}><SpaceManagement host={host} /></form>);
    await screen.findByText('180.0 MB');
    fireEvent.change(screen.getByRole('spinbutton', { name: '已处理附件保留' }), { target: { value: '60' } });
    expect((screen.getByRole('button', { name: '预览清理' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存清理规则' }));
    await screen.findByText('清理规则已保存。');
    expect(api.spaceConfigure).toHaveBeenCalledWith({ ...SpacePolicySchema.parse({}), attachmentDays: 60 });
    expect(api.spaceCleanup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect((screen.getByRole('button', { name: '预览清理' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('refreshes the cleanup preview and requires an explicit confirmation, with cache opt-in', async () => {
    const { api, host } = setup({ warnings: ['仍需保留的附件超过容量目标。'] });
    render(<SpaceManagement host={host} />);
    await screen.findByText('180.0 MB');
    expect(screen.getByText('仍需保留的附件超过容量目标。')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('本次同时清理界面缓存'));
    fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    const confirmation = await screen.findByRole('region', { name: '确认空间清理' });
    expect(api.spaceSnapshot).toHaveBeenCalledTimes(2);
    expect(api.spaceCleanup).not.toHaveBeenCalled();
    expect(confirmation.textContent).toContain('2 份旧备份和 4 个已处理附件');
    expect(confirmation.textContent).toContain('180.0 MB');
    expect(confirmation.textContent).toContain('另清理 3.0 MB 界面缓存');
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认清理' }));
    await screen.findByText('空间清理已完成。');
    expect(api.spaceCleanup).toHaveBeenCalledWith({ clearCache: true });
    expect(screen.queryByRole('region', { name: '确认空间清理' })).toBeNull();
    expect(screen.getByText('已清理 2 份备份、4 个附件。')).toBeTruthy();
  });

  it('keeps failed cleanup visible and never reports it as completed', async () => {
    const { api, host } = setup();
    api.spaceCleanup.mockRejectedValueOnce(new Error('disk unavailable'));
    render(<SpaceManagement host={host} />);
    await screen.findByText('180.0 MB');
    fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清理' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('空间清理已完成。')).toBeNull();
    expect(screen.getByRole('region', { name: '确认空间清理' })).toBeTruthy();
  });

  it('rejects invalid retention values before saving', async () => {
    const { api, host } = setup();
    render(<SpaceManagement host={host} />);
    await screen.findByText('180.0 MB');
    fireEvent.change(screen.getByRole('spinbutton', { name: '自动备份保留' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存清理规则' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('标注范围'));
    expect(api.spaceConfigure).not.toHaveBeenCalled();
  });
});
