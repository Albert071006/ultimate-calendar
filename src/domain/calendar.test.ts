import { afterEach, expect, it, vi } from 'vitest';
import { BlockSchema, CandidateSchema, SnapshotSchema } from '../shared/contracts';
import { buildCalendar } from './calendar';

afterEach(() => vi.restoreAllMocks());
it('exposes pending event intervals without marking time busy, hides expired or snoozed candidates, and retains deadline markers', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T08:00:00+08:00'));
  const metadata = { version: 1, createdAt: '2026-10-22T08:00:00+08:00', updatedAt: '2026-10-22T08:00:00+08:00', sourceIds: ['source'] };
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false }, candidates: [
    CandidateSchema.parse({ ...metadata, id: 'future', title: '待确认活动', deadline: { date: '2026-10-23', time: '10:25' }, eventStart: '2026-10-23T14:00:00+08:00', eventEnd: '2026-10-23T15:35:00+08:00' }),
    CandidateSchema.parse({ ...metadata, id: 'expired', title: '已结束', eventStart: '2026-10-22T14:00:00+08:00', eventEnd: '2026-10-22T15:35:00+08:00' }),
    CandidateSchema.parse({ ...metadata, id: 'snoozed', title: '稍后处理', eventStart: '2026-10-23T19:00:00+08:00', eventEnd: '2026-10-23T20:35:00+08:00', snoozedUntil: '2026-10-23T10:00:00+08:00' }),
  ] });
  expect(buildCalendar(snapshot, '2026-10-22', '2026-10-23', true)).toMatchObject([
    { id: 'candidate:future', start: '2026-10-23T10:25:00+08:00', end: null, busy: false, pending: true },
    { id: 'candidate-event:future', start: '2026-10-23T14:00:00+08:00', end: '2026-10-23T15:35:00+08:00', busy: false, pending: true },
  ]);
  expect(buildCalendar(snapshot, '2026-10-22', '2026-10-23', false)).toEqual([]);
});

it('gives a legacy start-only activity a busy 30-minute slot, including the next day, without changing stored source timing', () => {
  const block = BlockSchema.parse({ id: 'late-event', version: 1, createdAt: '2026-10-22T08:00:00+08:00', updatedAt: '2026-10-22T08:00:00+08:00', title: '晚间活动', kind: 'event', start: '2026-10-23T23:50:00+08:00', end: null });
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [block], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const expected = [{ id: block.id, start: '2026-10-23T23:50:00+08:00', end: '2026-10-24T00:20:00+08:00', busy: true }];
  expect(buildCalendar(snapshot, '2026-10-23', '2026-10-23', false)).toMatchObject(expected);
  expect(buildCalendar(snapshot, '2026-10-24', '2026-10-24', false)).toMatchObject(expected);
  expect(buildCalendar(snapshot, '2026-10-25', '2026-10-25', false)).toEqual([]);
  expect(snapshot.blocks[0]!.end).toBeNull();
});

it('keeps an explicitly known 20-minute activity and work interval unchanged', () => {
  const metadata = { version: 1, createdAt: '2026-10-22T08:00:00+08:00', updatedAt: '2026-10-22T08:00:00+08:00' };
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [
    BlockSchema.parse({ ...metadata, id: 'short-event', title: '短会', kind: 'event', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T09:20:00+08:00' }),
    BlockSchema.parse({ ...metadata, id: 'work', title: '写报告', kind: 'work', start: '2026-10-23T09:20:00+08:00', end: '2026-10-23T10:45:00+08:00' }),
  ], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  expect(buildCalendar(snapshot, '2026-10-23', '2026-10-23', false)).toMatchObject([
    { id: 'short-event', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T09:20:00+08:00', busy: true },
    { id: 'work', start: '2026-10-23T09:20:00+08:00', end: '2026-10-23T10:45:00+08:00', busy: true },
  ]);
});
