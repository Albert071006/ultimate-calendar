// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { buildCalendar } from '../domain/calendar';
import { createController } from '../application/controller';
import { MutationRequestSchema, type DesktopAPI } from '../shared/contracts';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));

const repositories: Repository[] = [];
afterEach(() => { cleanup(); for (const repository of repositories.splice(0)) repository.close(); });
function setup(weekday = 4) {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  planner.mutate(MutationRequestSchema.parse({ operationId: 'synthetic-course', origin: 'manual', mutations: [{
    type: 'create', entity: 'course', values: { title: '合成验收样例：单周课程', termStart: '2026-10-19', weekday,
      firstWeek: 1, lastWeek: 4, parity: 'odd', startTime: '08:00', endTime: '09:00', location: '合成A101' },
  }] }));
  const controller = createController({ repository, planner, getApiKey: async () => null });
  const api: Pick<DesktopAPI, 'snapshot' | 'mutate' | 'command' | 'undo' | 'onChanged' | 'onNavigate'> = {
    snapshot: async () => ({ ok: true, data: planner.snapshot() }),
    mutate: async request => ({ ok: true, data: planner.mutate(MutationRequestSchema.parse(request)) }),
    command: request => controller.command(request),
    undo: async id => ({ ok: true, data: planner.undo(id) }),
    onChanged: () => () => {}, onNavigate: () => () => {},
  };
  render(<App api={api as DesktopAPI} />);
  return { planner };
}
async function editor(scope: string, occurrence: string) {
  fireEvent.click(await screen.findByRole('button', { name: '课表' }));
  const manager = within(screen.getByRole('region', { name: '课程表' }));
  fireEvent.click(manager.getByRole('button', { name: /合成验收样例：单周课程/ }));
  const form = within(screen.getByRole('dialog', { name: '编辑课程' }));
  fireEvent.change(form.getByLabelText('范围'), { target: { value: scope } });
  fireEvent.change(form.getByLabelText('原上课日期'), { target: { value: occurrence } });
  return form;
}

it.each([
  ['single', '2026-10-22', '09:00', '08:00', 1],
  ['this-and-following', '2026-11-05', '08:00', '09:00', 0],
  ['all', '2026-10-22', '09:00', '09:00', 0],
])('edits course scope %s through the real hook and planner only after preview confirmation', async (scope, occurrence, firstTime, laterTime, exceptions) => {
  const { planner } = setup();
  const form = await editor(scope as string, occurrence as string);
  fireEvent.change(form.getByLabelText('开始'), { target: { value: '09:00' } });
  fireEvent.change(form.getByLabelText('结束'), { target: { value: '10:00' } });
  fireEvent.click(form.getByRole('button', { name: '保存并预览' }));
  const preview = within(await screen.findByRole('dialog', { name: '更改预览' }));
  expect(planner.snapshot().courseExceptions).toHaveLength(0);
  expect(planner.snapshot().courses[0]!.startTime).toBe('08:00');
  fireEvent.click(preview.getByRole('button', { name: '确认执行' }));
  await screen.findByText('已保存，可撤销');
  const snapshot = planner.snapshot();
  expect(snapshot.courseExceptions).toHaveLength(exceptions as number);
  expect(buildCalendar(snapshot, '2026-10-22', '2026-10-22', false)[0]!.start).toBe(`2026-10-22T${firstTime}:00+08:00`);
  expect(buildCalendar(snapshot, '2026-11-05', '2026-11-05', false)[0]!.start).toBe(`2026-11-05T${laterTime}:00+08:00`);
});

