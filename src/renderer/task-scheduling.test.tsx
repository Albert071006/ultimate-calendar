// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BlockSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type MutationRequestInput } from '../shared/contracts';
import { App } from './App';

afterEach(cleanup);

const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
const eventStart = '2026-11-06T15:35:00+08:00';
const eventEnd = '2026-11-06T17:10:00+08:00';

function fixture({ end = eventEnd, scheduled = true }: { end?: string | null; scheduled?: boolean } = {}) {
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
  snapshot.tasks.push(TaskSchema.parse({ ...metadata, id: 'task-notice', title: '参加学院讲座', candidateId: 'notice' }));
  if (scheduled) snapshot.blocks.push(BlockSchema.parse({
    ...metadata, id: 'event-notice', title: '参加学院讲座', kind: 'event',
    taskId: 'task-notice', candidateId: 'notice', start: eventStart, end, location: '北校区报告厅',
  }));
  const mutate = vi.fn(async (request: MutationRequestInput) => {
    for (const mutation of request.mutations) {
      if (mutation.type === 'update' && mutation.entity === 'block') {
        const index = snapshot.blocks.findIndex(block => block.id === mutation.id);
        if (index >= 0) snapshot.blocks[index] = BlockSchema.parse({
          ...snapshot.blocks[index], ...mutation.values, version: snapshot.blocks[index]!.version + 1,
        });
      }
    }
    return { ok: true as const, data: { status: 'applied' as const, message: '已保存', changes: [], conflicts: [], transactionId: 'tx' } };
  });
  const api = {
    snapshot: vi.fn(async () => ({ ok: true, data: structuredClone(snapshot) })),
    onChanged: () => () => {}, onNavigate: () => () => {}, mutate,
    command: vi.fn(), undo: vi.fn(), selectImage: vi.fn(), importCourses: vi.fn(), setApiKey: vi.fn(),
  } as unknown as DesktopAPI;
  return { snapshot, api, mutate };
}

function field(dialog: HTMLElement, label: string | RegExp) {
  return within(dialog).getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

async function taskRow() {
  fireEvent.click(await screen.findByRole('button', { name: '任务' }));
  const title = await screen.findByRole('button', { name: /参加学院讲座.*未设截止/ });
  return title.closest('article')!;
}

describe('scheduling accepted tasks with existing activity times', () => {
  it('opens the existing fixed event from the task row and saves changes to that event without creating a duplicate', async () => {
    const { api, mutate, snapshot } = fixture();
    render(<App api={api} />);
    const row = await taskRow();
    expect(within(row).getByText(/已加入日历/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '查看安排' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-06T15:35');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-11-06T17:10');
    expect(field(dialog, '类型').value).toBe('event');
    expect(field(dialog, '关联任务').value).toBe('task-notice');
    expect(field(dialog, '地点').value).toBe('北校区报告厅');
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.change(field(dialog, '开始'), { target: { value: '2026-11-06T15:40' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations).toEqual([
      expect.objectContaining({
        type: 'update', entity: 'block', id: 'event-notice', expectedVersion: 1,
        values: expect.objectContaining({ start: '2026-11-06T15:40:00+08:00', end: eventEnd, kind: 'event', taskId: 'task-notice', location: '北校区报告厅' }),
      }),
    ]);
    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.blocks[0]).toMatchObject({ id: 'event-notice', candidateId: 'notice', start: '2026-11-06T15:40:00+08:00' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reuses a start-only event from the rail with a disclosed, editable thirty-minute default', async () => {
    const { api, mutate, snapshot } = fixture({ end: null });
    render(<App api={api} />);
    const rail = (await screen.findByRole('heading', { name: '待办任务', level: 3 })).closest('aside')!;
    fireEvent.click(await within(rail).findByRole('button', { name: '查看安排' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-06T15:35');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-11-06T16:05');
    expect(within(dialog).getAllByText(/默认30分钟/).some(element => element.tagName !== 'LABEL')).toBe(true);
    expect(field(dialog, '类型').value).toBe('event');
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations[0]).toMatchObject({
      type: 'update', entity: 'block', id: 'event-notice', values: { start: eventStart, end: '2026-11-06T16:05:00+08:00', kind: 'event' },
    });
    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.blocks[0]!.end).toBe('2026-11-06T16:05:00+08:00');
  });

  it('opens the existing event from selected task details and leaves it untouched when cancelled', async () => {
    const { api, mutate, snapshot } = fixture();
    render(<App api={api} />);
    const row = await taskRow();
    fireEvent.click(within(row).getByRole('button', { name: /参加学院讲座.*未设截止/ }));
    const details = screen.getByRole('heading', { name: '任务', level: 3 }).closest('aside')!;
    fireEvent.click(within(details).getByRole('button', { name: '调整时间' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-06T15:35');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-11-06T17:10');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a deadline-only task unscheduled and opens a separate work draft without using the deadline as activity time', async () => {
    const { api, mutate, snapshot } = fixture({ scheduled: false });
    snapshot.tasks[0]!.deadline = { date: '2026-11-12', time: '23:59' };
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '任务' }));
    const row = (await screen.findByRole('button', { name: /参加学院讲座.*截止/ })).closest('article')!;
    expect(within(row).queryByText(/已加入日历/)).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '安排时间' }));
    const dialog = await screen.findByRole('dialog', { name: '新建时段' });
    expect(field(dialog, '类型').value).toBe('work');
    expect(field(dialog, '关联任务').value).toBe('task-notice');
    expect(field(dialog, '开始').value).not.toBe('2026-11-12T23:59');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).not.toBe('2026-11-12T23:59');
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(0);
  });

  it('opens the next event among multiple arrangements and keeps every occurrence editable in task details', async () => {
    const { api, mutate, snapshot } = fixture();
    snapshot.blocks.push(BlockSchema.parse({
      ...metadata, id: 'event-second', title: '学院讲座答疑', kind: 'event', taskId: 'task-notice', candidateId: 'notice',
      start: '2026-11-07T10:25:00+08:00', end: '2026-11-07T11:10:00+08:00', location: '北校区讨论室',
    }));
    render(<App api={api} />);
    const row = await taskRow();
    fireEvent.click(within(row).getByRole('button', { name: '查看安排' }));
    let dialog = await screen.findByRole('dialog', { name: '编辑时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-06T15:35');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(within(row).getByRole('button', { name: /参加学院讲座.*未设截止/ }));
    const details = screen.getByRole('heading', { name: '任务', level: 3 }).closest('aside')!;
    const choices = within(details).getAllByRole('button', { name: '调整时间' });
    expect(choices).toHaveLength(2);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(choices[1]!);
    dialog = await screen.findByRole('dialog', { name: '编辑时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-07T10:25');
    expect(field(dialog, '地点').value).toBe('北校区讨论室');
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(2);
  });
});
