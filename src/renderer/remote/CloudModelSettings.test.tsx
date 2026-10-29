// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SnapshotSchema, type Settings } from '../../shared/contracts';
import { CloudModelSettings } from './CloudModelSettings';
import type { RemoteController } from './types';

afterEach(cleanup);
function fixture() {
  const snapshot=SnapshotSchema.parse({schemaVersion:1,sources:[],candidates:[],tasks:[],blocks:[],goals:[],courses:[],courseExceptions:[],preferences:[],feedback:[],settings:{campus:'合成校区'},journal:[],tokenUsage:[],keyStatus:{configured:true,sessionOnly:false}});
  const request=vi.fn(async(path:string,input?:unknown)=>{
    if(path.endsWith('/snapshot'))return {ok:true,data:snapshot};
    snapshot.settings=(input as {input:{settings:Settings}}).input.settings;
    return {ok:true,data:snapshot.settings};
  });
  const controller={request,getState:()=>({session:{identity:{protocolVersion:1,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1}}})} as unknown as RemoteController;
  return {snapshot,request,controller};
}
it('loads cloud settings, saves a selected effort explicitly and keeps unrelated fields',async()=>{
  const f=fixture();render(<CloudModelSettings controller={f.controller} online/>);
  const effort=await screen.findByLabelText('思考强度');expect((effort as HTMLSelectElement).value).toBe('none');
  fireEvent.change(effort,{target:{value:'max'}});expect(f.request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'保存 AI 设置'}));
  await waitFor(()=>expect(f.snapshot.settings.reasoningEffort).toBe('max'));
  expect(f.snapshot.settings.campus).toBe('合成校区');expect(f.request.mock.calls[1]?.[0]).toBe('/api/v1/rpc/saveSettings');
});
it('does not introduce an optional field for untouched defaults and blocks automatic resend after a lost reply',async()=>{
  const f=fixture();render(<CloudModelSettings controller={f.controller} online/>);await screen.findByLabelText('思考强度');
  fireEvent.click(screen.getByRole('button',{name:'保存 AI 设置'}));await waitFor(()=>expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.snapshot.settings.reasoningEffort).toBeUndefined();
  await screen.findByText(/已保存/);
  f.request.mockRejectedValueOnce(Error('连接中断'));
  fireEvent.change(screen.getByLabelText('思考强度'),{target:{value:'high'}});fireEvent.click(screen.getByRole('button',{name:'保存 AI 设置'}));
  await screen.findByText(/不会自动重发/);expect((screen.getByRole('button',{name:'保存 AI 设置'}) as HTMLButtonElement).disabled).toBe(true);
  expect(f.request).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button',{name:'重新读取 AI 设置'}));await waitFor(()=>expect((screen.getByLabelText('思考强度') as HTMLSelectElement).value).toBe('none'));
});
