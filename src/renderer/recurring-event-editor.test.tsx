// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BlockSchema, MutationRequestSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type MutationInput, type Snapshot } from '../shared/contracts';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { EntityEditor, type EditorTarget } from './components/editor/EntityEditor';
import { Preview } from './components/Preview';
import type { PlannerUI } from './hooks/usePlanner';
import { nextTaskEvent, taskEventSummary, taskEvents } from './task-schedule';
import { selectRailTasks } from './task-rail';
import { App } from './App';

const repositories: Repository[] = [];
afterEach(() => { cleanup(); vi.restoreAllMocks(); repositories.splice(0).forEach(repository => repository.close()); });
const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
function fixture(): Snapshot {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T19:00:00+08:00'));
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  snapshot.tasks.push(TaskSchema.parse({ ...metadata, id: 'duty', title: '双周值班' }));
  snapshot.blocks = ['2026-11-03', '2026-11-17', '2026-12-01'].map((date, index) => BlockSchema.parse({
    ...metadata, id: `duty-${index}`, title: '双周值班', taskId: 'duty', kind: 'event', start: `${date}T20:40:00+08:00`, end: `${date}T21:10:00+08:00`, location: '活动室',
    recurrence: { seriesId: 'series-duty', occurrenceStart: `${date}T20:40:00+08:00` }, reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null },
  }));
  return snapshot;
}
function editor(snapshot: Snapshot, target: EditorTarget = { entity: 'block', id: 'duty-1' }) {
  const mutate = vi.fn(async (_mutations: MutationInput[]) => ({ status: 'preview' }));
  const onClose = vi.fn();
  render(<EntityEditor target={target} snapshot={snapshot} ui={{ busy: false, mutate } as unknown as PlannerUI} onClose={onClose} />);
  return { mutate, onClose };
}
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const scope = () => screen.getByLabelText('修改 / 取消范围') as HTMLSelectElement;

