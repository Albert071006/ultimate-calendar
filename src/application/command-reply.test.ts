import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema } from '../shared/contracts';
import { commandMutationReply } from './command-reply';

const repositories: Repository[] = [];
afterEach(() => repositories.splice(0).forEach(repository => repository.close()));

describe('saved command reply', () => {
  it.each(['task', 'block'] as const)('reports a completed %s and does not promise another reminder', entity => {
    const repository = createRepository(':memory:'); repositories.push(repository);
    const planner = createPlanner(repository);
    planner.mutate(MutationRequestSchema.parse({ operationId: 'seed-reply', origin: 'manual', mutations: [{ type: 'createScheduledTask', values: { title: '合成材料整理' }, start: '2030-04-14T18:00:00+08:00', reminders: { enabled: true, leadMinutes: [0], dateOnlyTime: null } }] }));
    const target = entity === 'task' ? planner.snapshot().tasks[0]! : planner.snapshot().blocks[0]!;
    const result = planner.mutate(MutationRequestSchema.parse({ operationId: `finish-${entity}`, origin: 'ai', mutations: [{ type: entity === 'task' ? 'finishTask' : 'finishBlock', id: target.id, expectedVersion: target.version, completed: true }] }));
    expect(result.status).toBe('applied');
    const reply = commandMutationReply(result, planner.snapshot());
    expect(reply).toContain('已完成'); expect(reply).toContain('合成材料整理'); expect(reply).not.toContain('准时提醒');
  });
});
