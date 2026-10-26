// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SourceSchema } from '../shared/contracts';
import { LocalSourceViewer } from './components/LocalSourceViewer';
afterEach(cleanup);
it('reads local evidence separately and offers no cloud mutation or retransmission of originals',async()=>{
  const source=SourceSchema.parse({id:'local-evidence',version:1,createdAt:'2026-10-25T10:00:00+08:00',updatedAt:'2026-10-25T10:00:00+08:00',kind:'text',label:'合成群',text:'只保留在本机的合成消息',importedAt:'2026-10-25T10:00:00+08:00',captureRef:{messageId:'qqm_synthetic',accountId:'account',groupId:'group',attachmentId:null,locator:'合成依据',transcribed:false}});
  const host={localSourceEvidence:vi.fn().mockResolvedValue({ok:true,data:{sourceId:'cloud-source',match:'distilled-index',sources:[source]}})},onCapture=vi.fn();
  render(<LocalSourceViewer sourceId="cloud-source" host={host} onClose={()=>{}} onCapture={onCapture}/>);
  await screen.findByText('只保留在本机的合成消息');expect(host.localSourceEvidence).toHaveBeenCalledWith({sourceId:'cloud-source'});
  fireEvent.click(screen.getByRole('button',{name:'查看本机采集记录与附件'}));expect(onCapture).toHaveBeenCalledWith(source.captureRef);
  expect(screen.queryByRole('button',{name:/删除|重新分析|提交/})).toBeNull();
});
