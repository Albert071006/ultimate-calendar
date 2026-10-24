// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema } from '../shared/contracts';
import { Preview } from './components/Preview';

const repositories: Repository[] = [];
afterEach(() => { cleanup(); repositories.splice(0).forEach(r => r.close()); });
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
