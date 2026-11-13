// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema, BlockSchema, CandidateSchema, FeedbackSchema, TaskSchema, type MutationResult } from '../shared/contracts';
import { Preview } from './components/Preview';

const repositories: Repository[] = [];
afterEach(() => { cleanup(); repositories.splice(0).forEach(r => r.close()); });
it('names the existing task-linked item under overlap details when the new activity starts later', () => {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  const task = repository.writeInternal({ operationId: 'existing-task', changes: [{ entity: 'task', values: { title: '已有安排对应任务' } }] }).entities[0]!;
  const existing = repository.writeInternal({ operationId: 'existing-block', changes: [{ entity: 'block', values: {
    title: '已有安排', kind: 'event', taskId: task.id, start: '2031-04-18T14:00:00+08:00', end: '2031-04-18T15:00:00+08:00',
  } }] }).entities[0]!;
  const value = planner.mutate(MutationRequestSchema.parse({ operationId: 'overlapping-new-event', origin: 'manual', mutations: [{ type: 'create', entity: 'block', values: {
    title: '新增活动', kind: 'event', start: '2031-04-18T14:30:00+08:00', end: '2031-04-18T15:30:00+08:00',
  } }] }));
  if (value.status !== 'preview') throw Error('Expected overlap preview');
  const { container } = render(<Preview value={value} confirm={() => {}} cancel={() => {}} busy={false} names={id => id === existing.id ? '已有安排' : undefined} />);
  expect(container.querySelector('.conflict small')?.textContent).toBe('重叠事项：已有安排');
});
it('shows every changed business field in a real bulk preview, including conditions and attribution', () => {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const source = repository.writeInternal({ operationId: 'source', changes: [{ entity: 'source', values: { kind: 'text', text: '合成通知', importedAt: '2026-10-22T09:00:00+08:00' } }] }).entities[0]!;
  const candidate = repository.writeInternal({ operationId: 'candidate', changes: [{ entity: 'candidate', values: { title: '合成报告', sourceIds: [source.id] } }] }).entities[0]!;
  const block = repository.writeInternal({ operationId: 'block', changes: [{ entity: 'block', values: { title: '合成时段', start: '2026-10-22T09:00:00+08:00', end: '2026-10-22T10:00:00+08:00', kind: 'work' } }] }).entities[0]!;
  const value = planner.mutate(MutationRequestSchema.parse({ operationId: 'bulk', origin: 'manual', mutations: [
    { type: 'update', entity: 'candidate', id: candidate.id, expectedVersion: 1, values: { conditions: ['必须支付500元'], benefitKind: 'stated', uncertainties: ['资格待确认'] } },
    { type: 'update', entity: 'block', id: block.id, expectedVersion: 1, values: { kind: 'event' } },
  ] }));
  if (value.status !== 'preview') throw Error('Expected actual preview');
  const { container } = render(<Preview value={value} confirm={() => {}} cancel={() => {}} busy={false} />);
  expect(screen.getByText('必须支付500元')).toBeTruthy();
  expect(screen.getByText('原文明确')).toBeTruthy();
  expect(screen.getByText('资格待确认')).toBeTruthy();
  expect(screen.getByText('固定活动')).toBeTruthy();
  for (const body of container.querySelectorAll('tbody')) expect(body.children.length).toBeGreaterThan(0);
  expect(screen.queryByRole('rowheader', { name: 'version' })).toBeNull();
});

it('shows exception course association and a visible explanation for metadata-only details', () => {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  for (const [index, title] of ['合成课程A', '合成课程B'].entries()) planner.mutate(MutationRequestSchema.parse({ operationId: `course-${index}`, origin: 'manual', mutations: [{ type: 'create', entity: 'course', values: { title, termStart: '2026-10-19', weekday: index + 1, firstWeek: 1, lastWeek: 2, startTime: '08:00', endTime: '09:00' } }] }));
  const [first, second] = planner.snapshot().courses;
  const exception = repository.writeInternal({ operationId: 'exception', changes: [{ entity: 'courseException', values: { courseId: first!.id, originalDate: '2026-10-19', cancelled: true } }] }).entities[0]!;
  const value = planner.mutate(MutationRequestSchema.parse({ operationId: 'reassign', origin: 'manual', mutations: [
    { type: 'update', entity: 'courseException', id: exception.id, expectedVersion: 1, values: { courseId: second!.id, originalDate: '2026-10-20' } },
    { type: 'update', entity: 'course', id: first!.id, expectedVersion: 1, scope: 'all', values: { title: first!.title } },
  ] }));
  if (value.status !== 'preview') throw Error('Expected actual preview');
  const names = (id: string) => planner.snapshot().courses.find(course => course.id === id)?.title;
  render(<Preview value={value} confirm={() => {}} cancel={() => {}} busy={false} names={names} />);
  const row = screen.getByRole('rowheader', { name: '关联课程' }).closest('tr')!;
  expect(within(row).getByText('合成课程A')).toBeTruthy();
  expect(within(row).getByText('合成课程B')).toBeTruthy();
  expect(screen.getByText('业务字段未改变（仅内部记录信息变化）')).toBeTruthy();
});

