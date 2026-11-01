// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResult, CommandDocument, CommandRequest, CommandResult, SelectedImage } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import { MobileAssistant } from '../../mobile/MobileAssistant';
import { Assistant } from './Assistant';
import * as browserImages from '../../mobile/browser-image';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const image: SelectedImage = {
  label: '合成图片.png',
  imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7cAAAAASUVORK5CYII=',
};
const success: ApiResult<CommandResult> = { ok: true, data: { reply: '合成图片已读。', items: [], mutationResult: null } };
function fixture(native = true) {
  const command = vi.fn<(request: CommandRequest) => Promise<ApiResult<CommandResult>>>(async () => success);
  const selectCommandDocuments = vi.fn(async (): Promise<ApiResult<CommandDocument[] | null>> => ({ ok: true, data: null }));
  const ui = {
    client: { command }, ...(native ? { host: { selectCommandDocuments } } : {}), busy: false, error: '', receive: vi.fn(),
    run: async <T,>(job: () => Promise<ApiResult<T>>) => { const result = await job(); return result.ok ? result.data : undefined; },
  } as unknown as PlannerUI;
  return { ui, command, selectCommandDocuments };
}
const file = (selected = image) => new File([Uint8Array.from(atob(selected.imageDataUrl.split(',')[1]!), char => char.charCodeAt(0))], selected.label, { type: 'image/png' });
const desktop = (ui: PlannerUI) => render(<Assistant ui={ui} selected={null} date="2026-10-26" />);
async function chooseImage(selected = image) {
  fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file(selected)] } });
  await screen.findByRole('img', { name: `待发送图片：${selected.label}` });
}
async function send() {
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
  await waitFor(() => expect(screen.queryByText('正在处理…')).toBeNull());
}

