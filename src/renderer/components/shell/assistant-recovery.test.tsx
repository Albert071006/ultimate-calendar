// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SnapshotSchema, type ApiResult, type CommandRequest, type CommandResult } from '../../../shared/contracts';
import type { PlannerClient } from '../../../shared/client';
import { usePlanner } from '../../hooks/usePlanner';
import { MobileAssistant } from '../../mobile/MobileAssistant';
import { canContinueUnsent, type ConversationEntry } from './assistant-conversation';

afterEach(() => { cleanup(); localStorage.clear(); });
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
  courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: true, sessionOnly: false } });
const clarification: ApiResult<CommandResult> = { ok: true, data: { reply: '是另一次集合吗？', items: [], mutationResult: null,
  conversationState: { domain: 'calendar', phase: 'clarification' } } };
const success: ApiResult<CommandResult> = { ok: true, data: { reply: '已处理这次请求。', items: [], mutationResult: null,
  conversationState: { domain: 'calendar', phase: 'saved' } } };
const notSent: ApiResult<CommandResult> = { ok: false, error: { code: 'NETWORK', message: '连接资料服务失败，这条指令尚未发送。', retryable: true, delivery: 'not-sent' } };
const unknown: ApiResult<CommandResult> = { ok: false, error: { code: 'NETWORK', message: '原请求结果尚未确认。', retryable: true, delivery: 'unknown' } };

function fixture() {
  const command = vi.fn<(request: CommandRequest) => Promise<ApiResult<CommandResult>>>(async () => success);
  const read = vi.fn(async (): Promise<ApiResult<typeof snapshot>> => ({ ok: true, data: snapshot }));
  const api = { command, snapshot: read, onChanged: () => () => {} } as unknown as PlannerClient;
  return { command, read, api };
}
function Phone({ api, storageKey, connectionStatus }: { api: PlannerClient; storageKey?: string; connectionStatus?: 'online' | 'offline' | 'connecting' }) {
  const ui = usePlanner(api);
  return <MobileAssistant ui={ui} selected={null} date="2026-10-27" open setOpen={vi.fn()} storageKey={storageKey} connectionStatus={connectionStatus} />;
}
const input = () => screen.getByLabelText('对生活助手说') as HTMLTextAreaElement;
async function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(screen.queryAllByText('正在处理…')).toHaveLength(0));
}
async function askAndFail(command: ReturnType<typeof fixture>['command'], failure = notSent) {
  command.mockResolvedValueOnce(clarification).mockResolvedValueOnce(failure);
  await send('明天中午12:00-13:45到滋兰苑集合');
  await send('28号中午');
}

