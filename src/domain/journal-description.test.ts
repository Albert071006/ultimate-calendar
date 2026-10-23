import { describe, expect, it } from 'vitest';
import { BlockSchema, TaskSchema, type PreviewDetail } from '../shared/contracts';
import { emptyState, parseState, stateSnapshot, summarize } from '../storage/repository';
import { describeJournal } from './journal-description';

const stamp = '2026-01-10T09:00:00+08:00';
function block(extra = {}) {
  return BlockSchema.parse({ id: 'event', version: 1, createdAt: stamp, updatedAt: stamp, title: '原活动名', kind: 'event', start: '2026-01-11T10:00:00+08:00', end: '2026-01-11T10:30:00+08:00', ...extra });
}
function describeOperation(details: PreviewDetail[], operationId = 'manual-operation') {
  return describeJournal({ operationId, message: '已保存，可撤销', details });
}

describe('durable operation descriptions', () => {
  it('describes old rename and time changes from before/after records without relying on generic saved text', () => {
    const before = block();
    const rename = describeOperation([{ entity: 'block', id: before.id, before, after: block({ title: '新活动名', version: 2 }) }]);
    expect(rename.displayTitle).toBe('重命名活动「原活动名」→「新活动名」');
    expect(rename.displayDetails).toEqual(['修改活动「新活动名」：标题 原活动名 → 新活动名']);
    const moved = describeOperation([{ entity: 'block', id: before.id, before, after: block({ start: '2026-01-11T11:10:00+08:00', end: '2026-01-11T11:40:00+08:00', version: 2 }) }]);
    expect(moved.displayTitle).toBe('调整活动「原活动名」时间');
    expect(moved.displayDetails[0]).toContain('开始 2026-01-11 10:00 → 2026-01-11 11:10');
    expect(moved.displayDetails[0]).toContain('结束 2026-01-11 10:30 → 2026-01-11 11:40');
  });

  it('identifies cancellation, completion and undo while bounding long bulk operations', () => {
    const before = block();
    const cancelled = describeOperation([{ entity: 'block', id: before.id, before, after: block({ cancelled: true, version: 2 }) }]);
    expect(cancelled.displayTitle).toBe('取消活动「原活动名」');
    const task = TaskSchema.parse({ id: 'task', version: 1, createdAt: stamp, updatedAt: stamp, title: '作业' });
    expect(describeOperation([{ entity: 'task', id: task.id, before: task, after: { ...task, status: 'done', version: 2 } }]).displayTitle).toBe('完成任务「作业」');
    const details = Array.from({ length: 25 }, (_, index): PreviewDetail => ({ entity: 'block', id: `activity-${index}`, before: null, after: block({ id: `activity-${index}`, title: `活动${index}` }) }));
    const batch = describeOperation(details, 'undo:earlier-batch');
    expect(batch.displayTitle).toBe('撤销操作 · 新增活动「活动0」等 25 条记录');
    expect(batch.displayDetails).toHaveLength(21);
    expect(batch.displayDetails.at(-1)).toBe('另有 5 条记录随此操作一起变更');
  });

  it('reads historical schema records, derives current display labels, and sorts latest first before the 100-record limit', () => {
    const state = emptyState();
    state.journal = Array.from({ length: 105 }, (_, index) => {
      const day = String(Math.floor(index / 24) + 1).padStart(2, '0');
      const hour = String(index % 24).padStart(2, '0');
      const details: PreviewDetail[] = [{ entity: 'block', id: `event-${index}`, before: null, after: block({ id: `event-${index}`, title: `活动${index}` }) }];
      return { id: `journal-${index}`, operationId: `operation-${index}`, createdAt: `2026-01-${day}T${hour}:00:00+08:00`, origin: 'manual', message: '已保存，可撤销', changes: summarize(details), details, undoneAt: null, undoable: true };
    });
    // A restored journal may not arrive in chronological row-insertion order.
    state.journal.reverse();
    const restored = parseState(state);
    const snapshot = stateSnapshot(restored);
    expect(snapshot.journal).toHaveLength(100);
    expect(snapshot.journal[0]).toMatchObject({ id: 'journal-104', displayTitle: '新增活动「活动104」' });
    expect(snapshot.journal.at(-1)?.id).toBe('journal-5');
    expect(restored.journal.every(journal => journal.displayTitle === undefined)).toBe(true);
    expect(snapshot.journal.every(journal => journal.message === '已保存，可撤销')).toBe(true);
  });
});
