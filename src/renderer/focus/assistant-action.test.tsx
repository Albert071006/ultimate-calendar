// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createController } from '../../application/controller';
import { createPlanner } from '../../domain/planner';
import { createRepository, type Repository } from '../../storage/repository';
import { instantAt } from '../../domain/time';
import { MutationRequestSchema, type DesktopAPI, type FocusCommand, type CommandRequest } from '../../shared/contracts';
import { App } from '../App';
import { MobileApp } from '../mobile/MobileApp';
import { deliverFocusAction } from './assistant-action';
import type { FocusControls } from './FocusProvider';

const repositories: Repository[] = [];
beforeEach(() => {
  // Happy DOM has neither browser lock API. Run the same synchronous critical section as Web Locks.
  vi.spyOn(navigator, 'locks', 'get').mockReturnValue({ request: async (_key: string, run: () => string) => run() } as unknown as LockManager);
});
afterEach(() => { cleanup(); for (const r of repositories.splice(0)) r.close(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(phone: boolean) {
  let now = Date.parse('2030-05-15T12:00:00+08:00');
  vi.spyOn(Date,'now').mockImplementation(() => now);
  const r = createRepository(':memory:',{ automaticBackup() {} }); repositories.push(r);
  const planner = createPlanner(r,{ automaticBackup() {} });
  let proposal: FocusCommand;
  const controller = createController({repository:r,planner,automaticBackup() {},now:()=>instantAt(now),getApiKey:async ()=>'synthetic-key',
    fetch:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'focus',command:proposal})},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}))});
  const commands = vi.fn(controller.command), undo = vi.fn(async (id?: string) => ({ok:true,data:planner.undo(id)}));
  const api = { snapshot:async()=>({ok:true,data:planner.snapshot()}),command:commands,undo,
    mutate:async (req: Parameters<DesktopAPI['mutate']>[0])=>({ok:true,data:planner.mutate(MutationRequestSchema.parse(req))}),
    onChanged:()=>()=>{}, onNavigate:()=>()=>{} } as unknown as DesktopAPI;
  const launch = () => render(phone ? <MobileApp client={api} connection={{status:'online',pending:[],cachedAt:null,storageError:''}} conversationKey="synthetic-focus-chat"/> : <App api={api}/>);
  async function openChat() {
    if (phone && !screen.queryByRole('dialog',{name:'生活助手'})) fireEvent.click(await screen.findByRole('button',{name:/问问生活助手|生活助手 · 未填 Key/}));
  }
  async function send(text: string, next: FocusCommand) {
    proposal = next; await openChat();
    fireEvent.change(await screen.findByLabelText(phone ? '对生活助手说' : '自然语言指令'),{target:{value:text}});
    const submit = screen.getByLabelText(phone ? '发送' : '发送指令');
    await waitFor(()=>expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(()=>expect(screen.queryAllByText('正在处理…')).toHaveLength(0));
  }
  function advance(ms: number) { now += ms; act(()=>document.dispatchEvent(new Event('visibilitychange'))); }
  const closePanel = () => fireEvent.click(within(screen.getByRole('dialog',{name:'专注计时'})).getByRole('button',{name:'关闭'}));
  return {launch,send,commands,undo,advance,closePanel,openChat,planner};
}

