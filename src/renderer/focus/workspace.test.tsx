// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPlanner } from '../../domain/planner';
import { createRepository, newEntity, type Repository } from '../../storage/repository';
import { MutationRequestSchema, type DesktopAPI, type MutationRequestInput } from '../../shared/contracts';
import { App } from '../App';
import { MobileApp } from '../mobile/MobileApp';
import { todayDate } from '../calendar-layout';

const repos: Repository[] = [];
afterEach(() => { cleanup(); for (const r of repos.splice(0)) r.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const online = { status: 'online', pending: [], cachedAt: null, storageError: '' } as const;
function setup(device: 'desktop' | 'mobile') {
  let now = Date.parse('2030-05-15T09:00:00+08:00');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const r = createRepository(':memory:', { automaticBackup() {} }); repos.push(r);
  const planner = createPlanner(r, { automaticBackup() {} });
  r.saveSettings({ focusMinutes: 2 });
  r.transact(state => {
    const goal = newEntity(state, 'goal', { title: '合成目标' });
    const task = newEntity(state, 'task', { title: '合成练习', goalId: goal.id });
    newEntity(state, 'block', { title: '合成时段', kind: 'work', start: todayDate() + 'T09:00:00+08:00', end: todayDate() + 'T09:30:00+08:00', taskId: task.id });
  });
  const mutate = vi.fn(async (request: MutationRequestInput) => ({ ok: true, data: planner.mutate(MutationRequestSchema.parse(request)) }));
  const undo = vi.fn(async (id?: string) => ({ ok: true, data: planner.undo(id) }));
  const saveSettings = vi.fn(async ({ settings }: Parameters<DesktopAPI['saveSettings']>[0]) => ({ ok: true, data: r.saveSettings(settings) }));
  const api = { snapshot: async () => ({ ok: true, data: planner.snapshot() }), mutate, undo, saveSettings, onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
  const launch = () => render(device === 'desktop' ? <App api={api}/> : <MobileApp client={api} connection={{ ...online, pending: [] }} conversationKey="synthetic-device"/>);
  return { launch, planner, repository: r, mutate, undo, saveSettings, advance(ms: number) { now += ms; act(() => document.dispatchEvent(new Event('visibilitychange'))); } };
}
it.each(['desktop','mobile'] as const)('%s restores an overdue timer into settlement and rings only once', async device => {
  const f = setup(device);
  const ring = vi.fn(), notify = vi.fn();
  class Audio {
    state = 'running'; currentTime = 0;
    resume = async () => {}; close = async () => {};
    createGain = () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    createOscillator = () => ({ frequency: { value: 0 }, start: ring, stop() {}, connect() {} });
  }
  vi.stubGlobal('AudioContext', Audio);
  vi.stubGlobal('Notification', class { static permission = 'granted'; constructor(message: string) { notify(message); } });
  const view = f.launch(); await screen.findByRole('region', { name: device === 'mobile' ? '今日专注' : '生活助手' });
  tab('今天'); click('开始专注'); change('本次目标（分钟）','3'); change('专注内容','重启练习'); click('开始计时');
  view.unmount(); f.advance(9 * 3600000); f.launch();
  await screen.findByRole('button', { name: '保存记录' }); f.advance(180000);
  expect(ring).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
  click('保存记录'); await screen.findByRole('button', { name: '开始 5 分钟短休' });
  expect(f.planner.snapshot().focusSessions[0]).toMatchObject({ durationSeconds: 180, plannedMinutes: 3, end: '2030-05-15T09:03:00+08:00' });
  click('开始 5 分钟短休'); f.advance(300000); expect(screen.getByRole('dialog').textContent).toContain('休息结束');
  expect(f.planner.snapshot().focusSessions).toHaveLength(1);
});
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));
const tab = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name }));
const closeTimer = () => fireEvent.click(within(screen.getByRole('dialog', { name: '专注计时' })).getByRole('button', { name: '关闭' }));
const confirm = async () => { const b = screen.queryByRole('button', { name: '确认执行' }); if (b) { await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(b); } };
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it.each(['desktop','mobile'] as const)('%s keeps linked focus across navigation and undoes settlement and completion as one transaction', async device => {
  const f = setup(device); f.launch();
  await screen.findByRole('region', { name: device === 'mobile' ? '今日专注' : '生活助手' });
  tab('今天'); expect(await screen.findByRole('region', { name: '今日专注' })).toBeTruthy();
  // Start from a task, then open the planned block on the calendar and resolve the explicit switch prompt.
  click('开始专注 · 合成练习'); closeTimer(); tab('日历');
  const block = await screen.findByRole('button', { name: device === 'desktop' ? /^合成时段 / : /合成时段/ }); fireEvent.click(block);
  click('开始专注 · 合成时段'); click('放弃当前并切换'); closeTimer(); tab('我的');
  f.advance(65000);
  expect(screen.getByLabelText('迷你计时条').textContent).toContain('00:55');
  const mini = within(screen.getByLabelText('迷你计时条')); fireEvent.click(mini.getByRole('button', { name: '展开专注计时' }));
  click('暂停'); f.advance(600000); click('继续'); f.advance(55000);
  expect(screen.getByRole('dialog', { name: '专注计时' }).textContent).toContain('刚才的 2 分钟专注已完成');
  click('保存并标记时段已完成'); await screen.findByRole('button', { name: '确认执行' });
  expect(f.planner.snapshot().focusSessions).toHaveLength(0);
  click('取消更改'); await screen.findByRole('button', { name: '保存并标记时段已完成' });
  click('保存并标记时段已完成'); await screen.findByRole('button', { name: '确认执行' }); await confirm();
  await screen.findByRole('button', { name: '开始 5 分钟短休' });
  const after = f.planner.snapshot();
  expect(after.focusSessions).toHaveLength(1);
  expect(after.focusSessions[0]).toMatchObject({ completedTarget: true, durationSeconds: 120, taskId: after.tasks[0]!.id, blockId: after.blocks[0]!.id, goalId: after.goals[0]!.id });
  expect(after.tasks[0]?.status).toBe('done'); expect(after.blocks[0]?.completed).toBe(true);
  expect(f.mutate.mock.calls.at(-1)?.[0].mutations.map(m => m.type)).toEqual(['createFocusSession','finishBlock']);
  closeTimer(); tab('今天'); expect(screen.getByRole('region', { name: '今日专注' }).textContent).toContain('完成 1 个番茄');
  click('撤销'); await waitFor(() => expect(f.planner.snapshot().focusSessions).toHaveLength(0));
  expect(f.planner.snapshot().tasks[0]?.status).toBe('open'); expect(f.planner.snapshot().blocks[0]?.completed).toBe(false);
});

