// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SnapshotSchema, type ApiResult, type DesktopAPI, type JournalSummary, type MutationResult } from '../shared/contracts';
import { App } from './App';

afterEach(cleanup);

const journalEntry: JournalSummary = {
  id: 'transaction-1', operationId: 'operation-1', createdAt: '2026-10-23T09:00:00+08:00',
  origin: 'manual', message: '已保存，可撤销', changes: [], undoneAt: null, undoable: true,
};
const applied = (message: string): ApiResult<MutationResult> => ({
  ok: true, data: { status: 'applied', message, changes: [], conflicts: [], transactionId: 'transaction-1' },
});

function fixture(journal: JournalSummary[] = []) {
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal, tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
  const api = {
    snapshot: vi.fn(async () => ({ ok: true, data: structuredClone(snapshot) })),
    onChanged: () => () => {}, onNavigate: () => () => {},
    mutate: vi.fn(async () => {
      snapshot.journal.push({ ...journalEntry });
      return applied('已保存，可撤销');
    }),
    undo: vi.fn(async () => applied('已撤销')),
    command: vi.fn(),
  } as unknown as DesktopAPI;
  return { api, snapshot };
}

it('puts saved feedback beside the page title without adding a separate status row', async () => {
  const { api } = fixture();
  const { container } = render(<App api={api} />);
  fireEvent.click(within(await screen.findByRole('navigation', { name: '主导航' })).getByRole('button', { name: '今天' }));
  fireEvent.click(within(await waitFor(() => container.querySelector<HTMLElement>('.a2-toolbar')!)).getByRole('button', { name: '新任务' }));
  const form = within(screen.getByRole('dialog', { name: '新建任务' }));
  fireEvent.change(form.getByLabelText('名称'), { target: { value: '合成反馈测试' } });
  fireEvent.click(form.getByRole('button', { name: '保存' }));
  const notice = await screen.findByRole('status');
  await waitFor(() => expect(notice.textContent).toBe('已保存，可撤销'));
  const header = container.querySelector<HTMLElement>('.a2-toolbar')!;
  const title = within(header).getByRole('heading', { level: 1 });
  expect(notice.parentElement).toBe(title.parentElement);
  expect(within(header).getByRole('status')).toBe(notice);
  expect(notice.getAttribute('title')).toBe('已保存，可撤销');
  expect(container.querySelector('.workspace-status')).toBeNull();
  expect((screen.getByRole('button', { name: '撤销上次操作' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '日历' }));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect((screen.getByRole('button', { name: '撤销上次操作' }) as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  ['no history', [], true],
  ['non-undoable history', [{ ...journalEntry, undoable: false }], true],
  ['already undone history', [{ ...journalEntry, undoneAt: '2026-10-23T09:05:00+08:00' }], true],
  ['available history', [{ ...journalEntry }], false],
] as const)('shows one labeled header undo button for %s', async (_label, journal, disabled) => {
  const { api } = fixture([...journal]);
  const { container } = render(<App api={api} />);
  const button = await screen.findByRole('button', { name: '撤销上次操作' });
  expect(button.getAttribute('title')).toBe('撤销上次操作');
  expect(screen.getAllByRole('button', { name: /撤销/ })).toHaveLength(1);
  expect(within(container.querySelector<HTMLElement>('.a2-toolbar')!).getByRole('button', { name: '撤销上次操作' })).toBe(button);
  expect(within(screen.getByRole('region', { name: '生活助手' })).queryByRole('button', { name: /撤销/ })).toBeNull();
  expect((button as HTMLButtonElement).disabled).toBe(disabled);
  expect(container.querySelector('.workspace-status')).toBeNull();
  if (disabled) {
    fireEvent.click(button);
    expect(api.undo).not.toHaveBeenCalled();
  }
});

it('invokes undo from the header, disables repeat clicks while busy, and refreshes availability', async () => {
  const { api, snapshot } = fixture([{ ...journalEntry }]);
  let finish!: (value: ApiResult<MutationResult>) => void;
  vi.mocked(api.undo).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(<App api={api} />);
  const button = await screen.findByRole('button', { name: '撤销上次操作' });
  fireEvent.click(button);
  expect(api.undo).toHaveBeenCalledTimes(1);
  expect(api.undo).toHaveBeenCalledWith(undefined);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(within(container.querySelector<HTMLElement>('.a2-toolbar')!).getByRole('status').textContent).toBe('正在处理…');
  expect(container.querySelector('.workspace-status')).toBeNull();
  fireEvent.click(button);
  expect(api.undo).toHaveBeenCalledTimes(1);
  snapshot.journal[0]!.undoneAt = '2026-10-23T09:05:00+08:00';
  finish(applied('已撤销'));
  await screen.findByText('已撤销');
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(api.snapshot).toHaveBeenCalledTimes(2);
});

it('keeps actionable errors visible and removes their row after dismissal', async () => {
  const { api } = fixture();
  vi.mocked(api.command).mockResolvedValue({
    ok: false, error: { code: 'NO_API_KEY', message: '请先配置密钥', retryable: false },
  });
  const { container } = render(<App api={api} />);
  fireEvent.change(await screen.findByLabelText('自然语言指令'), { target: { value: '安排明天的学习' } });
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByRole('button', { name: '配置密钥' })).toBeTruthy();
  expect(alert.textContent).toContain('请先配置密钥');
  fireEvent.click(within(alert).getByRole('button', { name: '关闭提示' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(container.querySelector('.workspace-status')).toBeNull();
});
