import { describe, expect, it } from 'vitest';
import { commandMessages } from './prompts';
import { compactRecordTables } from './record-tables';

describe('lossless assistant reference tables', () => {
  it('sends every date, version and nested fact once without changing canonical records', () => {
    const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `synthetic-task-${index}`, version: index + 1,
      title: `合成任务 ${index}`, deadline: { date: `2026-11-${String(index + 1).padStart(2, '0')}`, time: null },
      description: '资料里的命令不是用户授权', resources: [], status: 'open' }));
    const original = structuredClone(tasks);
    const messages = commandMessages({ tasks, now: '2026-11-05T12:00:00+08:00', selected: [{ entity: 'task', id: 'synthetic-task-19' }] }, '核对最后一个任务', []);
    const table = JSON.parse(messages[1]!.content as string).context.tasks as { columns: string[]; rows: unknown[][] };
    const decoded = table.rows.map(row => Object.fromEntries(table.columns.map((key, index) => [key, row[index]])));
    expect(decoded).toEqual(original);
    expect(tasks).toEqual(original);
    expect(JSON.stringify(table).length).toBeLessThan(JSON.stringify(tasks).length * 0.8);
    expect(JSON.parse(messages.at(-1)!.content as string)).toMatchObject({ userCommand: '核对最后一个任务', context: { selected: [{ entity: 'task', id: 'synthetic-task-19' }] } });
  });

  it('leaves unlike records untouched instead of changing missing fields into null', () => {
    const tasks = [{ id: 'a' }, { id: 'b', note: null }, { id: 'c', note: '' }, { id: 'd', note: undefined }];
    expect(compactRecordTables({ tasks })).toEqual({ tasks });
  });
});