it('keeps the device notification when sound is muted and isolates a restored library from the old timer', async () => {
  const f = setup('desktop'); f.repository.saveSettings({ ...f.planner.snapshot().settings, focusSoundEnabled: false });
  const audio = vi.fn(), notify = vi.fn();
  vi.stubGlobal('AudioContext', audio);
  vi.stubGlobal('Notification', class { static permission = 'granted'; constructor(message: string) { notify(message); } });
  const first = f.launch(); await screen.findByRole('region', { name: '生活助手' }); tab('今天'); click('开始专注 · 合成练习');
  f.advance(120000); await screen.findByRole('button', { name: '保存记录' });
  expect(notify).toHaveBeenCalledTimes(1); expect(audio).not.toHaveBeenCalled(); first.unmount();

  const other = setup('desktop'); const view = other.launch(); await screen.findByRole('region', { name: '生活助手' });
  expect(screen.queryByRole('dialog', { name: '专注计时' })).toBeNull(); expect(screen.queryByLabelText('迷你计时条')).toBeNull();
  expect(other.planner.snapshot().focusSessions).toHaveLength(0); view.unmount();
  f.launch(); await screen.findByRole('button', { name: '保存记录' }); expect(notify).toHaveBeenCalledTimes(1);
});

it('uses the stopwatch form, drops short focus with a toast, and saves a paused stopwatch with undo', async () => {
  const f = setup('mobile'); f.launch();
  const card = within(await screen.findByRole('region', { name: '今日专注' }));
  fireEvent.click(card.getByRole('button', { name: '开始专注' })); click('正向计时'); click('开始计时');
  f.advance(59000); click('结束专注'); expect(await screen.findByText('专注不足 1 分钟，未保存记录')).toBeTruthy(); expect(f.mutate).not.toHaveBeenCalled();
  fireEvent.click(card.getByRole('button', { name: '开始专注' })); click('正向计时'); change('专注内容','合成速写'); click('开始计时');
  f.advance(65000); click('暂停'); f.advance(120000); click('结束专注'); click('保存已专注 1 分钟');
  await screen.findByRole('button', { name: '撤销' });
  expect(f.planner.snapshot().focusSessions).toMatchObject([{ mode: 'stopwatch', title: '合成速写', completedTarget: true, plannedMinutes: null, durationSeconds: 65 }]);
  click('撤销'); await waitFor(() => expect(f.planner.snapshot().focusSessions).toHaveLength(0));
});

