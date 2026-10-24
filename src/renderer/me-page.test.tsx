// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema, SettingsSchema, type DesktopAPI } from '../shared/contracts';
import { PALETTE, colorName } from '../shared/palette';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));

const repositories: Repository[] = [];
afterEach(() => { cleanup(); for (const repository of repositories.splice(0)) repository.close(); });
let seq = 0;
function setup() {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const seed = (mutations: unknown[]) => {
    const result = planner.mutate(MutationRequestSchema.parse({ operationId: `me-${++seq}`, origin: 'manual', mutations }));
    if (result.status === 'preview') planner.mutate(MutationRequestSchema.parse({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken }));
  };
  const course = (title: string, weekday: number) => ({ type: 'create', entity: 'course', values: { title, termStart: '2026-10-19', weekday, firstWeek: 1, lastWeek: 4, startTime: '08:00', endTime: '09:35', location: '合成A101' } });
  seed([course('合成高数', 4)]); seed([course('合成高数', 1)]); seed([course('合成英语', 2)]);
  seed([{ type: 'create', entity: 'goal', values: { title: '合成目标' } }]);
  let settings = planner.snapshot().settings;
  const saveSettings = vi.fn(async (request: { settings: unknown }) => { settings = SettingsSchema.parse(request.settings); return { ok: true, data: settings }; });
  const api = {
    snapshot: async () => ({ ok: true, data: { ...planner.snapshot(), settings } }),
    mutate: async (request: unknown) => ({ ok: true, data: planner.mutate(MutationRequestSchema.parse(request)) }),
    undo: async (id?: string) => ({ ok: true, data: planner.undo(id) }),
    saveSettings, onChanged: () => () => {}, onNavigate: () => () => {},
    accountState: async () => ({ ok: false, error: { code: 'INTERNAL', message: '合成', retryable: false } }), onAccountChanged: () => () => {},
    updateState: async () => ({ ok: false, error: { code: 'INTERNAL', message: '合成', retryable: false } }), onUpdateChanged: () => () => {},
  } as unknown as DesktopAPI;
  render(<App api={api} />);
  return { planner, saveSettings };
}
const openMe = async (item: string) => {
  fireEvent.click(within(await screen.findByRole('navigation', { name: '主导航' })).getByRole('button', { name: '我的' }));
  fireEvent.click(within(screen.getByRole('navigation', { name: '我的' })).getByRole('button', { name: item }));
  return screen.getByRole('region', { name: item });
};

it('groups the menu, shows one settings section at a time and still saves fields from the hidden ones', async () => {
  const { saveSettings } = setup();
  const menu = within(await (async () => { await openMe('目标'); return screen.getByRole('navigation', { name: '我的' }); })());
  expect(menu.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['规划', '采集', '设置']);
  const term = await openMe('学期与节次');
  expect(within(term).getByLabelText('学校与校区')).toBeTruthy();
  expect((within(term).getByText('AI 与费用').closest('section') as HTMLElement).hidden).toBe(true);
  fireEvent.change(within(term).getByLabelText('学校与校区'), { target: { value: '合成校区' } });
  fireEvent.click(within(term).getByRole('button', { name: '保存全部设置' }));
  await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
  expect(saveSettings.mock.calls[0]![0].settings).toMatchObject({ campus: '合成校区', model: expect.any(String) });
  expect(screen.queryByText('让日历适合你')).toBeNull();
});

it('recolors every record of a course from the palette, marks used colors, and the calendar follows', async () => {
  const { planner } = setup();
  const table = await openMe('课程表');
  const [math, english] = [planner.snapshot().courses.find(c => c.title === '合成高数')!, planner.snapshot().courses.find(c => c.title === '合成英语')!];
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  fireEvent.click(within(table).getByRole('button', { name: `合成高数的颜色：${colorName(math.color!)}` }));
  const palette = within(within(table).getByRole('group', { name: '合成高数的颜色' }));
  expect(palette.getAllByRole('button')).toHaveLength(16);
  expect(palette.getByRole('button', { name: `${colorName(english.color!)}（已被使用）` })).toBeTruthy();
  expect(palette.getByRole('button', { name: colorName(math.color!) }).getAttribute('aria-pressed')).toBe('true');
  const target = PALETTE.find(color => color.hex !== math.color && color.hex !== english.color && color.hex !== planner.snapshot().goals[0]!.color)!;
  fireEvent.click(palette.getByRole('button', { name: target.name }));
  await waitFor(() => expect(planner.snapshot().courses.filter(c => c.title === '合成高数').map(c => c.color)).toEqual([target.hex, target.hex]));
  expect(screen.queryByRole('dialog', { name: '更改预览' })).toBeNull();
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '日历' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^合成高数 08:00/ }).map(button => button.closest<HTMLElement>('.timeline-event')!.style.getPropertyValue('--c'))).toEqual([target.hex, target.hex]));
});

it('lists goals with their color and progress', async () => {
  const { planner } = setup();
  const goals = await openMe('目标');
  const goal = planner.snapshot().goals[0]!;
  expect(within(goals).getByRole('button', { name: `合成目标的颜色：${colorName(goal.color!)}` })).toBeTruthy();
  expect(within(goals).getByText('暂无任务')).toBeTruthy();
});
