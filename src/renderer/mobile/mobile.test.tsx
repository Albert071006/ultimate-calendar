// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../App';
import { BlockSchema, CandidateSchema, SnapshotSchema, SourceSchema } from '../../shared/contracts';
import type { PlannerClient } from '../../shared/client';
import { todayDate } from '../calendar-layout';
import { readBrowserImage } from './browser-image';
import { SourceViewer } from '../components/ImportDialog';
import type { PlannerUI } from '../hooks/usePlanner';

afterEach(cleanup);
function fixture() {
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: true, sessionOnly: false } });
  const client = { snapshot: vi.fn(async () => ({ ok: true, data: structuredClone(snapshot) })), onChanged: () => () => {}, mutate: vi.fn(), command: vi.fn() } as unknown as PlannerClient;
  return { snapshot, client };
}
describe('phone layout', () => {
  it('opens today with five navigation choices and exposes remote settings without desktop controls', async () => {
    const { client } = fixture();
    render(<App mobile client={client} remoteStatus={<span>资料服务连接状态</span>} remoteSettings={<button>配对与通知</button>} />);
    await screen.findByRole('region', { name: '今天的安排' });
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText('资料服务连接状态')).toBeTruthy();
    expect(screen.queryByText('本机 · 已保存')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^我的$/ }));
    expect(screen.getByRole('button', { name: '配对与通知' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'QQ 采集' })).toBeNull();
    expect(screen.queryByRole('button', { name: '数据与备份' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^目标$/ }));
    expect(screen.getByRole('button', { name: /返回我的/ })).toBeTruthy();
  });
  it('uses day/three-day/month and presents a calendar selection as a dialog before editing', async () => {
    const { client, snapshot } = fixture(); const date = todayDate();
    snapshot.blocks.push(BlockSchema.parse({ id:'block',version:1,createdAt:`${date}T08:00:00+08:00`,updatedAt:`${date}T08:00:00+08:00`,title:'合成执行时段',kind:'work',start:`${date}T15:10:00+08:00`,end:`${date}T15:55:00+08:00` }));
    const view = render(<App mobile client={client} />);
    await screen.findByRole('region', { name: '今天的安排' });
    fireEvent.click(screen.getByRole('button', { name:/^日历$/ }));
    expect(screen.getByRole('button', {name:'日'}).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', {name:'3天'}));
    expect(view.container.querySelectorAll('.day-column')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', {name:'月'}));
    expect(view.container.querySelectorAll('.month-item')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', {name:'日'}));
    fireEvent.click(view.container.querySelector('.timeline-event-button')!);
    expect(screen.getByRole('dialog', {name:'时段详情'})).toBeTruthy();
  });
  it('opens candidate details only on demand while keeping quick decisions visible', async () => {
    const {client,snapshot}=fixture(); const date=todayDate();
    snapshot.candidates.push(CandidateSchema.parse({id:'candidate',version:1,createdAt:`${date}T08:00:00+08:00`,updatedAt:`${date}T08:00:00+08:00`,title:'合成候选事项',sourceIds:['synthetic-source']}));
    render(<App mobile client={client} />);
    await screen.findByRole('region',{name:'今天的安排'});
    fireEvent.click(screen.getByRole('button',{name:/^待判断/}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button',{name:'接受 合成候选事项'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'忽略 合成候选事项'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'合成候选事项'}));
    expect(screen.getByRole('dialog',{name:'事项详情'})).toBeTruthy();
  });
  it('does not show raw QQ text or attachments to a host-less source viewer', () => {
    const source=SourceSchema.parse({id:'qq',version:1,createdAt:'2026-10-24T08:00:00+08:00',updatedAt:'2026-10-24T08:00:00+08:00',importedAt:'2026-10-24T08:00:00+08:00',kind:'text',text:'禁止在手机渲染的原文',captureRef:{groupId:'synthetic',locator:'test',transcribed:false,messageId:'message',accountId:'account',attachmentId:'attachment'}});
    render(<SourceViewer source={source} ui={{host:undefined} as PlannerUI} onClose={()=>{}} courses={()=>{}} settings={()=>{}} />);
    expect(screen.queryByText('禁止在手机渲染的原文')).toBeNull();
    expect(screen.getByText(/QQ 原文和附件仅保存在采集电脑/)).toBeTruthy();
  });
  it('recognizes a privacy-filtered QQ source without computer IDs or paths', () => {
    const source=SourceSchema.parse({id:'qq-extracted',version:1,createdAt:'2026-10-24T08:00:00+08:00',updatedAt:'2026-10-24T08:00:00+08:00',importedAt:'2026-10-24T08:00:00+08:00',kind:'text',label:'QQ提炼 · 合成事项',text:'不应作为原文渲染的占位内容'});
    render(<SourceViewer source={source} ui={{host:undefined} as PlannerUI} onClose={()=>{}} courses={()=>{}} settings={()=>{}} />);
    expect(screen.queryByText('不应作为原文渲染的占位内容')).toBeNull();
    expect(screen.getByText(/QQ 原文和附件仅保存在采集电脑/)).toBeTruthy();
  });
  it.each(['采集电脑提炼','手机导入（原文已清理）'])('treats the server placeholder %s as unavailable analysis input', label => {
    const source=SourceSchema.parse({id:'placeholder',version:1,createdAt:'2026-10-24T08:00:00+08:00',updatedAt:'2026-10-24T08:00:00+08:00',importedAt:'2026-10-24T08:00:00+08:00',kind:'text',label,text:'不应显示为消息原件的占位内容'});
    render(<SourceViewer source={source} ui={{host:undefined} as PlannerUI} onClose={()=>{}} courses={()=>{}} settings={()=>{}} />);
    expect(screen.queryByRole('button',{name:'提交 / 重试消息分析'})).toBeNull();
    expect(screen.queryByText('不应显示为消息原件的占位内容')).toBeNull();
    expect(screen.queryByText(/消息原件/)).toBeNull();
    expect(screen.getByText(label==='采集电脑提炼'?/QQ 原文和附件仅保存在采集电脑/:/原始文本或截图已清理，提炼出的事项与独立任务仍保留/)).toBeTruthy();
  });
  it('keeps analysis available for an ordinary phone import whose original input remains', () => {
    const source=SourceSchema.parse({id:'ordinary',version:1,createdAt:'2026-10-24T08:00:00+08:00',updatedAt:'2026-10-24T08:00:00+08:00',importedAt:'2026-10-24T08:00:00+08:00',kind:'text',label:'合成手机输入',text:'仍可核对的合成输入'});
    render(<SourceViewer source={source} ui={{host:undefined,snapshot:{keyStatus:{configured:true}}} as PlannerUI} onClose={()=>{}} courses={()=>{}} settings={()=>{}} />);
    expect(screen.getByRole('button',{name:'提交 / 重试消息分析'})).toBeTruthy();
    expect(screen.getByText('仍可核对的合成输入')).toBeTruthy();
  });
});
describe('browser screenshot selection',()=>{
  it('accepts PNG/JPEG signatures and rejects unsupported or oversized files before upload',async()=>{
    const png=new File([new Uint8Array([137,80,78,71,13,10,26,10,0])],'synthetic.png',{type:'image/png'});
    await expect(readBrowserImage(png)).resolves.toMatchObject({label:'synthetic.png',imageDataUrl:expect.stringContaining('data:image/png;base64,')});
    await expect(readBrowserImage(new File(['GIF89a'],'bad.gif',{type:'image/gif'}))).rejects.toThrow('PNG 或 JPEG');
    await expect(readBrowserImage(new File(['not png'],'bad.png',{type:'image/png'}))).rejects.toThrow('内容与文件格式不符');
    const large=new File(['x'],'large.jpg',{type:'image/jpeg'});Object.defineProperty(large,'size',{value:10*1024*1024+1});
    await expect(readBrowserImage(large)).rejects.toThrow('10 MB');
  });
});

