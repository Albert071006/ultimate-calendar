// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResult, CommandRequest, CommandResult, SelectedImage } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import { MobileAssistant } from '../../mobile/MobileAssistant';
import { Assistant } from './Assistant';

afterEach(() => { cleanup(); localStorage.clear(); });
const image: SelectedImage = {
  label: '合成图片.png',
  imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7cAAAAASUVORK5CYII=',
};
const success: ApiResult<CommandResult> = { ok: true, data: { reply: '合成图片已读。', items: [], mutationResult: null } };
function fixture(native = true) {
  const command = vi.fn<(request: CommandRequest) => Promise<ApiResult<CommandResult>>>(async () => success);
  const selectImage = vi.fn(async (): Promise<ApiResult<SelectedImage | null>> => ({ ok: true, data: image }));
  const ui = {
    client: { command }, ...(native ? { host: { selectImage } } : {}), busy: false, error: '', receive: vi.fn(),
    run: async <T,>(job: () => Promise<ApiResult<T>>) => { const result = await job(); return result.ok ? result.data : undefined; },
  } as unknown as PlannerUI;
  return { ui, command, selectImage };
}
const file = () => new File([Uint8Array.from(atob(image.imageDataUrl.split(',')[1]!), char => char.charCodeAt(0))], image.label, { type: 'image/png' });
const desktop = (ui: PlannerUI) => render(<Assistant ui={ui} selected={null} date="2026-10-26" />);
async function chooseImage() {
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByRole('img', { name: `待发送图片：${image.label}` });
}
async function send() {
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
  await waitFor(() => expect(screen.queryByText('正在处理…')).toBeNull());
}

describe('assistant images', () => {
  it('previews a native image without calling AI, sends an image-only turn, and carries only the latest successful image', async () => {
    const { ui, command, selectImage } = fixture(); desktop(ui);
    await chooseImage();
    expect(command).not.toHaveBeenCalled();
    await send();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![0]).toMatchObject({ text: '', image });
    expect(screen.getByRole('img', { name: `已选图片：${image.label}` })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '解释一下图片' } });
    await send();
    expect(command.mock.calls[1]![0]).toMatchObject({ text: '解释一下图片', history: [{ role: 'user', text: '', image }, { role: 'assistant' }] });

    const nextImage = { ...image, label: '另一张合成图片.png' };
    selectImage.mockResolvedValueOnce({ ok: true, data: nextImage });
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
    await screen.findByRole('img', { name: `待发送图片：${nextImage.label}` });
    await send();
    const nextRequest = command.mock.calls[2]![0];
    expect(nextRequest.image).toEqual(nextImage);
    expect(nextRequest.history!.every(entry => !entry.image)).toBe(true);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '继续说明' } });
    await send();
    expect(command.mock.calls[3]![0].history!.filter(entry => entry.image).map(entry => entry.image)).toEqual([nextImage]);
  });

  it('preserves the exact image and operation id for an explicit retry and excludes failed turns from later context', async () => {
    const { ui, command } = fixture();
    command.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成网络失败', retryable: true } });
    desktop(ui); await chooseImage(); await send();
    const first = command.mock.calls[0]![0];
    expect(screen.getByRole('img', { name: `已选图片：${image.label}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试这条指令' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '现在几点' } });
    await send();
    expect(command.mock.calls[1]![0].history).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '重试这条指令' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(command.mock.calls[2]![0]).toEqual(first);
    expect(command.mock.calls[2]![0].image).toEqual(image);
  });

  it('blocks sends while reading and ignores a cancelled native result', async () => {
    const { ui, command, selectImage } = fixture();
    let resolve!: (value: ApiResult<SelectedImage | null>) => void;
    selectImage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    desktop(ui);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '看看这张' } });
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
    expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('自然语言指令'), { key: 'Enter' });
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '移除图片' }));
    await act(async () => resolve({ ok: true, data: image }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('正在读取图片…')).toBeNull();
    await send();
    expect(command.mock.calls[0]![0].image).toBeUndefined();
  });

  it('accepts a browser file or clipboard image and lets the user remove it before sending', async () => {
    const { ui, command } = fixture(false); desktop(ui);
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file()] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    fireEvent.click(screen.getByRole('button', { name: '移除图片' }));
    expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.paste(screen.getByLabelText('自然语言指令'), { clipboardData: { files: [file()], items: [] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    expect(command).not.toHaveBeenCalled();
    await send();
    expect(command.mock.calls[0]![0].image).toEqual(image);
  });

  it('rejects unsupported, oversized, and disguised image files without sending', async () => {
    const { ui, command } = fixture(false); desktop(ui);
    const picker = screen.getByLabelText('选择助手图片文件');
    fireEvent.change(picker, { target: { files: [new File(['GIF89a'], '合成.gif', { type: 'image/gif' })] } });
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('PNG 或 JPEG');
    fireEvent.change(picker, { target: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], '合成.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('10 MB'));
    fireEvent.change(picker, { target: { files: [new File(['not an image'], '合成.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('图片内容与文件格式不符'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('does not accept new selections or duplicate sends while a request is running', async () => {
    const { ui, command } = fixture(false);
    let resolve!: (value: ApiResult<CommandResult>) => void;
    command.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    desktop(ui);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '合成问题' } });
    fireEvent.keyDown(screen.getByLabelText('自然语言指令'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('自然语言指令'), { key: 'Enter' });
    fireEvent.paste(screen.getByLabelText('自然语言指令'), { clipboardData: { files: [file()], items: [] } });
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('img')).toBeNull();
    await act(async () => resolve(success));
  });

  it('keeps phone images in memory only and restores an honest placeholder without a stale retry request', async () => {
    const { ui, command } = fixture(false);
    command.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成网络失败', retryable: true } });
    const props = { ui, selected: null, date: '2026-10-26', open: true, setOpen: vi.fn(), storageKey: 'synthetic-assistant-images' };
    const first = render(<MobileAssistant {...props} />);
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file()] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '重试这条指令' });
    const stored = localStorage.getItem(props.storageKey)!;
    expect(stored).not.toContain('base64');
    expect(stored).not.toContain('operationId');
    expect(JSON.parse(stored).entries[0].imageUnavailable).toBe(true);
    first.unmount();
    render(<MobileAssistant {...props} />);
    expect(screen.getByText(/重新打开后如需继续看图/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试这条指令' })).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });
});
