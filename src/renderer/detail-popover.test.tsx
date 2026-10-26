// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema, type DesktopAPI } from '../shared/contracts';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));

const repositories: Repository[] = [];
afterEach(() => { cleanup(); vi.restoreAllMocks(); for (const repository of repositories.splice(0)) repository.close(); });
let seq = 0;
function setup(options: { extraSession?: boolean; kind?: 'work' | 'event' } = {}) {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const seed = (mutations: unknown[]) => {
    const result = planner.mutate(MutationRequestSchema.parse({ operationId: `seed-${++seq}`, origin: 'manual', mutations }));
    if (result.status === 'preview') planner.mutate(MutationRequestSchema.parse({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken }));
  };
  const course = (weekday: number) => ({ type: 'create', entity: 'course', values: { title: '合成高数', termStart: '2026-10-19', weekday, firstWeek: 1, lastWeek: 4, startTime: '08:00', endTime: '09:35', location: '合成A101' } });
  seed([course(4), course(1)]);
  seed([{ type: 'create', entity: 'task', values: { title: '合成作业' } }]);
  const taskId = planner.snapshot().tasks[0]!.id;
  seed([{ type: 'create', entity: 'block', values: { title: '写合成作业', kind: options.kind ?? 'work', taskId, start: '2026-10-22T15:00:00+08:00', end: '2026-10-22T16:30:00+08:00' } }]);
  if (options.extraSession) seed([{ type: 'create', entity: 'block', values: { title: '检查合成作业', kind: 'work', taskId, start: '2026-10-22T17:00:00+08:00', end: '2026-10-22T18:00:00+08:00' } }]);
  const mutate = vi.fn(async (request: unknown) => ({ ok: true, data: planner.mutate(MutationRequestSchema.parse(request)) }));
  const api = {
    snapshot: async () => ({ ok: true, data: planner.snapshot() }), mutate,
    undo: async (id: string) => ({ ok: true, data: planner.undo(id) }),
    onChanged: () => () => {}, onNavigate: () => () => {},
  } as unknown as DesktopAPI;
  render(<App api={api} />);
  return { planner, mutate };
}
const block = () => screen.findByRole('button', { name: /^写合成作业/ });

it('opens a summary card beside a clicked session and closes it with Esc', async () => {
  setup();
  fireEvent.click(await block());
  const card = screen.getByRole('complementary', { name: '时段详情' });
  expect(within(card).getByText('执行时段')).toBeTruthy();
  expect(within(card).getByRole('heading', { name: '写合成作业' })).toBeTruthy();
  expect(card.textContent).toContain('10月22日 周四15:00–16:30 · 1 小时 30 分');
  expect(within(card).getByRole('button', { name: '合成作业' })).toBeTruthy();
  expect(card.textContent).toContain('按全局设置');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('complementary', { name: '时段详情' })).toBeNull();
});

it('completes and deletes from the card through the existing mutations, each undoable', async () => {
  const { planner } = setup();
  fireEvent.click(await block());
  fireEvent.click(within(screen.getByRole('complementary', { name: '时段详情' })).getByRole('button', { name: '完成本次时段' }));
  await screen.findByText('已保存，可撤销');
  expect(planner.snapshot().blocks[0]!.completed).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '撤销上次操作' }));
  await vi.waitFor(() => expect(planner.snapshot().blocks[0]!.completed).toBe(false));
  const card = within(screen.getByRole('complementary', { name: '时段详情' }));
  await card.findByRole('button', { name: '完成本次时段' });
  fireEvent.click(card.getByRole('button', { name: '删除 写合成作业' }));
  await vi.waitFor(() => expect(planner.snapshot().blocks).toHaveLength(0));
  fireEvent.click(await screen.findByRole('button', { name: '撤销上次操作' }));
  await vi.waitFor(() => expect(planner.snapshot().blocks).toHaveLength(1));
});

