// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  CandidateSchema, SnapshotSchema, SourceSchema, TaskSchema,
  type DesktopAPI, type MutationRequestInput,
} from '../shared/contracts';
import { App } from './App';

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T17:00:00+08:00')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
const title = '活动室周四晚上九点半开会';

function fixture() {
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
  snapshot.sources.push(SourceSchema.parse({
    ...metadata, id: 'source-meeting', kind: 'text', text: '周四晚上九点半，活动室开个会哈',
    sentAt: '2026-10-21T00:28:53+08:00', importedAt: metadata.createdAt, status: 'succeeded',
  }));
  snapshot.candidates.push(CandidateSchema.parse({
    ...metadata, id: 'candidate-meeting', title, sourceIds: ['source-meeting'],
    sourceQuote: '周四晚上九点半，活动室开个会哈',
    temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote: '周四晚上九点半，活动室开个会哈' }],
    eventStart: null, eventEnd: null, location: '活动室', status: 'accepted', taskId: 'task-meeting',
  }));
  snapshot.tasks.push(TaskSchema.parse({ ...metadata, id: 'task-meeting', title, candidateId: 'candidate-meeting' }));
  const mutate = vi.fn(async (request: MutationRequestInput) => {
    if (request.mutations.some(mutation => mutation.type === 'removeTask') && !request.confirmed) {
      return { ok: true as const, data: {
        status: 'preview' as const, message: '将移除任务及其关联安排，确认后可撤销。',
        changes: [{ entity: 'task' as const, id: 'task-meeting', action: 'delete' as const, beforeVersion: 1, afterVersion: null, title }],
        conflicts: [], confirmationToken: 'remove-preview-token', expiresAt: '2026-10-23T17:10:00+08:00',
        proposedRequest: request,
        details: [{ entity: 'task' as const, id: 'task-meeting', before: snapshot.tasks[0]!, after: null }],
      } };
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

function field(dialog: HTMLElement, label: string) {
  return within(dialog).getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

/** Rows show one primary action; other actions sit in the row's "⋯" menu. */
function rowAction(row: HTMLElement, name: string | RegExp) {
  const visible = within(row).queryByRole('button', { name });
  if (visible) return fireEvent.click(visible);
  fireEvent.click(within(row).getByRole('button', { name: /的更多操作$/ }));
  fireEvent.click(within(row).getByRole('menuitem', { name }));
}

async function taskRow() {
  fireEvent.click(within(await screen.findByRole('navigation', { name: '主导航' })).getByRole('button', { name: '今天' }));
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  const task = await screen.findByRole('button', { name: title });
  return task.closest('article')!;
}

/** The calendar's unscheduled drawer replaced the side rail; it lists this task because it has no arrangement yet. */
async function emptyRail() {
  const drawer = await screen.findByRole('complementary', { name: '未安排任务' });
  return (await within(drawer).findByRole('button', { name: title })).closest('article')!;
}

describe('scheduling an accepted notice whose extracted activity time was lost', () => {
  it('anchors Thursday 21:30 to the message date and requires an explicit save of the past activity', async () => {
    const { api, mutate, snapshot } = fixture();
    render(<App api={api} />);
    const row = await taskRow();
    rowAction(row, '安排');
    const dialog = await screen.findByRole('dialog', { name: '新建时段' });
    expect(field(dialog, '开始').value).toBe('2026-10-22T21:30');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-10-22T22:00');
    expect(within(dialog).getAllByText(/默认30分钟/).some(element => element.tagName !== 'LABEL')).toBe(true);
    expect(field(dialog, '类型').value).toBe('event');
    expect(field(dialog, '关联任务').value).toBe('task-meeting');
    expect(field(dialog, '地点').value).toBe('活动室');
    expect(within(dialog).getByText(/原通知时间已过/)).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(0);
    expect(snapshot.candidates[0]!.eventStart).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations).toEqual([
      expect.objectContaining({
        type: 'scheduleTaskEvent', id: 'task-meeting', expectedVersion: 1,
        values: expect.objectContaining({ start: '2026-10-22T21:30:00+08:00', end: '2026-10-22T22:00:00+08:00', kind: 'event', taskId: 'task-meeting', location: '活动室' }),
      }),
    ]);
    expect(mutate.mock.calls[0]![0].mutations.some(mutation => mutation.type === 'create')).toBe(false);
  });

  it('uses the same original time from the side rail and leaves records untouched when cancelled', async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-22T20:00:00+08:00'));
    const { api, mutate, snapshot } = fixture();
    render(<App api={api} />);
    rowAction(await emptyRail(), '安排');
    const dialog = await screen.findByRole('dialog', { name: '新建时段' });
    expect(field(dialog, '开始').value).toBe('2026-10-22T21:30');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-10-22T22:00');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(0);
    expect(snapshot.candidates[0]!.eventStart).toBeNull();
  });

  it('prefills an existing candidate activity range without replacing it with conflicting old evidence', async () => {
    const { api, mutate, snapshot } = fixture();
    snapshot.candidates[0]!.eventStart = '2026-11-05T20:35:00+08:00';
    snapshot.candidates[0]!.eventEnd = '2026-11-05T21:25:00+08:00';
    render(<App api={api} />);
    rowAction(await taskRow(), '安排');
    const dialog = await screen.findByRole('dialog', { name: '新建时段' });
    expect(field(dialog, '开始').value).toBe('2026-11-05T20:35');
    expect(field(dialog, '结束（活动留空默认30分钟）').value).toBe('2026-11-05T21:25');
    expect(field(dialog, '类型').value).toBe('event');
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(['unknown evidence', 'missing source date'] as const)('does not guess an activity date from the title with %s', async reason => {
    const { api, mutate, snapshot } = fixture();
    if (reason === 'unknown evidence') snapshot.candidates[0]!.temporalEvidence[0]!.basis = 'unknown';
    else snapshot.sources[0]!.sentAt = null;
    render(<App api={api} />);
    rowAction(await taskRow(), '安排');
    const dialog = await screen.findByRole('dialog', { name: '新建时段' });
    expect(field(dialog, '类型').value).toBe('work');
    expect(field(dialog, '开始').value).not.toBe('2026-10-22T21:30');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('removing an unwanted task from each visible entry point', () => {
  it.each(['row', 'rail', 'details'] as const)('shows the removal preview from the %s without confirming it automatically', async entry => {
    if (entry === 'rail') vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-22T20:00:00+08:00'));
    const { api, mutate, snapshot } = fixture();
    render(<App api={api} />);
    let container: HTMLElement;
    if (entry === 'rail') container = await emptyRail();
    else {
      const row = await taskRow();
      if (entry === 'row') container = row;
      else {
        fireEvent.click(within(row).getByRole('button', { name: title }));
        container = screen.getByRole('complementary', { name: '任务详情' });
      }
    }
    rowAction(container, `移除 ${title}`);
    await screen.findByRole('button', { name: '确认执行' });
    expect(mutate).toHaveBeenCalledTimes(1);
    const request = mutate.mock.calls[0]![0];
    expect(request).toMatchObject({ origin: 'manual', confirmed: false, mutations: [
      { type: 'removeTask', id: 'task-meeting', expectedVersion: 1, includeLinkedBlocks: true },
    ] });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.sources).toHaveLength(1);
    if (entry === 'row') {
      fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
      expect(mutate.mock.calls[1]![0]).toMatchObject({
        operationId: request.operationId, confirmed: true,
        confirmationToken: 'remove-preview-token', mutations: request.mutations,
      });
    } else {
      fireEvent.click(screen.getByRole('button', { name: '取消更改' }));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull();
    }
  });
});
