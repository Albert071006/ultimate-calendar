// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ApiResult, CommandResult } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import { Assistant } from './Assistant';
import { ASSISTANT_HEIGHT_KEY } from './assistant-panel-size';
const shellCss = readFileSync('src/renderer/components/shell/shell.css', 'utf8');

let anchor = 700;
beforeEach(() => {
  anchor = 700; vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect(this.classList.contains('a2-assist') ? { x: 20, y: anchor, width: 1000, height: 44 } : {});
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.querySelectorAll('style[data-panel-test]').forEach(style => style.remove()); });
function fixture() {
  const command = vi.fn(async (): Promise<ApiResult<CommandResult>> => ({ ok: true, data: { reply: '合成回复', items: [], mutationResult: null } }));
  const ui = { client: { command }, busy: false, error: '', receive: vi.fn(), run: async <T,>(job: () => Promise<ApiResult<T>>) => { const result = await job(); return result.ok ? result.data : undefined; } } as unknown as PlannerUI;
  const wheel = vi.fn();
  const view = render(<div onWheel={wheel}><Assistant ui={ui} selected={null} date="2030-04-15" /></div>);
  fireEvent.click(screen.getByRole('button', { name: '展开对话' }));
  return { command, wheel, ...view };
}
const handle = () => screen.getByRole('separator', { name: '调整聊天框高度' });
const panelHeight = () => Number(handle().getAttribute('aria-valuenow'));

describe('desktop assistant panel', () => {
  it('allows native wheel scrolling in a constrained thread rather than the page, overriding the old 200px limit', () => {
    const style = document.createElement('style'); style.dataset.panelTest = ''; style.textContent = '.conversation { max-height:200px; margin-bottom:10px; }' + shellCss; document.head.append(style);
    const { wheel } = fixture(), thread = screen.getByRole('log', { name: '生活助手聊天记录' });
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    thread.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(wheel).not.toHaveBeenCalled();
    const layout = getComputedStyle(thread);
    expect(layout.maxHeight).toBe('none'); expect(parseFloat(layout.minHeight)).toBe(0); expect(layout.overflow).toBe('auto'); expect(layout.flexGrow).toBe('1');
    expect(thread.tabIndex).toBe(0);
  });

  it('drags and persists height without remounting history or losing an unsent draft or reading position', async () => {
    const { command } = fixture();
    let reply!: (value: ApiResult<CommandResult>) => void;
    command.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const input = screen.getByLabelText('自然语言指令') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '解释合成资料' } }); fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const thread = screen.getByRole('log'); Object.defineProperties(thread, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 300 } });
    thread.scrollTop = 125; fireEvent.scroll(thread);
    await act(async () => reply({ ok: true, data: { reply: '较长的合成回复', items: [], mutationResult: null } }));
    expect(thread.scrollTop).toBe(125);
    fireEvent.change(input, { target: { value: '未发送的草稿' } });
    const before = panelHeight();
    fireEvent.pointerDown(handle(), { pointerId: 7, pointerType: 'mouse', button: 0, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 180 }); fireEvent.pointerUp(window, { pointerId: 7 });
    expect(panelHeight()).toBe(before + 120); expect(localStorage.getItem(ASSISTANT_HEIGHT_KEY)).toBe(String(before + 120));
    expect(screen.getByRole('log')).toBe(thread); expect(thread.scrollTop).toBe(125); expect(input.value).toBe('未发送的草稿');
    expect(screen.getByText('较长的合成回复')).toBeTruthy(); expect(command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '收起对话' })); fireEvent.click(screen.getByRole('button', { name: '展开对话' }));
    expect(panelHeight()).toBe(before + 120); expect(input.value).toBe('未发送的草稿'); expect(screen.getByRole('log').scrollTop).toBe(125);
  });

  it('bounds keyboard and pointer resizing to available space and follows window shrink without overwriting the preferred height', () => {
    fixture();
    fireEvent.keyDown(handle(), { key: 'Home' }); expect(panelHeight()).toBe(180);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' }); expect(panelHeight()).toBe(212);
    fireEvent.keyDown(handle(), { key: 'End' }); expect(panelHeight()).toBe(644);
    fireEvent.pointerDown(handle(), { pointerId: 9, pointerType: 'mouse', button: 0, clientY: 200 }); fireEvent.pointerMove(window, { pointerId: 9, clientY: -1000 }); fireEvent.pointerUp(window, { pointerId: 9 });
    expect(panelHeight()).toBe(644);
    anchor = 300; vi.stubGlobal('innerHeight', 350); fireEvent(window, new Event('resize'));
    expect(panelHeight()).toBe(222); expect(localStorage.getItem(ASSISTANT_HEIGHT_KEY)).toBe('644');
    anchor = 700; vi.stubGlobal('innerHeight', 800); fireEvent(window, new Event('resize')); expect(panelHeight()).toBe(644);
  });
});