it('separates one work session from completing its whole task and can undo the task decision', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T19:00:00+08:00'));
  const { planner, mutate } = setup({ extraSession: true });
  const drawer = await screen.findByRole('complementary', { name: '未安排任务' });
  expect(within(drawer).getByRole('button', { name: '合成作业' })).toBeTruthy();
  fireEvent.click(await block());
  const card = within(screen.getByRole('complementary', { name: '时段详情' }));
  expect(card.getByText('时段状态').nextElementSibling?.textContent).toBe('未完成');
  expect(card.getByText('任务状态').nextElementSibling?.textContent).toBe('未完成');
  fireEvent.click(card.getByRole('button', { name: '完成本次时段' }));
  await card.findByRole('button', { name: '恢复本次未完成' });
  const afterSession = planner.snapshot();
  expect(afterSession.tasks[0]!.status).toBe('open');
  expect(afterSession.blocks.find(value => value.title === '写合成作业')!.completed).toBe(true);
  expect(afterSession.blocks.find(value => value.title === '检查合成作业')!.completed).toBe(false);
  expect(card.getByText('时段状态').nextElementSibling?.textContent).toBe('已完成');
  expect(card.getByText('任务状态').nextElementSibling?.textContent).toBe('未完成');

  fireEvent.click(card.getByRole('button', { name: '完成整个任务' }));
  await vi.waitFor(() => expect(card.queryByRole('button', { name: '完成整个任务' })).toBeNull());
  expect(mutate.mock.calls.at(-1)![0]).toMatchObject({ mutations: [{ type: 'finishTask', id: afterSession.tasks[0]!.id, expectedVersion: afterSession.tasks[0]!.version, completed: true }] });
  expect(planner.snapshot().tasks[0]!.status).toBe('done');
  expect(planner.snapshot().blocks).toEqual(afterSession.blocks);
  expect(card.getByText('任务状态').nextElementSibling?.textContent).toBe('已完成');
  expect(within(drawer).queryByRole('button', { name: '合成作业' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '撤销上次操作' }));
  await card.findByRole('button', { name: '完成整个任务' });
  expect(planner.snapshot().tasks[0]!.status).toBe('open');
  expect(planner.snapshot().blocks).toEqual(afterSession.blocks);
  expect(within(drawer).getByRole('button', { name: '合成作业' })).toBeTruthy();
});

it('keeps fixed activity completion scoped to its existing event action', async () => {
  const { planner } = setup({ kind: 'event' });
  fireEvent.click(await block());
  const card = within(screen.getByRole('complementary', { name: '时段详情' }));
  expect(card.queryByRole('button', { name: '完成整个任务' })).toBeNull();
  expect(card.queryByRole('button', { name: '完成本次时段' })).toBeNull();
  fireEvent.click(card.getByRole('button', { name: '完成' }));
  await card.findByRole('button', { name: '恢复未完成' });
  expect(planner.snapshot().blocks[0]!.completed).toBe(true);
  expect(planner.snapshot().tasks[0]!.status).toBe('open');
});

it('swaps the drawer for the edit panel while editing and restores it on close; double-click edits directly', async () => {
  setup();
  expect(await screen.findByRole('complementary', { name: '未安排任务' })).toBeTruthy();
  fireEvent.click(await block());
  fireEvent.click(within(screen.getByRole('complementary', { name: '时段详情' })).getByRole('button', { name: '编辑时段' }));
  const panel = screen.getByRole('dialog', { name: '编辑时段' });
  expect(panel.getAttribute('aria-modal')).toBe('false');
  expect(screen.queryByRole('complementary', { name: '未安排任务' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: '时段详情' })).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('complementary', { name: '未安排任务' })).toBeTruthy();

  fireEvent.doubleClick(await block());
  expect(screen.getByRole('dialog', { name: '编辑时段' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('dialog', { name: '编辑时段' })).getByRole('button', { name: '关闭编辑' }));
  expect(screen.getByRole('complementary', { name: '未安排任务' })).toBeTruthy();
});

it('links a task to a course from its form, one choice per course, and the session takes the course color', async () => {
  const { planner, mutate } = setup();
  const color = planner.snapshot().courses[0]!.color!;
  expect(color).toBeTruthy();
  expect((await block()).closest<HTMLElement>('.timeline-event')!.style.getPropertyValue('--c')).toBe('');
  fireEvent.click(await block());
  fireEvent.click(within(screen.getByRole('complementary', { name: '时段详情' })).getByRole('button', { name: '合成作业' }));
  const form = within(screen.getByRole('dialog', { name: '编辑任务' }));
  const select = form.getByLabelText('所属课程') as HTMLSelectElement;
  expect([...select.options].map(option => option.textContent)).toEqual(['无', '合成高数']);
  fireEvent.change(select, { target: { value: select.options[1]!.value } });
  fireEvent.click(form.getByRole('button', { name: '保存' }));
  await screen.findByText('已保存，可撤销');
  expect(mutate.mock.calls.at(-1)![0]).toMatchObject({ mutations: [{ type: 'update', entity: 'task', values: { courseId: select.options[1]!.value } }] });
  expect(planner.snapshot().tasks[0]!.courseId).toBe(select.options[1]!.value);
  await vi.waitFor(async () => expect((await block()).closest<HTMLElement>('.timeline-event')!.style.getPropertyValue('--c')).toBe(color));
  fireEvent.click(await block());
  expect(screen.getByRole('complementary', { name: '时段详情' }).textContent).toContain('合成高数');
});

it('closes the edit panel when switching pages so it never covers another page', async () => {
  setup();
  fireEvent.doubleClick(await block());
  expect(screen.getByRole('dialog', { name: '编辑时段' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '账单' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
