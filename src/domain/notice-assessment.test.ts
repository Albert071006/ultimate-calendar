import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { BlockInputSchema } from '../shared/contracts';
const repos: Repository[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
function fixture() {
  const repo = createRepository(':memory:'); repos.push(repo);
  const planner = createPlanner(repo, { automaticBackup: () => {} });
  const course = repo.writeInternal({ operationId: 'course', changes: [{ entity: 'course', values: {
    title: '网球', weekday: 3, startTime: '16:00', endTime: '17:40', firstWeek: 1, lastWeek: 16, termStart: '2026-09-07',
  } }] }).entities[0]!;
  const text = '网球课期末考核下周三（11月18日）下午 4 点到体育馆参加。';
  const source = repo.writeInternal({ operationId: 'source', changes: [{ entity: 'source', values: {
    kind: 'text', text, sentAt: '2026-11-13T12:00:00+08:00', importedAt: '2026-11-13T12:00:00+08:00',
  } }] }).entities[0]!;
  const candidate = repo.writeInternal({ operationId: 'notice', changes: [{ entity: 'candidate', values: {
    title: '参加网球课期末考核', sourceIds: [source.id], sourceQuote: text, eventStart: null,
    temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: '下周三（11月18日）下午 4 点' }],
  } }] }).entities[0]!;
  return { repo, planner, course, candidate };
}
describe('course assessment acceptance', () => {
  it('recovers a spaced clock on acceptance and uses its own lesson without a false conflict; undo restores original evidence', () => {
    const { planner, candidate } = fixture();
    const request = { operationId: 'accept', origin: 'manual' as const, confirmed: false, mutations: [{ type: 'acceptCandidate' as const, id: candidate.id, expectedVersion: candidate.version }] };
    const result = planner.mutate(request);
    expect(result).toMatchObject({ status: 'applied', conflicts: [] });
    expect(planner.snapshot().blocks).toMatchObject([{ title: '参加网球课期末考核', start: '2026-11-18T16:00:00+08:00' }]);
    expect(planner.mutate(request)).toEqual(result);
    expect(planner.undo()).toMatchObject({ status: 'applied' });
    expect(planner.snapshot().candidates[0]).toMatchObject({ status: 'pending', eventStart: null });
  });

  it.each([
    { title: '复习网球期末考试', kind: 'event', end: '2026-11-18T16:30:00+08:00' },
    { title: '网球考试练习', kind: 'work', end: '2026-11-18T16:30:00+08:00' },
    { title: '参加网球课期末考核', kind: 'event', end: '2026-11-18T18:00:00+08:00' },
    { title: '参加另一门课考试', kind: 'event', end: '2026-11-18T16:30:00+08:00' },
    { title: '参加网球教练资格考试', kind: 'event', end: '2026-11-18T16:30:00+08:00' },
    { title: '网球课期末考试说明会', kind: 'event', end: '2026-11-18T16:30:00+08:00' },
  ] as const)('retains real overlap warnings for $title / $kind / $end', ({ title, kind, end }) => {
    const { planner } = fixture();
    const result = planner.mutate({ operationId: 'activity', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'block', values: BlockInputSchema.parse({ title, kind, start: '2026-11-18T16:00:00+08:00', end }) }] });
    expect(result).toMatchObject({ status: 'preview', conflicts: [{ kind: 'time' }] });
  });

  it('still warns about another course at the same time', () => {
    const { repo, planner, candidate } = fixture();
    repo.writeInternal({ operationId: 'second-course', changes: [{ entity: 'course', values: {
      title: '合成数学', weekday: 3, startTime: '16:00', endTime: '17:40', firstWeek: 1, lastWeek: 16, termStart: '2026-09-07',
    } }] });
    const result = planner.mutate({ operationId: 'accept', origin: 'manual', confirmed: false, mutations: [{ type: 'acceptCandidate', id: candidate.id, expectedVersion: candidate.version }] });
    expect(result).toMatchObject({ status: 'preview' });
    if (result.status === 'preview') {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.message).toContain('合成数学');
      expect(result.conflicts[0]?.message).toContain('参加网球课期末考核');
    }
  });
});
