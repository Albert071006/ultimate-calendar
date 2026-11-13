// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CalendarItemSchema, type ApiResult, type CommandRequest, type CommandResult } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import { Assistant } from './Assistant';
import { MobileAssistant } from '../../mobile/MobileAssistant';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const items = Array.from({ length: 14 }, (_, index) => CalendarItemSchema.parse({
  id: `synthetic-item-${index}`, refId: `synthetic-block-${index}`, refKind: 'block', title: `合成日程 ${index + 1}`,
  date: '2030-04-15', start: `2030-04-15T09:00:00+08:00`, end: `2030-04-15T10:00:00+08:00`, busy: true, pending: false, category: 'event',
}));

function fixture(surface: 'desktop' | 'phone') {
  const command = vi.fn(async (_request: CommandRequest): Promise<ApiResult<CommandResult>> => ({ ok: true, data: { reply: '合成回答', items: [], mutationResult: null } }));
  const ui = { client: { command }, busy: false, error: '', receive: vi.fn(), run: async <T,>(job: () => Promise<ApiResult<T>>) => { const result = await job(); return result.ok ? result.data : undefined; } } as unknown as PlannerUI;
  function Phone() {
    const [open, setOpen] = useState(true);
    return <MobileAssistant ui={ui} selected={null} date="2030-04-15" open={open} setOpen={setOpen} />;
  }
  const view = render(surface === 'desktop' ? <Assistant ui={ui} selected={null} date="2030-04-15" />
    : <Phone />);
  if (surface === 'desktop') fireEvent.click(screen.getByRole('button', { name: '展开对话' }));
  const thread = view.container.querySelector<HTMLElement>(surface === 'desktop' ? '.conversation' : '.m-assistant-thread')!;
  const input = screen.getByLabelText(surface === 'desktop' ? '自然语言指令' : '对生活助手说');
  const send = (text: string) => { fireEvent.change(input, { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: surface === 'desktop' ? '发送指令' : '发送' })); };
  return { ...view, command, thread, send };
}

describe.each(['desktop', 'phone'] as const)('%s assistant answers', surface => {
  it('keeps supplementary schedules collapsed and separate from the answer while preserving later references', async () => {
    const view = fixture(surface);
    view.command.mockResolvedValueOnce({ ok: true, data: { reply: '本周还有两项合成任务未完成。', items, mutationResult: null } });
    view.send('这周还有什么没做');
    await screen.findByText('本周还有两项合成任务未完成。');
    const details = view.thread.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(view.thread.querySelector('.assistant-text')?.textContent).toBe('本周还有两项合成任务未完成。');
    expect(details.querySelectorAll('li')).toHaveLength(14);
    fireEvent.click(screen.getByText('相关日程 · 14 项'));
    expect(details.open).toBe(true);
    expect(screen.getByText('合成日程 14')).toBeTruthy();
    view.send('第二个安排在哪里');
    await waitFor(() => expect(view.command).toHaveBeenCalledTimes(2));
    const context = view.command.mock.calls[1]![0].history?.at(-1)?.text;
    expect(context).toContain('本周还有两项合成任务未完成。\n所查日期范围的日程（不代表未完成事项）：');
    expect(context).toContain('合成日程 2');
    expect(context).toContain('合成日程 14');
  });

  it('shows calendar-only results immediately when the answer has no text', async () => {
    const view = fixture(surface);
    view.command.mockResolvedValueOnce({ ok: true, data: { reply: '', items, mutationResult: null } });
    view.send('列出本周所有日程');
    await screen.findByText('相关日程 · 14 项');
    expect(view.thread.querySelector('details')?.open).toBe(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
    view.send('第二个安排在哪里');
    await waitFor(() => expect(view.command).toHaveBeenCalledTimes(2));
    expect(view.command.mock.calls[1]![0].history?.at(-1)?.text).toContain('合成日程 2');
    expect(view.command.mock.calls[1]![0].history?.at(-1)?.text).toContain('合成日程 14');
  });

  it.each([false, true])('starts a long reply at the top and preserves older reading (reading=%s)', async reading => {
    const view = fixture(surface);
    let finish!: (response: ApiResult<CommandResult>) => void;
    view.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.send('解释合成任务');
    await waitFor(() => expect(view.command).toHaveBeenCalledTimes(1));
    Object.defineProperties(view.thread, { scrollHeight: { configurable: true, value: 1400 }, clientHeight: { configurable: true, value: 300 } });
    vi.spyOn(view.thread, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: 100, height: 300 }));
    const message = view.thread.querySelector<HTMLElement>('[data-assistant-entry]')!;
    vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: 100 + 600 - view.thread.scrollTop, height: 700 }));
    view.thread.scrollTop = reading ? 125 : 1100; fireEvent.scroll(view.thread);
    await act(async () => finish({ ok: true, data: { reply: '合成说明\n'.repeat(30), items: [], mutationResult: null } }));
    expect(view.thread.scrollTop).toBe(reading ? 125 : 600);
  });

  it('starts a long reply from its beginning when it arrives while the panel is closed', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.conversation, .m-assistant-thread')) return DOMRect.fromRect({ y: 100, height: 300 });
      if (this.hasAttribute('data-assistant-entry')) return DOMRect.fromRect({
        y: 100 + 600 - (this.parentElement?.scrollTop ?? 0), height: this.getAttribute('aria-busy') === 'true' ? 40 : 700,
      });
      return DOMRect.fromRect({});
    });
    const view = fixture(surface);
    let finish!: (response: ApiResult<CommandResult>) => void;
    view.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.send('解释合成任务');
    await waitFor(() => expect(view.command).toHaveBeenCalledTimes(1));
    view.thread.scrollTop = 1100; fireEvent.scroll(view.thread);
    fireEvent.click(screen.getByRole('button', { name: surface === 'desktop' ? '收起对话' : '关闭生活助手' }));
    await act(async () => finish({ ok: true, data: { reply: '关闭期间收到的合成长回复\n'.repeat(30), items: [], mutationResult: null } }));
    fireEvent.click(screen.getByRole('button', { name: surface === 'desktop' ? '展开对话' : '问问生活助手' }));
    const reopened = view.container.querySelector<HTMLElement>(surface === 'desktop' ? '.conversation' : '.m-assistant-thread')!;
    expect(reopened.scrollTop).toBe(600);
  });
});