it.each(['desktop','mobile'] as const)('%s browses periods, filters details, edits and undoes manual records and saves defaults', async device => {
  const f = setup(device); f.launch();
  await screen.findByRole('region', { name: device === 'mobile' ? '今日专注' : '生活助手' });
  tab('我的'); click('专注统计');
  for (const period of ['日','月','周']) { click(period); expect(button(period).getAttribute('aria-pressed')).toBe('true'); click('上一周期'); click('下一周期'); }
  fireEvent.click(within(screen.getByRole('region', { name: '时间账单' })).getByRole('button', { name: '今天' }));
  expect(screen.getAllByRole('button', { name: /^2030-/ })).toHaveLength(7);
  click('手动补录'); change('专注标题', '合成阅读'); change('有效分钟', '12'); change('关联目标', f.planner.snapshot().goals[0]!.id); change('备注','合成笔记'); click('保存专注记录');
  await screen.findByText('合成阅读'); expect(f.planner.snapshot().focusSessions[0]).toMatchObject({ title: '合成阅读', note: '合成笔记', durationSeconds: 720, mode: 'manual' });
  click('手动补录'); change('专注标题','自由练习'); change('填写方式','end'); change('结束时间', todayDate() + 'T09:08'); click('保存专注记录');
  await screen.findByText('自由练习'); click(/合成目标.*60%/);
  expect(screen.queryByText('自由练习')).toBeNull(); expect(button(/未归属.*40%/)).toBeTruthy();
  click(/合成目标.*60%/); expect(screen.getByText('自由练习')).toBeTruthy();
  const row = () => within(screen.getByText('合成阅读').closest('article')!);
  fireEvent.click(row().getByRole('button',{ name: '编辑' })); change('专注标题','修改后的阅读'); click('保存专注记录');
  await screen.findByText('修改后的阅读'); click('撤销'); await screen.findByText('合成阅读');
  fireEvent.click(row().getByRole('button',{ name: '删除' })); await confirm();
  await waitFor(() => expect(screen.queryByText('合成阅读')).toBeNull());
  click('撤销'); await screen.findByText('合成阅读');
  tab('我的'); click('番茄钟与专注'); change('专注时长（分钟）','32'); change('短休时长（分钟）','6'); change('长休时长（分钟）','18'); change('长休间隔（轮）','3');
  fireEvent.click(screen.getByLabelText('到点提示音')); click('保存专注设置');
  await screen.findByText('专注设置已保存');
  expect(f.planner.snapshot().settings).toMatchObject({ focusMinutes: 32, shortBreakMinutes: 6, longBreakMinutes: 18, pomodorosBeforeLongBreak: 3, focusSoundEnabled: false });
});
