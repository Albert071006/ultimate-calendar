import { describe, expect, it } from 'vitest';
import {
  CommandIntentSchema, FocusSessionInputSchema, FocusSessionSchema, MutationInputSchema, MutationRequestSchema,
  SettingsSchema, SnapshotSchema,
} from './contracts';

const start = '2026-03-01T12:00:00+08:00';
const session = { title: '合成练习', mode: 'manual', start, end: '2026-03-01T12:10:00+08:00', durationSeconds: 60 };
const meta = { id: 'session-example', version: 1, createdAt: start, updatedAt: start };

describe('settled focus sessions', () => {
  it('separates caller input from durable metadata and defaults optional fields', () => {
    expect(FocusSessionInputSchema.parse(session)).toEqual({
      ...session, plannedMinutes: null, completedTarget: true, courseId: null, goalId: null, taskId: null, blockId: null, note: '',
    });
    expect(FocusSessionSchema.parse({ ...session, ...meta })).toMatchObject(meta);
    expect(FocusSessionSchema.safeParse(session).success).toBe(false);
    expect(FocusSessionInputSchema.safeParse({ ...session, ...meta }).success).toBe(false);
    expect(FocusSessionSchema.safeParse({ ...session, ...meta, pausedAt: start }).success).toBe(false);
  });

  it('validates active seconds against Shanghai wall time, allowing pauses and rounding the final millisecond up', () => {
    const end = '2026-03-01T12:00:59.001+08:00';
    expect(FocusSessionInputSchema.parse({ ...session, end }).durationSeconds).toBe(60);
    expect(FocusSessionInputSchema.parse({ ...session, end: '2026-03-02T12:00:00+08:00', durationSeconds: 86400 }).durationSeconds).toBe(86400);
    for (const fields of [
      { end: start }, { end: '2026-03-01T11:59:00+08:00' }, { start: '2026-03-01T04:00:00Z' },
      { durationSeconds: 59 }, { durationSeconds: 61.5 }, { end, durationSeconds: 61 },
      { end: '2026-03-03T12:00:00+08:00', durationSeconds: 86401 }, { note: 'x'.repeat(2001) }, { title: ' ' },
    ]) {
      expect(FocusSessionSchema.safeParse({ ...session, ...meta, ...fields }).success).toBe(false);
      expect(MutationInputSchema.safeParse({ type: 'createFocusSession', values: { ...session, ...fields } }).success).toBe(false);
    }
  });

  it('distinguishes reached targets, interrupted pomodoros and untargeted sessions', () => {
    const pomodoro = { ...session, mode: 'pomodoro', plannedMinutes: 1 };
    expect(FocusSessionInputSchema.parse(pomodoro).completedTarget).toBe(true);
    expect(FocusSessionInputSchema.parse({ ...pomodoro, plannedMinutes: 480, completedTarget: false }).completedTarget).toBe(false);
    for (const value of [
      { ...pomodoro, plannedMinutes: null }, { ...pomodoro, plannedMinutes: 481 }, { ...pomodoro, plannedMinutes: 2 },
      { ...session, plannedMinutes: 1 }, { ...session, mode: 'stopwatch', completedTarget: false },
    ]) expect(FocusSessionInputSchema.safeParse(value).success).toBe(false);
  });

  it('accepts versioned partial edits without resetting fields, and admits mixed planner batches', () => {
    const update = { type: 'updateFocusSession', id: meta.id, expectedVersion: 1, values: { note: '合成备注' } };
    const remove = { type: 'deleteFocusSession', id: meta.id, expectedVersion: 2 };
    expect(MutationInputSchema.parse(update)).toEqual(update);
    expect(MutationInputSchema.parse(remove)).toEqual(remove);
    for (const value of [{ ...update, values: {} }, { ...update, values: { id: 'new' } },
      { ...update, expectedVersion: undefined }, { ...remove, expectedVersion: 0 }]) {
      expect(MutationInputSchema.safeParse(value).success).toBe(false);
    }
    const create = { type: 'createFocusSession', values: session };
    expect(MutationRequestSchema.parse({ operationId: 'batch-example', origin: 'manual', mutations: [
      create, { type: 'update', entity: 'block', id: 'example-block', expectedVersion: 1, values: { completed: true } },
    ] }).mutations).toHaveLength(2);
    expect(CommandIntentSchema.safeParse({ kind: 'mutate', reply: '', mutations: [create] }).success).toBe(false);
  });
});

describe('focus defaults on existing data', () => {
  it('reads snapshots from older servers, while distinguishing absent and corrupted data', () => {
    const legacy = { schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], courses: [], goals: [],
      courseExceptions: [], preferences: [], feedback: [], journal: [], tokenUsage: [], settings: { termWeeks: 16 },
      keyStatus: { configured: false, sessionOnly: false } };
    expect(SnapshotSchema.parse(legacy)).toMatchObject({ focusSessions: [], settings: {
      termWeeks: 16, focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosBeforeLongBreak: 4, focusSoundEnabled: true,
    } });
    expect(SnapshotSchema.safeParse({ ...legacy, focusSessions: null }).success).toBe(false);
  });
  it('validates timer settings and preserves explicit choices', () => {
    const custom = { focusMinutes: 480, shortBreakMinutes: 1, longBreakMinutes: 240, pomodorosBeforeLongBreak: 24, focusSoundEnabled: false };
    expect(SettingsSchema.parse(custom)).toMatchObject(custom);
    for (const fields of [{ focusMinutes: 0 }, { focusMinutes: 481 }, { shortBreakMinutes: 121 }, { longBreakMinutes: 0 },
      { pomodorosBeforeLongBreak: 2.5 }, { focusSoundEnabled: 'false' }]) expect(SettingsSchema.safeParse(fields).success).toBe(false);
  });
});
