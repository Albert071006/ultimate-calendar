// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SourceSchema } from '../shared/contracts';
import { CLEARED_CAPTURE_TEXT } from '../shared/capture-evidence';
import { SourceViewer } from './components/ImportDialog';
import { LocalSourceViewer } from './components/LocalSourceViewer';
import type { PlannerUI } from './hooks/usePlanner';
afterEach(cleanup);
it('reads local evidence separately and offers no cloud mutation or retransmission of originals',async()=>{
  const source=SourceSchema.parse({id:'local-evidence',version:1,createdAt:'2026-10-25T10:00:00+08:00',updatedAt:'2026-10-25T10:00:00+08:00',kind:'text',label:'合成群',text:'只保留在本机的合成消息',importedAt:'2026-10-25T10:00:00+08:00',captureRef:{messageId:'qqm_synthetic',accountId:'account',groupId:'group',attachmentId:null,locator:'合成依据',transcribed:false}});
  const host={localSourceEvidence:vi.fn().mockResolvedValue({ok:true,data:{sourceId:'cloud-source',match:'distilled-index',sources:[source]}})},onCapture=vi.fn();
  render(<LocalSourceViewer sourceId="cloud-source" host={host} onClose={()=>{}} onCapture={onCapture}/>);
  await screen.findByText('只保留在本机的合成消息');expect(host.localSourceEvidence).toHaveBeenCalledWith({sourceId:'cloud-source'});
  fireEvent.click(screen.getByRole('button',{name:'查看本机采集记录与附件'}));expect(onCapture).toHaveBeenCalledWith(source.captureRef);
  expect(screen.queryByRole('button',{name:/删除|重新分析|提交/})).toBeNull();
});
it('drops displayed text on refocus and shows only the cleanup notice for that source', async () => {
  const source = SourceSchema.parse({
    id: 'local-capture', version: 1, createdAt: '2026-10-25T10:00:00+08:00', updatedAt: '2026-10-25T10:00:00+08:00',
    kind: 'text', importedAt: '2026-10-25T10:00:00+08:00', text: '合成旧正文', label: '合成旧标签',
    captureRef: { messageId: 'message', accountId: 'account', groupId: 'group', attachmentId: null, locator: '合成旧定位', transcribed: false },
  });
  const cleared = { ...source, captureRef: { ...source.captureRef!, cleared: true as const }, error: '合成旧错误' };
  const other = { ...source, id: 'independent', captureRef: undefined, text: '另一条保留的正文', label: '' };
  const reply = (sources: typeof source[]) => ({ ok: true, data: { sourceId: 'cloud', match: 'distilled-index', sources } });
  const host = { localSourceEvidence: vi.fn().mockResolvedValueOnce(reply([source, other])).mockResolvedValueOnce(reply([cleared, other])) };
  const viewer = render(<LocalSourceViewer sourceId="cloud" host={host} onClose={vi.fn()} onCapture={vi.fn()} />);
  await screen.findByText('合成旧正文');
  fireEvent(window, new Event('focus'));
  await screen.findByText(CLEARED_CAPTURE_TEXT);
  expect(screen.getByText('另一条保留的正文')).toBeTruthy();
  expect(viewer.container.textContent).not.toMatch(/合成旧/);
  expect(screen.queryByRole('button', { name: '查看本机采集记录与附件' })).toBeNull();
  viewer.unmount();
  const ui = { host: {}, snapshot: { keyStatus: { scope: 'local', configured: true } } } as unknown as PlannerUI;
  const local = render(<SourceViewer source={cleared} ui={ui} onClose={vi.fn()} settings={vi.fn()} courses={vi.fn()} onCapture={vi.fn()} />);
  expect(screen.getByText(CLEARED_CAPTURE_TEXT)).toBeTruthy();
  expect(local.container.textContent).not.toMatch(/合成旧/);
  expect(screen.queryByRole('button', { name: '查看本机采集记录与附件' })).toBeNull();
});
