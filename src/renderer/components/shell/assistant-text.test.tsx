// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AssistantText, friendlyReplyText } from './AssistantText';
import { appliedAssistantReply } from './assistant-conversation';

afterEach(cleanup);

describe('assistant reply presentation', () => {
  it('shows one receipt while keeping the specific action result', () => {
    expect(appliedAssistantReply('已保存，可撤销', '已保存，可撤销\n已新增日历安排：合成练习')).toBe('已保存，可撤销\n已新增日历安排：合成练习');
    expect(appliedAssistantReply('已保存，可撤销', '已新增日历安排：合成练习')).toBe('已保存，可撤销\n已新增日历安排：合成练习');
    expect(appliedAssistantReply('已保存，可撤销', '已保存，可撤销')).toBe('已保存，可撤销');
  });

  it('renders readable lists, emphasis and dates without changing code or linked URLs', () => {
    render(<AssistantText text={'**本周待办**\n- 2026-11-15 10:00–12:00 阅读\n- 完成 *合成练习*\n\n1. 先查资料\n2. 再填写\n\n`2026-11-15`\n[资料](https://example.test/2026-11-15)'} />);
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('本周待办').tagName).toBe('STRONG');
    expect(screen.getByText('合成练习').tagName).toBe('EM');
    expect(screen.getByText('周日 11月15日 10:00–12:00 阅读')).toBeTruthy();
    expect(screen.getByText('2026-11-15').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: '资料' }).getAttribute('href')).toBe('https://example.test/2026-11-15');
  });

  it('does not execute HTML, render remote images or make unsafe URLs clickable', () => {
    const { container } = render(<AssistantText text={'<img src=x onerror=alert(1)>\n[危险](javascript:alert)\n![远程图片](https://example.test/pixel.png)\n```html\n<script>alert(1)</script>\n2026-11-15\n```'} />);
    expect(container.querySelector('img,script')).toBeNull();
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('<script>alert(1)</script>\n2026-11-15');
  });

  it('formats legacy server replies while retaining invalid dates and unknown money values', () => {
    expect(friendlyReplyText('支付宝：账面余额 未知\n2026-11-15T02:00:00Z\n2026-02-30\n个人开销 未知')).toBe('支付宝：余额未设置\n周日 11月15日 10:00\n2026-02-30\n个人开销 未知');
    expect(friendlyReplyText('2026-11-15T10:00')).toBe('周日 11月15日 10:00');
    expect(friendlyReplyText('2026-11 个人开销 ¥23.50，2026-13 待核对，2026-02-30 待核对')).toBe('2026年11月 个人开销 ¥23.50，2026-13 待核对，2026-02-30 待核对');
  });
});
