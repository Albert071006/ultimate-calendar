// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createController } from '../application/controller';
import { createPlanner } from '../domain/planner';
import { createRepository, type Repository } from '../storage/repository';
import type { HostCapabilities, PlannerClient } from '../shared/client';
import type { ChatMessage } from '../ai/deepseek';
import { ImportDialog } from './components/ImportDialog';
import { usePlanner } from './hooks/usePlanner';

const image = { label: 'fixture.png', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const hiddenText = '只留在文字标签的合成草稿';
const repositories: Repository[] = [];
afterEach(() => {
  cleanup();
  for (const repository of repositories.splice(0)) repository.close();
});

function openDialog(mode: 'local' | 'cloud' | 'phone') {
  const repository = createRepository(':memory:');
  repositories.push(repository);
  const modelRequests: ChatMessage[][] = [];
  const controller = createController({
    repository, planner: createPlanner(repository), getApiKey: async () => 'test-only',
    fetch: async (_url, init) => {
      modelRequests.push(JSON.parse(String(init?.body)).messages);
      return new Response(JSON.stringify({
        id: 'fixture', model: 'fixture', object: 'chat.completion', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"candidates":[]}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    },
  });
  const importSource = vi.fn(controller.importSource);
  const analyzeSource = vi.fn(controller.analyzeSource);
  const client = {
    snapshot: async () => ({ ok: true, data: { ...repository.snapshot(),
      keyStatus: { configured: true, sessionOnly: false, ...(mode === 'cloud' && { scope: 'cloud' }) },
    } }),
    onChanged: () => () => {}, importSource, analyzeSource,
  } as unknown as PlannerClient;
  const host = mode === 'phone' ? undefined : { selectImage: async () => ({ ok: true, data: image }) } as HostCapabilities;
  const close = vi.fn();
  function Dialog() {
    const ui = usePlanner(client, host);
    if (!ui.snapshot) return null;
    return <><ImportDialog ui={ui} onClose={close} settings={vi.fn()} /><output>{ui.notice}</output></>;
  }
  render(<Dialog />);
  return { importSource, analyzeSource, modelRequests, close };
}

it('submits only the selected screenshot to storage and to the model after switching tabs', async () => {
  const { importSource, modelRequests, close } = openDialog('cloud');
  fireEvent.change(await screen.findByLabelText('原始消息'), { target: { value: hiddenText } });
  fireEvent.click(screen.getByRole('button', { name: '消息截图' }));
  fireEvent.click(screen.getByRole('button', { name: '选择 PNG / JPEG 截图' }));
  await screen.findByAltText('所选消息截图');
  fireEvent.click(screen.getByRole('button', { name: '粘贴文字' }));
  expect((screen.getByLabelText('原始消息') as HTMLTextAreaElement).value).toBe(hiddenText);
  fireEvent.click(screen.getByRole('button', { name: '消息截图' }));
  fireEvent.click(screen.getByRole('button', { name: '保存并提交 AI 分析' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(importSource.mock.calls[0]?.[0].source).toEqual({
    kind: 'image', label: image.label, sentAt: null, imageDataUrl: image.imageDataUrl,
  });
  expect(modelRequests).toHaveLength(1);
  const content = modelRequests[0]?.find(message => message.role === 'user')?.content;
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw Error('缺少截图分析上下文');
  expect(JSON.parse(content[0].text).text).toBe('');
  expect(content[1]).toEqual({ type: 'image_url', image_url: { url: image.imageDataUrl } });
  expect(JSON.stringify(modelRequests)).not.toContain(hiddenText);
});

it('cannot reuse a late text-save receipt for the screenshot now selected', async () => {
  const { importSource, analyzeSource, modelRequests, close } = openDialog('cloud');
  const persist = importSource.getMockImplementation()!;
  let finishSave!: () => void;
  const gate = new Promise<void>(resolve => { finishSave = resolve; });
  importSource.mockImplementationOnce(async request => { await gate; return persist(request); });
  analyzeSource.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成分析失败', retryable: true } });
  fireEvent.change(await screen.findByLabelText('原始消息'), { target: { value: hiddenText } });
  fireEvent.click(screen.getByRole('button', { name: '保存并提交 AI 分析' }));
  fireEvent.click(screen.getByRole('button', { name: '消息截图' }));
  fireEvent.click(screen.getByRole('button', { name: '选择 PNG / JPEG 截图' }));
  await screen.findByAltText('所选消息截图');
  finishSave();
  await screen.findByText('合成分析失败');
  fireEvent.click(screen.getByRole('button', { name: '保存并提交 AI 分析' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(importSource).toHaveBeenCalledTimes(2);
  expect(importSource.mock.calls[1]?.[0].source).toEqual({
    kind: 'image', label: image.label, sentAt: null, imageDataUrl: image.imageDataUrl,
  });
  expect(analyzeSource.mock.calls[1]?.[0].sourceId).not.toBe(analyzeSource.mock.calls[0]?.[0].sourceId);
  expect(modelRequests).toHaveLength(1);
  expect(JSON.stringify(modelRequests)).not.toContain(hiddenText);
});

it.each([
  ['local', '本机'], ['cloud', '云端资料服务'], ['phone', '云端资料服务'],
] as const)('shows the actual save location in %s mode and saves text without analysis', async (mode, location) => {
  const { importSource, modelRequests, close } = openDialog(mode);
  expect(await screen.findByText(mode === 'local' ? /原文先保存在本机/ : /原文先保存在云端/)).toBeTruthy();
  expect(Boolean(screen.queryByText(/尝试保留本机副本/))).toBe(mode === 'cloud');
  fireEvent.change(screen.getByLabelText('原始消息'), { target: { value: hiddenText } });
  fireEvent.click(screen.getByRole('button', { name: '仅保存原文' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(importSource.mock.calls[0]?.[0].source).toEqual({ kind: 'text', text: hiddenText, label: '', sentAt: null });
  expect(screen.getByText('来源已保存在' + location)).toBeTruthy();
  expect(modelRequests).toHaveLength(0);
});
