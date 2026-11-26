// @vitest-environment happy-dom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Toast, type ToastNotice } from './Toast';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function Receipt({ initial }: { initial: ToastNotice }) {
  const [notice, setNotice] = useState<ToastNotice | null>(initial);
  return <>
    <button onClick={() => setNotice({ ...initial })}>再次保存</button>
    <Toast notice={notice} dismiss={() => setNotice(null)} />
  </>;
}

it('restarts the four seconds for an identical new receipt and fades out the single pill', () => {
  render(<Receipt initial={{ text: '已保存示例' }} />);
  tick(3500);
  fireEvent.click(screen.getByRole('button', { name: '再次保存' }));
  tick(3500);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').classList.contains('fading')).toBe(false);
  tick(350);
  expect(screen.getByRole('status').classList.contains('fading')).toBe(true);
  tick(150);
  expect(screen.queryByRole('status')).toBeNull();
});

it('resumes the remaining time only after both hover and keyboard focus leave', () => {
  render(<Receipt initial={{ text: '已保存，可撤销', undo: vi.fn() }} />);
  const status = screen.getByRole('status');
  tick(1250);
  fireEvent.pointerEnter(status, { pointerType: 'mouse' });
  tick(5000);
  act(() => within(status).getByRole('button', { name: '撤销' }).focus());
  fireEvent.pointerLeave(status, { pointerType: 'mouse' });
  tick(5000);
  expect(screen.getByRole('status')).toBe(status);
  act(() => screen.getByRole('button', { name: '再次保存' }).focus());
  tick(2749);
  expect(screen.getByRole('status')).toBe(status);
  tick(1);
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps keyboard focus in place on arrival and invokes only the replacement undo action', () => {
  const dismiss = vi.fn(), plannerUndo = vi.fn(), ledgerUndo = vi.fn();
  const view = (notice: ToastNotice | null) => <><input aria-label="示例输入" /><Toast notice={notice} dismiss={dismiss} /></>;
  const { rerender } = render(view(null));
  const input = screen.getByRole('textbox');
  input.focus();
  rerender(view({ text: '已保存示例日程，可撤销。', undo: plannerUndo }));
  rerender(view({ text: '已保存示例账单，可撤销', undo: ledgerUndo }));
  expect(document.activeElement).toBe(input);
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('已保存示例账单撤销');
  fireEvent.click(within(status).getByRole('button', { name: '撤销' }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(ledgerUndo).toHaveBeenCalledOnce();
  expect(plannerUndo).not.toHaveBeenCalled();
});

it('lets a touch receipt expire without waiting for a mouse leave', () => {
  render(<Receipt initial={{ text: '已导出示例账单' }} />);
  const status = screen.getByRole('status');
  expect(within(status).queryByRole('button')).toBeNull();
  fireEvent.pointerEnter(status, { pointerType: 'touch' });
  tick(4000);
  expect(screen.queryByRole('status')).toBeNull();
});