describe('recurring activity scope editor', () => {
  it('defaults to this occurrence, locks task association, and submits only an actual title change', async () => {
    const snapshot = fixture(); snapshot.blocks[1]!.end = null;
    snapshot.blocks[1]!.reminders.leadMinutes = [];
    const { mutate } = editor(snapshot);
    expect(scope().value).toBe('single');
    expect(screen.getByRole('status').textContent).toContain('共 1 次 · 2026-11-17');
    expect((screen.getByLabelText('类型') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('关联任务') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(input('名称'), { target: { value: '临时值班' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: 'single', values: { title: '临时值班' } }]));
    expect(snapshot.blocks[1]!.end).toBeNull();
  });

  it('previews future scope counts by original occurrence order and skips completed/cancelled dates', async () => {
    const snapshot = fixture();
    snapshot.blocks[0]!.start = '2026-12-02T20:40:00+08:00';
    snapshot.blocks[0]!.end = '2026-12-02T21:10:00+08:00';
    snapshot.blocks[2]!.cancelled = true;
    const { mutate } = editor(snapshot);
    fireEvent.change(scope(), { target: { value: 'this-and-following' } });
    expect(screen.getByRole('status').textContent).toContain('共 1 次 · 2026-11-17');
    fireEvent.change(input('提前分钟（逗号分隔；空白继承全局；0 为准时）'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: 'this-and-following', values: { reminders: { enabled: true, leadMinutes: [10], dateOnlyTime: null } } }]));
  });

  it('moving start carries the displayed end but sends only start so each occurrence keeps its duration', async () => {
    const { mutate } = editor(fixture());
    fireEvent.change(scope(), { target: { value: 'this-and-following' } });
    expect(screen.getByRole('status').textContent).toContain('共 2 次 · 2026-11-17 至 2026-12-01');
    fireEvent.change(input('开始'), { target: { value: '2026-11-18T19:00' } });
    expect(input('结束（活动留空默认30分钟）').value).toBe('2026-11-18T19:30');
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: 'this-and-following', values: { start: '2026-11-18T19:00:00+08:00' } }]));
  });

  it('an explicit end edit is included, without rewriting other unchanged fields', async () => {
    const { mutate } = editor(fixture());
    fireEvent.change(input('结束（活动留空默认30分钟）'), { target: { value: '2026-11-17T21:40' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: 'single', values: { end: '2026-11-17T21:40:00+08:00' } }]));
  });

  it.each([
    ['move', '2026-11-18', '20:40', '2026-11-18T21:10', { start: '2026-11-18T20:40:00+08:00' }],
    ['resize', '2026-11-17', '20:40', '2026-11-17T21:40', { end: '2026-11-17T21:40:00+08:00' }],
  ])('routes a calendar %s draft to a single recurring event change', async (_kind, date, time, end, values) => {
    const { mutate } = editor(fixture(), { entity: 'block', id: 'duty-1', draft: { date: date as string, time: time as string, end: end as string, blockId: 'duty-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: 'single', values }]));
  });

  it.each(['single', 'this-and-following'] as const)('cancels %s activities through preview without deleting the linked task', async selectedScope => {
    const snapshot = fixture(), { mutate } = editor(snapshot);
    fireEvent.change(scope(), { target: { value: selectedScope } });
    fireEvent.click(screen.getByRole('button', { name: '取消活动' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/关联任务和历史记录保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '预览取消活动' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ type: 'cancelRecurringEvent', id: 'duty-1', expectedVersion: 1, scope: selectedScope }]));
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.blocks.every(block => !block.cancelled)).toBe(true);
  });

  it('keeps unmodified activity input open without sending an empty mutation', () => {
    const { mutate, onClose } = editor(fixture());
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    expect(screen.getByRole('alert').textContent).toBe('尚未更改活动内容');
    expect(mutate).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});

describe('cancelled activity presentation', () => {
/** Rows show one primary action; other actions sit in the row's "⋯" menu. */
function rowAction(row: HTMLElement, name: string | RegExp) {
  const visible = within(row).queryByRole('button', { name });
  if (visible) return fireEvent.click(visible);
  fireEvent.click(within(row).getByRole('button', { name: /的更多操作$/ }));
  fireEvent.click(within(row).getByRole('menuitem', { name }));
}

  it('skips a cancelled date for next arrangement and hides a fully cancelled task from rail and associations', () => {
    const snapshot = fixture(); snapshot.blocks[0]!.cancelled = true;
    expect(nextTaskEvent(taskEvents(snapshot, 'duty'), Date.now())!.id).toBe('duty-1');
    expect(taskEventSummary(snapshot.blocks)).toContain('剩余2次');
    snapshot.blocks.forEach(block => { block.cancelled = true; });
    expect(nextTaskEvent(snapshot.blocks, Date.now())).toBeUndefined();
    expect(taskEventSummary(snapshot.blocks)).toContain('活动已全部取消');
    expect(selectRailTasks(snapshot, Date.now())).toEqual([]);
    editor(snapshot, { entity: 'block' });
    expect(within(screen.getByLabelText('关联任务')).queryByRole('option', { name: '双周值班' })).toBeNull();
  });

  it('retains cancelled history in task details and never reopens it as an editable arrangement', async () => {
    const snapshot = fixture(); snapshot.blocks.forEach(block => { block.cancelled = true; });
    const api = { snapshot: vi.fn(async () => ({ ok: true, data: snapshot })), onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
    render(<App api={api} />);
    await screen.findByRole('complementary', { name: '未安排任务' });
    fireEvent.click(within(await screen.findByRole('navigation', { name: '主导航' })).getByRole('button', { name: '今天' }));
    expect(screen.queryByRole('button', { name: '双周值班' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    const row = screen.getByRole('button', { name: '双周值班' }).closest('article')!;
    expect(within(row).getByText(/活动已全部取消/)).toBeTruthy();
    rowAction(row, '查看安排');
    const history = screen.getByRole('region', { name: '已安排活动' });
    expect(within(history).getAllByText(/已取消 · 2026/)).toHaveLength(3);
    expect(within(history).queryByRole('button', { name: '调整时间' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('recurring activity change preview', () => {
  it.each(['updateRecurringEvent', 'cancelRecurringEvent'] as const)('shows readable dates, location and reminders for %s without series metadata', mutationType => {
    fixture();
    const repository = createRepository(':memory:'); repositories.push(repository);
    const planner = createPlanner(repository);
    const creation = planner.mutate(MutationRequestSchema.parse({ operationId: 'create-series', origin: 'manual', mutations: [{ type: 'createRecurringTask', values: { title: '双周值班' }, rule: { frequency: 'biweekly', fromDate: '2026-11-03', untilDate: '2026-12-01', weekday: 2, time: '20:40' }, location: '活动室', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } }] }));
    if (creation.status !== 'preview') throw Error(creation.message);
    planner.mutate({ ...creation.proposedRequest, confirmed: true, confirmationToken: creation.confirmationToken });
    const anchor = planner.snapshot().blocks[1]!;
    const mutation = { type: mutationType, id: anchor.id, expectedVersion: anchor.version, scope: 'this-and-following', ...(mutationType === 'updateRecurringEvent' ? { values: { start: '2026-11-17T19:00:00+08:00', location: '办公室', reminders: { enabled: true, leadMinutes: [10], dateOnlyTime: null } } } : {}) };
    const before = planner.snapshot();
    const value = planner.mutate(MutationRequestSchema.parse({ operationId: 'change-series', origin: 'manual', mutations: [mutation] }));
    if (value.status !== 'preview') throw Error(value.message);
    render(<Preview value={value} confirm={vi.fn()} cancel={vi.fn()} busy={false} />);
    const table = screen.getByRole('region', { name: '重复活动更改清单' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.textContent).toContain('2026-11-17 20:40');
    expect(table.textContent).toContain('2026-12-01 20:40');
    expect(table.textContent).toContain('活动室');
    expect(table.textContent).toContain('提前30分钟');
    expect(table.textContent).not.toMatch(/seriesId|occurrenceStart|recurrence/);
    if (mutationType === 'updateRecurringEvent') {
      expect(table.textContent).toContain('2026-11-17 19:00');
      expect(table.textContent).toContain('2026-12-01 19:30');
      expect(table.textContent).toContain('办公室'); expect(table.textContent).toContain('提前10分钟');
    } else expect(within(table).getAllByText('已取消 · 不再提醒')).toHaveLength(2);
    expect(planner.snapshot()).toEqual(before);
  });
});