it('summarises removing a task in plain sentences, names links instead of ids and folds the field tables away', () => {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const task = repository.writeInternal({ operationId: 'task', changes: [{ entity: 'task', values: { title: '合成：周五带电脑去教室', description: '合成说明' } }] }).entities[0]!;
  const source = repository.writeInternal({ operationId: 'source', changes: [{ entity: 'source', values: { kind: 'text', text: '合成通知', importedAt: '2026-10-22T09:00:00+08:00' } }] }).entities[0]!;
  repository.writeInternal({ operationId: 'candidate', changes: [{ entity: 'candidate', values: { title: '合成：周五带电脑去教室', taskId: task.id, sourceIds: [source.id] } }] });
  repository.writeInternal({ operationId: 'block', changes: [{ entity: 'block', values: { title: '合成：带电脑', kind: 'event', taskId: task.id, start: '2026-10-23T16:00:00+08:00', end: '2026-10-23T17:00:00+08:00' } }] });
  const value = planner.mutate(MutationRequestSchema.parse({ operationId: 'remove', origin: 'manual', mutations: [{ type: 'removeTask', id: task.id, expectedVersion: 1, includeLinkedBlocks: true }] }));
  if (value.status !== 'preview') throw Error('Expected actual preview');
  const { container } = render(<Preview value={value} confirm={() => {}} cancel={() => {}} busy={false} />);
  const summary = screen.getByRole('region', { name: '更改摘要' });
  expect(within(summary).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    '移除任务「合成：周五带电脑去教室」',
    '删除活动「合成：带电脑」（2026-10-23 16:00）',
    '通知「合成：周五带电脑去教室」保留，只是不再关联被移除的任务',
  ]);
  expect(summary.textContent).toContain('确认后可以撤销');
  expect(container.textContent).not.toContain(task.id);
  const more = container.querySelector('details.preview-more') as HTMLDetailsElement;
  expect(more.open).toBe(false);
  // A removed record lists only what it held, not a column of 未设置.
  const removed = within(more).getByRole('heading', { name: '移除任务 · 合成：周五带电脑去教室' }).closest('section')!;
  expect(within(removed).queryByText('未设置')).toBeNull();
  expect(within(removed).getByText('合成说明')).toBeTruthy();
});

it('summarises accepting a notice as one calendar arrangement and retains internal changes under details', () => {
  const base = { version: 1, createdAt: '2026-11-13T12:00:00+08:00', updatedAt: '2026-11-13T12:00:00+08:00' };
  const before = CandidateSchema.parse({ ...base, id: 'notice', title: '合成考核', sourceIds: ['synthetic-source'] });
  const task = TaskSchema.parse({ ...base, id: 'task', title: '合成考核', candidateId: before.id });
  const block = BlockSchema.parse({ ...base, id: 'block', title: '合成考核', taskId: task.id, kind: 'event', start: '2026-11-18T16:00:00+08:00', end: '2026-11-18T17:00:00+08:00', location: '合成体育馆' });
  const feedback = FeedbackSchema.parse({ ...base, id: 'feedback', candidateId: before.id, decision: 'accepted' });
  const value: Extract<MutationResult, { status: 'preview' }> = { status: 'preview', confirmationToken: 'synthetic-token', expiresAt: '2026-11-13T12:10:00+08:00', message: '合成预览', conflicts: [], changes: [],
    proposedRequest: MutationRequestSchema.parse({ operationId: 'synthetic-accept', origin: 'manual', mutations: [{ type: 'acceptCandidate', id: before.id, expectedVersion: before.version }] }),
    details: [
      { entity: 'candidate', id: before.id, before, after: { ...before, status: 'accepted', taskId: task.id,
        eventStart: block.start, eventEnd: block.end, uncertainties: ['已依据原文恢复具体时间'],
        temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: '11月18日16点' }] } },
      { entity: 'task', id: task.id, before: null, after: task },
      { entity: 'block', id: block.id, before: null, after: block },
      { entity: 'feedback', id: feedback.id, before: null, after: feedback },
    ],
  };
  const { container } = render(<Preview value={value} confirm={() => {}} cancel={() => {}} busy={false} />);
  const summary = screen.getByRole('region', { name: '更改摘要' });
  expect(within(summary).getAllByRole('listitem').map(item => item.textContent)).toEqual(['加入日历：「合成考核」 · 周三 11月18日 16:00–17:00 · 合成体育馆']);
  expect(summary.textContent).not.toMatch(/反馈|关联任务|未设置|新建任务/);
  const more = container.querySelector('details.preview-more') as HTMLDetailsElement;
  expect(more.open).toBe(false);
  expect(more.textContent).toContain('新建任务');
  expect(more.textContent).toContain('新建反馈');
  expect(more.textContent).toContain('已依据原文恢复具体时间');
  expect(more.textContent).toContain('活动开始');
});
