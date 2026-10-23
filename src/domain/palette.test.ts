import { describe, expect, it } from 'vitest';
import { PALETTE, PALETTE_COLORS, PRIMARY_COLOR_COUNT } from '../shared/palette';
import { ColorSchema, CourseSchema, GoalSchema, SettingsSchema } from '../shared/contracts';
import { assignMissingColors, occupiedColors, pickColor } from './palette';
import { emptyState } from '../storage/repository';

const meta = { version: 1, createdAt: '2026-09-01T08:00:00+08:00', updatedAt: '2026-09-01T08:00:00+08:00' };
const course = (id: string, title: string, extra: Record<string, unknown> = {}) => CourseSchema.parse({
  ...meta, id, title, weekday: 1, startTime: '08:00', endTime: '09:35', firstWeek: 1, lastWeek: 18, termStart: '2026-08-31', ...extra,
});
const goal = (id: string, extra: Record<string, unknown> = {}) => GoalSchema.parse({ ...meta, id, title: `目标${id}`, ...extra });

describe('palette', () => {
  it('has 16 distinct colors with 12 primaries and accepts only palette values', () => {
    expect(PALETTE).toHaveLength(16);
    expect(new Set(PALETTE_COLORS).size).toBe(16);
    expect(PRIMARY_COLOR_COUNT).toBe(12);
    expect(ColorSchema.safeParse('#3b5b9a').success).toBe(true);
    expect(ColorSchema.safeParse('#ff0000').success).toBe(false);
  });

  it('starts with the first color and then prefers the color farthest from those in use', () => {
    expect(pickColor([])).toBe(PALETTE_COLORS[0]);
    const second = pickColor([PALETTE_COLORS[0]]);
    expect(second).not.toBe(PALETTE_COLORS[0]);
    expect(PALETTE_COLORS.slice(0, PRIMARY_COLOR_COUNT)).toContain(second);
  });

  it('uses spare colors only after all 12 primaries are taken, then the least used color', () => {
    const primaries = PALETTE_COLORS.slice(0, PRIMARY_COLOR_COUNT);
    expect(PALETTE_COLORS.slice(PRIMARY_COLOR_COUNT)).toContain(pickColor(primaries));
    expect(pickColor([...PALETTE_COLORS, ...PALETTE_COLORS.slice(1)])).toBe(PALETTE_COLORS[0]);
  });
});

describe('color occupancy', () => {
  const settings = SettingsSchema.parse({ termStart: '2026-08-31' });
  it('counts current-term courses and active goals only', () => {
    const colors = occupiedColors({
      settings,
      courses: [
        course('a', '高等数学', { color: PALETTE_COLORS[0] }),
        course('b', '旧课', { color: PALETTE_COLORS[1], termStart: '2026-02-23' }),
        course('c', '短课', { color: PALETTE_COLORS[2], lastWeek: 2 }),
      ],
      goals: [goal('g1', { color: PALETTE_COLORS[3] }), goal('g2', { color: PALETTE_COLORS[4], status: 'completed' })],
    }, '2026-10-22');
    expect(colors).toEqual([PALETTE_COLORS[0], PALETTE_COLORS[3]]);
  });
});

describe('assignMissingColors', () => {
  it('fills empty colors, shares one color per course title and patches matching undo images', () => {
    const state = emptyState();
    state.settings = SettingsSchema.parse({ termStart: '2026-08-31' });
    const monday = course('m', '高等数学'), wednesday = course('w', '高等数学', { weekday: 3 }), physics = course('p', '大学物理');
    state.entities.course.push(monday, wednesday, physics);
    state.entities.goal.push(goal('g'));
    state.journal.push({ id: 'j', operationId: 'o', createdAt: meta.createdAt, origin: 'manual', message: '', changes: [], undoneAt: null, undoable: true,
      details: [{ entity: 'course', id: 'p', before: null, after: structuredClone(physics) }] });
    assignMissingColors(state, '2026-10-22');
    const [m, w, p] = state.entities.course as ReturnType<typeof course>[];
    expect(m!.color).toBe(PALETTE_COLORS[0]);
    expect(w!.color).toBe(m!.color);
    expect(p!.color).not.toBeNull();
    expect(p!.color).not.toBe(m!.color);
    expect((state.entities.goal[0] as ReturnType<typeof goal>).color).not.toBeNull();
    expect((state.journal[0]!.details[0]!.after as ReturnType<typeof course>).color).toBe(p!.color);
  });

  it('keeps existing colors and versions unchanged', () => {
    const state = emptyState();
    state.entities.course.push(course('a', '线性代数', { color: PALETTE_COLORS[5] }));
    assignMissingColors(state, '2026-10-22');
    expect(state.entities.course[0]).toMatchObject({ color: PALETTE_COLORS[5], version: 1 });
  });
});