describe('assistant images', () => {
  it('previews images without calling AI, sends an image-only turn, and carries only the latest successful image group', async () => {
    const { ui, command } = fixture(); desktop(ui);
    await chooseImage();
    expect(command).not.toHaveBeenCalled();
    await send();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![0]).toMatchObject({ text: '', images: [image] });
    expect(command.mock.calls[0]![0].image).toBeUndefined();
    expect(screen.getByRole('img', { name: `已选图片：${image.label}` })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '解释一下图片' } });
    await send();
    expect(command.mock.calls[1]![0]).toMatchObject({ text: '解释一下图片', history: [{ role: 'user', text: '', images: [image] }, { role: 'assistant' }] });

    const nextImage = { ...image, label: '另一张合成图片.png' };
    await chooseImage(nextImage);
    await send();
    const nextRequest = command.mock.calls[2]![0];
    expect(nextRequest.images).toEqual([nextImage]);
    expect(nextRequest.history!.every(entry => !entry.images && !entry.image)).toBe(true);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '继续说明' } });
    await send();
    expect(command.mock.calls[3]![0].history!.filter(entry => entry.images).map(entry => entry.images)).toEqual([[nextImage]]);
  });

  it('preserves the exact image and operation id for an explicit retry and excludes failed turns from later context', async () => {
    const { ui, command } = fixture();
    command.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成网络失败', retryable: true } });
    desktop(ui); await chooseImage(); await send();
    const first = command.mock.calls[0]![0];
    expect(screen.getByRole('img', { name: `已选图片：${image.label}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: '核对这条指令' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '现在几点' } });
    await send();
    expect(command.mock.calls[1]![0].history).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '核对这条指令' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(command.mock.calls[2]![0]).toEqual(first);
    expect(command.mock.calls[2]![0].images).toEqual([image]);
  });

  it('blocks sends while reading and ignores a cancelled browser result', async () => {
    const { ui, command } = fixture();
    let resolve!: (value: SelectedImage) => void;
    vi.spyOn(browserImages, 'readBrowserImage').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    desktop(ui);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '看看这张' } });
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file()] } });
    expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('自然语言指令'), { key: 'Enter' });
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消读取' }));
    await act(async () => resolve(image));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('正在读取附件…')).toBeNull();
    await send();
    expect(command.mock.calls[0]![0].images).toBeUndefined();
  });

  it('accepts a browser file or clipboard image and lets the user remove it before sending', async () => {
    const { ui, command } = fixture(false); desktop(ui);
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file()] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    fireEvent.click(screen.getByRole('button', { name: `移除图片：${image.label}` }));
    expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.paste(screen.getByLabelText('自然语言指令'), { clipboardData: { files: [file()], items: [] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    expect(command).not.toHaveBeenCalled();
    await send();
    expect(command.mock.calls[0]![0].images).toEqual([image]);
  });

  it('accepts multiple images, appends pasted images, preserves a full draft on overflow, and removes one image', async () => {
    const { ui, command } = fixture(false); desktop(ui);
    const pictures = Array.from({ length: 4 }, (_, index) => ({ ...image, label: `合成图片${index + 1}.png` }));
    const picker = screen.getByLabelText('选择助手图片文件') as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    fireEvent.change(picker, { target: { files: pictures.slice(0, 2).map(file) } });
    await screen.findByRole('img', { name: `待发送图片：${pictures[1]!.label}` });
    fireEvent.paste(screen.getByLabelText('自然语言指令'), { clipboardData: { files: pictures.slice(2).map(file), items: [] } });
    await screen.findByRole('img', { name: `待发送图片：${pictures[3]!.label}` });
    fireEvent.change(picker, { target: { files: [file()] } });
    expect((await screen.findByRole('alert')).textContent).toContain('最多 4 张');
    expect(screen.getAllByRole('img')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: `移除图片：${pictures[1]!.label}` }));
    await send();
    expect(command.mock.calls[0]![0].images).toEqual([pictures[0], pictures[2], pictures[3]]);
  });

  it('rejects an image batch over the byte budget before reading and keeps the previous draft', async () => {
    const { ui, command } = fixture(false); desktop(ui); await chooseImage();
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [
      new File([new Uint8Array(6 * 1024 * 1024)], '大图甲.png', { type: 'image/png' }),
      new File([new Uint8Array(6 * 1024 * 1024)], '大图乙.png', { type: 'image/png' }),
    ] } });
    expect((await screen.findByRole('alert')).textContent).toContain('合计不能超过 10 MB');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    await send(); expect(command.mock.calls[0]![0].images).toEqual([image]);
  });

  it('reads documents separately from linked resources, preserves table text, and retries the exact attachments', async () => {
    const { ui, command, selectCommandDocuments } = fixture(); desktop(ui);
    const documents: CommandDocument[] = [
      { label: '合成名单.xlsx', text: '工作表：名单\n行1\t姓名\t班级\n行2\t甲同学\t示例一班' },
      { label: '合成通知.pdf', text: '请名单内同学明天到示例办公室。', warnings: ['附件中的图片未作为文字读取'] },
    ];
    selectCommandDocuments.mockResolvedValueOnce({ ok: true, data: documents });
    fireEvent.click(screen.getByRole('button', { name: '读取文件' }));
    await screen.findByRole('button', { name: '移除文件：合成名单.xlsx' });
    expect(screen.getByText('附件中的图片未作为文字读取')).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择指令中的资料' })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '查看这两份文件的名单和通知' } });
    command.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成网络失败', retryable: true } });
    await send();
    const first = command.mock.calls[0]![0];
    expect(first.documents).toEqual(documents);
    expect(first.resources).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('C:\\');
    fireEvent.click(screen.getByRole('button', { name: '核对这条指令' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]![0]).toEqual(first);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '名单里有哪些班级' } });
    await send();
    expect(command.mock.calls[2]![0].history![0]!.documents).toEqual(documents);
    await chooseImage(); await send();
    expect(command.mock.calls[3]![0].history!.every(entry => !entry.documents)).toBe(true);
  });

  it('blocks document reads over the combined text budget without dropping previously selected files', async () => {
    const { ui, command, selectCommandDocuments } = fixture(); desktop(ui);
    const documents: CommandDocument[] = [
      { label: '合成甲.txt', text: '甲'.repeat(40000) }, { label: '合成乙.txt', text: '乙'.repeat(40000) },
    ];
    selectCommandDocuments.mockResolvedValueOnce({ ok: true, data: documents });
    fireEvent.click(screen.getByRole('button', { name: '读取文件' }));
    await screen.findByRole('button', { name: '移除文件：合成乙.txt' });
    selectCommandDocuments.mockResolvedValueOnce({ ok: true, data: [{ label: '合成丙.txt', text: '丙'.repeat(30000) }] });
    fireEvent.click(screen.getByRole('button', { name: '读取文件' }));
    expect((await screen.findByRole('alert')).textContent).toContain('100000 字');
    expect(screen.queryByText('合成丙.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '移除文件：合成甲.txt' }));
    await send(); expect(command.mock.calls[0]![0].documents).toEqual([documents[1]]);
  });

  it('cancels a pending document read and does not send a late parser result', async () => {
    const { ui, command, selectCommandDocuments } = fixture(); desktop(ui);
    let resolve!: (value: ApiResult<CommandDocument[] | null>) => void;
    selectCommandDocuments.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '合成问题' } });
    fireEvent.click(screen.getByRole('button', { name: '读取文件' }));
    fireEvent.keyDown(screen.getByLabelText('自然语言指令'), { key: 'Enter' });
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消读取' }));
    await act(async () => resolve({ ok: true, data: [{ label: '合成晚到.txt', text: '不应被发送的文件内容' }] }));
    expect(screen.queryByText('合成晚到.txt')).toBeNull();
    await send(); expect(command.mock.calls[0]![0].documents).toBeUndefined();
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
    const other = { ...image, label: '手机合成图片二.png' };
    fireEvent.change(screen.getByLabelText('选择助手图片文件'), { target: { files: [file(), file(other)] } });
    await screen.findByRole('img', { name: `待发送图片：${image.label}` });
    expect(screen.queryByRole('button', { name: '读取文件' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '核对这条指令' });
    expect(command.mock.calls[0]![0].images).toEqual([image, other]);
    const stored = localStorage.getItem(props.storageKey)!;
    expect(stored).not.toContain('base64');
    expect(stored).not.toContain('operationId');
    expect(JSON.parse(stored).entries[0].imageUnavailable).toBe(true);
    first.unmount();
    render(<MobileAssistant {...props} />);
    expect(screen.getByText(/重新打开后如需继续看图/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: '核对这条指令' })).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('strips document content from persisted phone conversation data and explains that it must be selected again', () => {
    const { ui, command } = fixture(false);
    const storageKey = 'synthetic-assistant-document-restore';
    localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), entries: [
      { id: 'old-user', role: 'user', text: '解读文件', documents: [{ label: '合成名单.txt', text: '文件正文不应持久保留' }] },
      { id: 'old-assistant', role: 'assistant', text: '合成回复' },
    ] }));
    render(<MobileAssistant ui={ui} selected={null} date="2026-10-26" open setOpen={vi.fn()} storageKey={storageKey} />);
    expect(screen.getByText(/文件内容未保存在本机/)).toBeTruthy();
    expect(localStorage.getItem(storageKey)).not.toContain('文件正文不应持久保留');
    expect(JSON.parse(localStorage.getItem(storageKey)!).entries[0].documentsUnavailable).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });
});
