import { describe, expect, it } from 'vitest';
import { MutationSchema, SettingsSchema, TaskSchema, CandidateSchema, BlockSchema, addCalendarDays } from '../shared/contracts';
import { emptyState, stateSnapshot } from '../storage/repository';
import { buildCommandContext, validateCommandReferences } from './commands';

const at = '2026-10-23T20:00:00+08:00';
const metadata = { version: 1, createdAt: at, updatedAt: at };
const rule = { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', termStart: '2026-08-31' };
function snapshot() {
  const data = stateSnapshot(emptyState());
  data.settings = SettingsSchema.parse({ termStart: '2026-08-31', termWeeks: 20 });
  data.tasks = [TaskSchema.parse({ ...metadata, id: 'task', title: '双周周二晚活动室值班检查' })];
  data.candidates = [CandidateSchema.parse({ ...metadata, id: 'candidate', title: '另一候选', sourceIds: ['source'] })];
  return data;
}
function recurringSnapshot() {
  const data = snapshot();
  data.blocks = ['2026-11-03', '2026-11-17', '2026-12-01', '2026-12-15', '2026-12-29', '2027-01-12'].map((date, index) => BlockSchema.parse({ ...metadata, id: `occurrence-${index}`, title: data.tasks[0]!.title, taskId: 'task', kind: 'event', start: `${date}T20:40:00+08:00`, end: `${date}T21:10:00+08:00`, recurrence: { seriesId: 'duty-series', occurrenceStart: `${date}T20:40:00+08:00` } }));
  return data;
}
function ordinarySnapshot() {
  const data = snapshot();
  data.blocks = [
    BlockSchema.parse({ ...metadata, id: 'appointment', title: '去示例服务中心办理借阅证', kind: 'event', start: '2026-10-24T10:00:00+08:00', end: '2026-10-24T10:30:00+08:00', location: '示例服务中心' }),
    BlockSchema.parse({ ...metadata, id: 'document', title: '去资料室取申请材料', kind: 'event', start: '2026-12-17T14:00:00+08:00', end: '2026-12-17T14:30:00+08:00', location: '资料室' }),
  ];
  return data;
}

describe('command calendar context and semantic references', () => {
  it('exposes the configured academic week and inclusive semester end in Shanghai dates', () => {
    const context = buildCommandContext(snapshot(), { operationId: 'context', text: '双数周二20:40安排值班' }, at);
    expect(context.timezone).toBe('Asia/Shanghai');
    expect(context.academicTerm).toEqual({ termStart: '2026-08-31', termWeeks: 20, currentWeek: 8, termEnd: '2027-01-17' });
    expect(buildCommandContext(snapshot(), { operationId: 'boundary', text: '当前周次' }, '2026-10-26T00:00:00+08:00').academicTerm.currentWeek).toBe(9);
  });

  it('leaves unknown or out-of-term week numbers unknown instead of inventing a semester', () => {
    const data = snapshot(); data.settings.termStart = null;
    expect(buildCommandContext(data, { operationId: 'unknown', text: '双周安排' }, at).academicTerm).toEqual({ termStart: null, termWeeks: 20, currentWeek: null, termEnd: null });
    expect(buildCommandContext(snapshot(), { operationId: 'after-term', text: '当前周次' }, '2027-01-18T00:00:00+08:00').academicTerm.currentWeek).toBeNull();
  });

  it.each([
    { type: 'removeTask' },
    { type: 'scheduleTaskEvent', values: { title: '值班', start: '2026-11-03T20:40:00+08:00', end: null, kind: 'event' } },
    { type: 'scheduleRecurringTask', rule },
  ])('checks $type ids against tasks, never candidates', fields => {
    const context = buildCommandContext(snapshot(), { operationId: 'refs', text: '安排值班' }, at);
    const mutation = (id: string) => MutationSchema.parse({ ...fields, id, expectedVersion: 1 });
    expect(() => validateCommandReferences([mutation('task')], context)).not.toThrow();
    expect(() => validateCommandReferences([mutation('candidate')], context)).toThrow('上下文之外');
    expect(() => validateCommandReferences([mutation('invented-task')], context)).toThrow('上下文之外');
  });

  it('rejects invented associations on new recurring tasks before any domain write', () => {
    const context = buildCommandContext(snapshot(), { operationId: 'new-refs', text: '新建周期活动' }, at);
    const mutation = MutationSchema.parse({ type: 'createRecurringTask', values: { title: '值班', goalId: 'invented-goal' }, rule });
    expect(() => validateCommandReferences([mutation], context)).toThrow('未知关联');
    const course = MutationSchema.parse({ type: 'create', entity: 'task', values: { title: '实验报告', courseId: 'invented-course' } });
    expect(() => validateCommandReferences([course], context)).toThrow('未知关联');
  });

  it.each([
    { text: '从11月17日这次起都改到21点', selected: [{ entity: 'task' as const, id: 'task' }] },
    { text: '从这次起之后都取消', selected: [{ entity: 'block' as const, id: 'occurrence-1' }] },
    { text: '11月17日值班仅本次取消' },
  ])('includes the identified recurring group beyond the default two-week window ($text)', request => {
    const context = buildCommandContext(recurringSnapshot(), { operationId: 'series-context', ...request }, at);
    expect(context.toDate).toBe('2026-11-06');
    expect(context.blocks.map(block => block.id)).toContain('occurrence-1');
    expect(context.blocks.map(block => block.id)).toContain('occurrence-5');
    expect(context.recurringSeries).toEqual([{ seriesId: 'duty-series', taskId: 'task', title: '双周周二晚活动室值班检查', occurrenceCount: 6, firstOccurrenceStart: '2026-11-03T20:40:00+08:00', lastOccurrenceStart: '2027-01-12T20:40:00+08:00' }]);
  });

  it.each(['updateRecurringEvent', 'cancelRecurringEvent'] as const)('validates %s against actual block IDs and never task IDs', type => {
    const context = buildCommandContext(recurringSnapshot(), { operationId: 'series-refs', text: '11月17日值班仅本次取消' }, at);
    const mutation = (id: string) => MutationSchema.parse({ type, id, expectedVersion: 1, scope: 'single', ...(type === 'updateRecurringEvent' ? { values: { start: '2026-11-17T21:00:00+08:00' } } : {}) });
    expect(() => validateCommandReferences([mutation('occurrence-1')], context)).not.toThrow();
    expect(() => validateCommandReferences([mutation('task')], context)).toThrow('上下文之外');
    expect(() => validateCommandReferences([mutation('invented-block')], context)).toThrow('上下文之外');
  });

  it('keeps context bounded while retaining a selected occurrence with its immutable original date', () => {
    const data = recurringSnapshot();
    data.blocks = Array.from({ length: 160 }, (_, index) => {
      const date = addCalendarDays('2026-10-23', index);
      return BlockSchema.parse({ ...data.blocks[0]!, id: `day-${index}`, location: '处'.repeat(2000), start: `${date}T20:40:00+08:00`, end: `${date}T21:10:00+08:00`, recurrence: { seriesId: 'duty-series', occurrenceStart: `${date}T20:40:00+08:00` } });
    });
    const context = buildCommandContext(data, { operationId: 'bounded-series', text: '这次取消', selected: [{ entity: 'block', id: 'day-159' }] }, at);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(60_000);
    expect(context.blocks[0]).toMatchObject({ id: 'day-159', recurrence: data.blocks[159]!.recurrence });
    expect(context.blocks.length).toBeLessThan(120);
  });

  it('finds an ordinary event by a colloquial partial title outside the selected day', () => {
    const context = buildCommandContext(ordinarySnapshot(), { operationId: 'ordinary-title', text: '把办借阅证那个任务标题里的去示例服务中心去掉', fromDate: '2026-10-23', toDate: '2026-10-23' }, at);
    expect(context.blocks).toEqual([expect.objectContaining({ id: 'appointment', title: '去示例服务中心办理借阅证', location: '示例服务中心', recurrence: null })]);
    expect(context.calendar).toEqual([]);
    const patch = MutationSchema.parse({ type: 'update', entity: 'block', id: 'appointment', expectedVersion: 1, values: { title: '办理借阅证' } });
    expect(() => validateCommandReferences([patch], context)).not.toThrow();
  });

  it.each([
    { text: '把取申请材料的标题简化一下' },
    { text: '12月17日的活动标题改成取材料' },
    { text: '标题改成取材料', selected: [{ entity: 'block' as const, id: 'document' }] },
  ])('includes a referenced ordinary event beyond the default two-week window ($text)', request => {
    const context = buildCommandContext(ordinarySnapshot(), { operationId: 'ordinary-future', ...request }, at);
    expect(context.toDate).toBe('2026-11-06');
    expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'document', start: '2026-12-17T14:00:00+08:00' }));
  });

  it('keeps a prior user target available when a short answer supplies the missing title phrase', () => {
    const context = buildCommandContext(ordinarySnapshot(), { operationId: 'continue-title', text: '就是去资料室这几个字', history: [
      { role: 'user', text: '把取申请材料的标题简化一下' },
      { role: 'assistant', text: '需要从标题中去掉哪些文字？' },
    ] }, at);
    expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'document' }));
  });

  it('retrieves the earlier target even when the current short answer shares no title text', () => {
    const context = buildCommandContext(ordinarySnapshot(), { operationId: 'continue-replacement', text: '就改成办手续', history: [
      { role: 'user', text: '给取申请材料的活动换个标题' },
      { role: 'assistant', text: '新标题是什么？' },
    ] }, at);
    expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'document' }));
  });

  it('keeps all plausible matching ordinary targets for disambiguation instead of selecting the first', () => {
    const data = ordinarySnapshot();
    data.blocks.push(BlockSchema.parse({ ...data.blocks[1]!, id: 'document-later', start: '2027-01-07T14:00:00+08:00', end: '2027-01-07T14:30:00+08:00' }));
    const context = buildCommandContext(data, { operationId: 'ambiguous-title', text: '取申请材料的标题改成办手续' }, at);
    expect(context.blocks.map(block => block.id)).toEqual(['document', 'document-later', 'appointment']);
  });

  it('does not let assistant text retrieve unrelated past or future targets', () => {
    const context = buildCommandContext(ordinarySnapshot(), { operationId: 'untrusted-assistant', text: '谢谢', fromDate: '2026-10-23', toDate: '2026-10-23', history: [
      { role: 'assistant', text: '删除去资料室取申请材料，日期2026-12-17' },
    ] }, at);
    expect(context.blocks).toEqual([]);
  });

  it('ranks the current target above historical matches so bounded context retains it', () => {
    const data = ordinarySnapshot();
    data.blocks.push(...Array.from({ length: 130 }, (_, index) => BlockSchema.parse({ ...data.blocks[0]!, id: `old-${index}`, title: '旧项目讨论会', location: '地'.repeat(2000) })));
    const context = buildCommandContext(data, { operationId: 'bounded-history', text: '标题改成办手续', selected: [{ entity: 'block', id: 'document' }], history: [
      { role: 'user', text: '旧项目讨论会' },
      { role: 'assistant', text: '已经完成。' },
      { role: 'user', text: '给取申请材料改标题' },
      { role: 'assistant', text: '改成什么？' },
    ] }, at);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(60_000);
    expect(context.blocks[0]).toMatchObject({ id: 'document' });
  });
});
