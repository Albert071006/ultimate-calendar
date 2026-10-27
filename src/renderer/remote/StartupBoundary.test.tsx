// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StartupBoundary } from './StartupBoundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('mobile startup recovery', () => {
  it('renders the ordinary application without a recovery warning', () => {
    render(<StartupBoundary><h1>今天的合成日历</h1></StartupBoundary>);
    expect(screen.getByRole('heading', { name: '今天的合成日历' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a same-origin recovery link after a render failure without exposing the exception or deleting storage', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    const privateMessage = 'Synthetic private failure with a credential-like value';
    function Broken(): never { throw Error(privateMessage); }
    render(<StartupBoundary><Broken /></StartupBoundary>);
    const fallback = screen.getByRole('alert');
    expect(fallback.textContent).toContain('UC-RENDER-01');
    expect(fallback.textContent).toContain('不会清除配对、日历或待提交修改');
    expect(fallback.textContent).not.toContain(privateMessage);
    expect(screen.getByRole('link', { name: '重新载入日历' }).getAttribute('href')).toBe('/?recovery=render');
    expect(remove).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  });

  it('ships a readable static fallback even when the application script never executes', () => {
    const html = readFileSync(resolve('index.html'), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const root = document.getElementById('root');
    expect(root?.textContent).toContain('正在打开日历');
    expect(root?.textContent).toContain('UC-START-01');
    expect(root?.querySelector('a')?.getAttribute('href')).toBe('/?recovery=startup');
    expect(root?.textContent).toContain('不会清除配对、日历或待提交修改');
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'self';");
    expect(document.querySelectorAll('script:not([src])')).toHaveLength(0);
  });
});