describe('assistant connection failures and visible continuation', () => {
  it('shows the actual pre-send failure and restores the clarification as an editable draft', async () => {
    const { api, command } = fixture(); render(<Phone api={api} />);
    await askAndFail(command);
    expect(screen.getAllByText(notSent.ok ? '' : notSent.error.message).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('未收到处理结果，可以重试这条指令。')).toBeNull();
    expect(input().value).toBe('28号中午');
    expect(screen.getByText('这条补充尚未发送，可在输入框继续补充后发送。')).toBeTruthy();
    await send(`${input().value}，新的一场`);
    const request = command.mock.calls[2]![0];
    expect(request.text).toBe('28号中午，新的一场');
    expect(request.history!.map(entry => entry.text)).toEqual(['明天中午12:00-13:45到滋兰苑集合', '是另一次集合吗？']);
    expect(screen.queryByRole('button', { name: '重试这条指令' })).toBeNull();
    expect(input().value).toBe('');
  });

  it('allows replacing the visible draft with a new topic without merging the failed instruction', async () => {
    const { api, command } = fixture(); render(<Phone api={api} />);
    await askAndFail(command);
    await send('今天是星期几');
    expect(command.mock.calls[2]![0].text).toBe('今天是星期几');
    expect(JSON.stringify(command.mock.calls[2]![0])).not.toContain('28号中午');
  });

  it('does not carry an independent failed write into the next request', async () => {
    const { api, command } = fixture(); command.mockResolvedValueOnce(notSent); render(<Phone api={api} />);
    await send('记午饭20元');
    expect(input().value).toBe('');
    expect(screen.queryByRole('button', { name: '继续补充' })).toBeNull();
    await send('今天是星期几');
    expect(command.mock.calls[1]![0].history).toEqual([]);
  });

  it('does not reopen an old unsent clarification after the conversation has moved to a new topic', async () => {
    const { api, command } = fixture(); render(<Phone api={api} />);
    await askAndFail(command);
    fireEvent.change(input(), { target: { value: '' } });
    command.mockResolvedValueOnce(clarification);
    await send('另一个问题：我应该在哪里集合？');
    expect(screen.queryByRole('button', { name: '继续补充' })).toBeNull();
    await send('图书馆');
    expect(command.mock.calls[3]![0].text).toBe('图书馆');
    expect(JSON.stringify(command.mock.calls[3]![0])).not.toContain('28号中午');
  });

  it('keeps unknown results out of the editor and uses the exact original request for explicit retry', async () => {
    const { api, command } = fixture(); render(<Phone api={api} />);
    await askAndFail(command, unknown);
    expect(screen.getByText(/结果待核对 · 原请求结果尚未确认/)).toBeTruthy();
    expect(input().value).toBe('');
    expect(screen.queryByRole('button', { name: '继续补充' })).toBeNull();
    const original = command.mock.calls[1]![0];
    fireEvent.click(screen.getByRole('button', { name: '重试这条指令' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(command.mock.calls[2]![0]).toEqual(original);
  });

  it('does not overwrite text typed while a request is in progress', async () => {
    const { api, command } = fixture(); command.mockResolvedValueOnce(clarification); render(<Phone api={api} />);
    await send('明天到滋兰苑集合');
    let resolve!: (result: ApiResult<CommandResult>) => void;
    command.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.change(input(), { target: { value: '28号中午' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.change(input(), { target: { value: '我准备另问一个问题' } });
    await act(async () => resolve(notSent));
    expect(input().value).toBe('我准备另问一个问题');
    fireEvent.click(screen.getByRole('button', { name: '继续补充' }));
    expect(input().value).toBe('28号中午');
  });

  it('persists only the visible text draft across a phone reopen, without an operation or replay request', async () => {
    const { api, command } = fixture(); const storageKey = 'synthetic-assistant-continuation';
    const first = render(<Phone api={api} storageKey={storageKey} />);
    await askAndFail(command);
    const stored = localStorage.getItem(storageKey)!;
    expect(JSON.parse(stored).draft.text).toBe('28号中午');
    expect(stored).not.toContain('operationId');
    expect(stored).not.toContain('base64');
    first.unmount();
    render(<Phone api={api} storageKey={storageKey} />);
    expect(input().value).toBe('28号中午');
    expect(screen.queryByRole('button', { name: '重试这条指令' })).toBeNull();
    await send(`${input().value}，新的一场`);
    expect(command.mock.calls[2]![0].text).toBe('28号中午，新的一场');
  });

  it('does not offer a text-only continuation for failed pictures, resources, or unprepared local paths', () => {
    const base: ConversationEntry = { id: 'reply', role: 'assistant', text: '未发送', status: 'failed', delivery: 'not-sent',
      request: { operationId: 'op', text: '28号中午', history: [{ role: 'assistant', text: '哪一天？', outcome: { domain: 'calendar', phase: 'clarification' } }] } };
    expect(canContinueUnsent(base)).toBe(true);
    expect(canContinueUnsent({ ...base, request: { ...base.request!, image: { label: '合成.png', imageDataUrl: 'data:image/png;base64,AAAA' } } })).toBe(false);
    expect(canContinueUnsent({ ...base, request: { ...base.request!, resources: [{ id: 'r', kind: 'web', name: '合成', url: 'https://example.invalid/' }] } })).toBe(false);
    expect(canContinueUnsent({ ...base, request: { ...base.request!, text: '关联 "D:\\合成.pdf"' } })).toBe(false);
  });

  it.each(['throw', 'error'] as const)('keeps a confirmed reply when the following snapshot fails (%s)', async mode => {
    const { api, command, read } = fixture(); render(<Phone api={api} />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (mode === 'throw') read.mockRejectedValueOnce(new Error('合成刷新断连'));
    else read.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成刷新断连', retryable: true } });
    await send('新增合成安排');
    expect(screen.getByText('已处理这次请求。')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('已收到处理结果，但最新资料刷新失败');
    expect(screen.queryByRole('button', { name: '重试这条指令' })).toBeNull();
    expect(command).toHaveBeenCalledOnce();
  });

  it('shows the real connection state inside the full-screen phone assistant', () => {
    const { api } = fixture(); const view = render(<Phone api={api} connectionStatus="offline" />);
    expect(screen.getByText('连接中断，发送前会尝试重新连接')).toBeTruthy();
    view.rerender(<Phone api={api} connectionStatus="connecting" />);
    expect(screen.getByText('正在连接资料服务…')).toBeTruthy();
    view.rerender(<Phone api={api} connectionStatus="online" />);
    expect(screen.queryByText('正在连接资料服务…')).toBeNull();
  });
});
