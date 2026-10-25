import { describe, expect, it, vi } from 'vitest';
import type { HostCapabilities } from '../shared/client';
import type { ResourceReference } from '../shared/resources';
import { openCommandResources, prepareResourceCommand, redactResourcePaths } from './resource-command';

const file: ResourceReference = { id: 'file-a', kind: 'file', name: '练习.pdf', deviceId: 'pc-a', deviceName: '学习电脑' };
const hostWith = (methods: Partial<HostCapabilities>) => methods as HostCapabilities;

describe('resource commands at the local boundary', () => {
  it('registers explicitly provided files locally and removes paths from model text and history', async () => {
    const register = vi.fn(async () => ({ ok: true as const, data: [file] }));
    const text = '把 "D:\\Private notes\\练习.pdf" 关联到周六练习';
    const request = await prepareResourceCommand(text, [], hostWith({ resourceRegister: register }));
    expect(register).toHaveBeenCalledWith({ paths: ['D:\\Private notes\\练习.pdf'] });
    expect(request.text).toBe('把 已选资料「练习.pdf」（file-a） 关联到周六练习');
    expect(JSON.stringify(request)).not.toContain('Private notes');
    expect(redactResourcePaths(text)).toBe('把 [本机资源位置] 关联到周六练习');
  });
  it('does not forward unregistered paths from a phone or a failed local selection', async () => {
    await expect(prepareResourceCommand('关联 "D:\\练习.pdf"', [])).rejects.toThrow('所属电脑');
    const host = hostWith({ resourceRegister: vi.fn(async () => ({ ok: false as const, error: { code: 'VALIDATION' as const, message: '文件不存在', retryable: false } })) });
    await expect(prepareResourceCommand('关联 "D:\\练习.pdf"', [], host)).rejects.toThrow('文件不存在');
  });
  it('registers typed HTTP(S) links as stable shared metadata without reading the website', async () => {
    const a = await prepareResourceCommand('把 https://example.org/listen 关联到英语', []);
    const b = await prepareResourceCommand('把 https://example.org/listen 关联到英语', []);
    expect(a.resources).toEqual(b.resources);
    expect(a.resources[0]).toMatchObject({ kind: 'web', url: 'https://example.org/listen' });
  });
  it('reports actual host outcomes and never claims a missing document opened', async () => {
    const open = vi.fn(async () => ({ ok: false as const, error: { code: 'VALIDATION' as const, message: '文件已移动', retryable: false } }));
    expect(await openCommandResources([file], hostWith({ resourceOpen: open }))).toContain('未打开：文件已移动');
    expect(await openCommandResources([file])).toContain('需在电脑打开');
    expect(open).toHaveBeenCalledOnce();
  });
});