it('reschedules Monday to Tuesday, selects and edits the moved occurrence, and undoes both previews without changing adjacent weeks', async () => {
  const { planner } = setup(1);
  const form = await editor('single', '2026-10-19');
  fireEvent.change(form.getByLabelText('调课日期'), { target: { value: '2026-10-20' } });
  fireEvent.change(form.getByLabelText('开始'), { target: { value: '10:00' } });
  fireEvent.change(form.getByLabelText('结束'), { target: { value: '11:00' } });
  fireEvent.change(form.getByLabelText('名称'), { target: { value: '合成调课' } });
  fireEvent.change(form.getByLabelText('地点'), { target: { value: '合成B202' } });
  fireEvent.click(form.getByRole('button', { name: '保存并预览' }));
  let preview = within(await screen.findByRole('dialog', { name: '更改预览' }));
  expect(planner.snapshot().courseExceptions).toHaveLength(0);
  expect(buildCalendar(planner.snapshot(), '2026-10-19', '2026-10-20', false)[0]?.date).toBe('2026-10-19');
  expect(preview.getByText(/2026-10-20 10:00/)).toBeTruthy();
  fireEvent.click(preview.getByRole('button', { name: '确认执行' }));
  await screen.findByText('已保存，可撤销');
  const first = planner.snapshot().courseExceptions[0]!;
  expect(first).toMatchObject({ originalDate: '2026-10-19', replacement: { title: '合成调课', location: '合成B202', start: '2026-10-20T10:00:00+08:00' } });
  expect(buildCalendar(planner.snapshot(), '2026-11-02', '2026-11-02', false)[0]?.start).toBe('2026-11-02T08:00:00+08:00');
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '日历' }));
  fireEvent.click(screen.getByRole('button', { name: /合成调课.*10:00/ }));
  fireEvent.click(screen.getByRole('button', { name: '编辑课程' }));
  const moved = within(screen.getByRole('dialog', { name: '编辑课程' }));
  expect((moved.getByLabelText('范围') as HTMLSelectElement).value).toBe('single');
  expect((moved.getByLabelText('原上课日期') as HTMLInputElement).value).toBe('2026-10-19');
  expect((moved.getByLabelText('调课日期') as HTMLInputElement).value).toBe('2026-10-20');
  expect((moved.getByLabelText('开始') as HTMLInputElement).value).toBe('10:00');
  expect((moved.getByLabelText('名称') as HTMLInputElement).value).toBe('合成调课');
  expect((moved.getByLabelText('地点') as HTMLInputElement).value).toBe('合成B202');
  fireEvent.change(moved.getByLabelText('调课日期'), { target: { value: '2026-10-21' } });
  fireEvent.click(moved.getByRole('button', { name: '保存并预览' }));
  preview = within(await screen.findByRole('dialog', { name: '更改预览' }));
  expect(planner.snapshot().courseExceptions[0]).toEqual(first);
  fireEvent.click(preview.getByRole('button', { name: '确认执行' }));
  await screen.findByText('已保存，可撤销');
  expect(planner.snapshot().courseExceptions).toHaveLength(1);
  expect(planner.snapshot().courseExceptions[0]).toMatchObject({ id: first.id, originalDate: '2026-10-19', replacement: { start: '2026-10-21T10:00:00+08:00' } });
  fireEvent.click(screen.getByRole('button', { name: '撤销上次操作' }));
  await screen.findByText('已撤销');
  expect(planner.snapshot().courseExceptions[0]?.replacement?.start).toBe('2026-10-20T10:00:00+08:00');
  fireEvent.click(screen.getByRole('button', { name: '撤销上次操作' }));
  await screen.findByRole('button', { name: /合成验收样例：单周课程.*08:00/ });
  expect(planner.snapshot().courseExceptions).toHaveLength(0);
  expect(buildCalendar(planner.snapshot(), '2026-10-19', '2026-11-02', false).map(i => i.start)).toEqual(['2026-10-19T08:00:00+08:00', '2026-11-02T08:00:00+08:00']);
});

it('keeps unsupported single-occurrence series edits rejected without suggesting an unrelated key fix', async () => {
  const { planner } = setup();
  const form = await editor('single', '2026-10-22');
  fireEvent.change(form.getByLabelText('星期'), { target: { value: '5' } });
  fireEvent.change(form.getByLabelText('调课日期'), { target: { value: '2026-10-23' } });
  fireEvent.click(form.getByRole('button', { name: '保存并预览' }));
  await screen.findAllByText('单次修改仅支持标题、地点和时刻；更改日期请使用调课');
  expect(screen.queryByRole('button', { name: '配置密钥' })).toBeNull();
  expect(planner.snapshot().courses[0]!.weekday).toBe(4);
  expect(planner.snapshot().courseExceptions).toHaveLength(0);
});

it('still provides key configuration for an actual missing-key error from the real controller', async () => {
  setup();
  fireEvent.change(await screen.findByLabelText('自然语言指令'), { target: { value: '合成验收样例：查日程' } });
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
  expect(await screen.findByRole('button', { name: '配置密钥' })).toBeTruthy();
});