it.each([false,true])('runs local actions in the real assistant shell, protects switching and never replays on mount (phone=%s)',async phone=>{
  const f = setup(phone), first = f.launch();
  await f.send('给合成习题开始正向计时',{type:'start',mode:'stopwatch',title:'合成习题'});
  expect(f.commands.mock.calls[0]![0].focusTimer).toBeNull();
  expect(await screen.findByRole('dialog',{name:'专注计时'})).toBeTruthy(); f.closePanel();
  f.advance(720000);
  await f.send('给合成阅读开一个25分钟番茄钟',{type:'start',mode:'pomodoro',title:'合成阅读'});
  const conflict = within(await screen.findByRole('dialog',{name:'专注计时'}));
  expect(conflict.getByRole('button',{name:/保存当前.*12 分钟.*切换/})).toBeTruthy();
  expect(screen.getByText(/本机已有进行中的计时/)).toBeTruthy();
  fireEvent.click(conflict.getByRole('button',{name:'继续当前计时'})); f.closePanel();
  await f.send('暂停当前计时',{type:'pause'});
  expect(f.commands.mock.calls.at(-1)![0].focusTimer).toMatchObject({phase:'running', title:'合成习题',elapsedMs:720000});
  f.advance(120000);
  await f.send('继续计时',{type:'resume'});
  expect(f.commands.mock.calls.at(-1)![0].focusTimer).toMatchObject({phase:'paused',elapsedMs:720000});
  f.advance(10000);
  await f.send('结束当前专注',{type:'finish'});
  expect(f.commands.mock.calls.at(-1)![0].focusTimer?.elapsedMs).toBe(730000);
  const settlement = within(await screen.findByRole('dialog',{name:'专注计时'}));
  fireEvent.click(settlement.getByRole('button',{name:'放弃本次'}));
  expect(screen.queryByLabelText('迷你计时条')).toBeNull();
  first.unmount(); f.launch(); await f.openChat();
  if (phone) expect(await screen.findByText(/本次计时已结束，请在专注面板/)).toBeTruthy();
  expect(f.commands).toHaveBeenCalledTimes(5); expect(screen.queryByLabelText('迷你计时条')).toBeNull();
});

it.each([false,true])('offers the global undo receipt after an assistant backfill (phone=%s)',async phone=>{
  const f=setup(phone); f.launch(); await f.send('帮我补记刚才写了40分钟高数',{type:'create',title:'高数'});
  const view = phone ? within(screen.getByRole('dialog', {name: '生活助手'})) : screen;
  const undo = await view.findByRole('button',{name:'撤销'});
  expect(f.planner.snapshot().focusSessions[0]?.durationSeconds).toBe(2400);
  fireEvent.click(undo); await waitFor(()=>expect(f.planner.snapshot().focusSessions).toHaveLength(0));
  expect(f.undo.mock.calls[0]?.[0]).toBeTruthy();
});

it.each([false,true])('requires confirmation to edit focus history and exposes undo in the conversation (phone=%s)', async phone => {
  const f = setup(phone);
  f.launch();
  await f.send('补记刚才练习40分钟', {type:'create', title:'练习'});
  await f.send('把今天的练习专注改成30分钟', {type:'update', match:'练习'});
  const confirm = await screen.findByRole('button', {name:'确认执行'});
  expect(f.planner.snapshot().focusSessions[0]?.durationSeconds).toBe(2400);
  fireEvent.click(confirm);
  await waitFor(() => expect(f.planner.snapshot().focusSessions[0]?.durationSeconds).toBe(1800));
  const view = phone ? within(screen.getByRole('dialog', {name:'生活助手'})) : screen;
  fireEvent.click(await view.findByRole('button', {name:'撤销'}));
  await waitFor(() => expect(f.planner.snapshot().focusSessions[0]?.durationSeconds).toBe(2400));
});

it('claims each original request once, including after remount, and ignores a control for a replaced timer',async()=>{
  const request: CommandRequest = {operationId:'synthetic-replay',text:'开始专注',focusTimer:null};
  const requestStart = vi.fn(()=> 'started' as const), pause = vi.fn();
  const controls = () => ({ requestStart, pause, getStatus:()=>({timerId:'new-id',phase:'running'}) }) as unknown as FocusControls;
  const start = {type:'start',title:'练习',mode:'pomodoro'} as const;
  await Promise.all([deliverFocusAction(request,start,controls),deliverFocusAction(request,start,controls)]);
  expect(requestStart).toHaveBeenCalledTimes(1);
  await deliverFocusAction(request,start,controls); expect(requestStart).toHaveBeenCalledTimes(1);
  await deliverFocusAction({...request,operationId:'pause-replaced',focusTimer:{phase:'running',mode:'stopwatch',elapsedMs:60,title:'原计时',plannedMinutes:null,timerId:'old-id'}},{type:'pause',timerId:'old-id'},controls);
  expect(pause).not.toHaveBeenCalled();
});
