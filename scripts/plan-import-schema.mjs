import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

// Generate portable docs from the same schema/defaults as the installed importer.
const output = await build({ stdin: { contents: "export { PlanFileSchema, PlanFileV1Schema, PlanFileV2Schema, PlanFileV3Schema, PLAN_FILE_EXAMPLE } from './src/shared/plan-import'; export { PlanContextSchema } from './src/shared/plan-context'; export { BusyContextSchema } from './src/shared/busy-context'; export { buildBusyContext } from './src/plan-import/busy-context'; export { buildPlanContext } from './src/plan-import/context'; export { SnapshotSchema, SettingsSchema, GoalSchema, TaskSchema, BlockSchema } from './src/shared/contracts'; export { z } from 'zod';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { PlanFileSchema, PlanFileV1Schema, PlanFileV2Schema, PlanFileV3Schema, PlanContextSchema, BusyContextSchema, PLAN_FILE_EXAMPLE, buildPlanContext, buildBusyContext, SnapshotSchema, SettingsSchema, GoalSchema, TaskSchema, BlockSchema, z } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
await mkdir('docs/schemas', { recursive: true });
for (const [name, definition] of [['calendar-plan-v1', PlanFileV1Schema], ['calendar-plan-v2', PlanFileV2Schema], ['calendar-plan-v3', PlanFileV3Schema], ['calendar-context-v1', PlanContextSchema], ['calendar-busy-v1', BusyContextSchema]]) {
  const schema = z.toJSONSchema(definition, { io: 'input' });
  schema.title = 'Ultimate Calendar ' + name;
  schema.description = 'See ../plan-file-format.md. Runtime also validates real dates, references, interval order, source identity, planning-state fingerprints and current calendar conflicts. Context files are read-only planning handoffs, never import requests.';
  await writeFile(`docs/schemas/${name}.schema.json`, JSON.stringify(schema, null, 2) + '\n');
}
await writeFile('docs/examples/study-plan.calendar-plan.json', JSON.stringify(PLAN_FILE_EXAMPLE, null, 2) + '\n');
PlanFileSchema.parse(PLAN_FILE_EXAMPLE);

// A reproducible synthetic context and its four-block delta. Never read a real profile here.
const at = '2030-04-15T08:00:00+08:00';
const metadata = id => ({ id, version: 1, createdAt: at, updatedAt: at });
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const goal = GoalSchema.parse({ ...metadata(id(100)), title: '示例英语学习目标', description: '合成资料，用于展示续排流程', targetDate: '2030-04-21', resources: [{ id: 'example-notes', name: '示例讲义', kind: 'web', url: 'https://example.com/notes' }] });
const tasks = Array.from({ length: 6 }, (_, index) => TaskSchema.parse({ ...metadata(id(index + 1)), title: `示例任务 ${index + 1}`, goalId: goal.id }));
const blocks = tasks.slice(0, 2).map((task, index) => BlockSchema.parse({ ...metadata(id(101 + index)), title: `已安排：${task.title}`, taskId: task.id, kind: 'work', start: `2030-04-${15 + index}T19:00:00+08:00`, end: `2030-04-${15 + index}T19:45:00+08:00` }));
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, goals: [goal], tasks, blocks, sources: [], candidates: [], courses: [], courseExceptions: [], preferences: [], feedback: [], journal: [], tokenUsage: [], settings: SettingsSchema.parse({}), keyStatus: { configured: false, sessionOnly: false } });
const context = buildPlanContext(snapshot, { goalId: goal.id, fromDate: '2030-04-15', toDate: '2030-04-21', instructions: '保留已有两段，为其余四项任务各补一个 45 分钟学习时段。', includeBusyTitles: false }, { kind: 'cloud', dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 });
context.basis.exportedAt = at;
const supplement = { format: 'ultimate-calendar-plan', version: 2, timezone: 'Asia/Shanghai', planId: 'demo-guarded-supplement-20300417', title: '示例：带上下文校验的四时段补录', basis: context.basis, goals: [], tasks: [], resources: [], blocks: tasks.slice(2).map((task, index) => ({ id: `session-${index + 3}`, title: `${task.title}学习`, kind: 'work', taskId: task.id, start: `2030-04-${17 + index}T19:00:00+08:00`, end: `2030-04-${17 + index}T19:45:00+08:00` })) };
PlanContextSchema.parse(context); PlanFileV2Schema.parse(supplement);
await writeFile('docs/examples/study-plan.calendar-context.json', JSON.stringify(context, null, 2) + '\n');
await writeFile('docs/examples/guarded-supplement.calendar-plan.json', JSON.stringify(supplement, null, 2) + '\n');

// Alternative to the v2 supplement above: same original records, a different user request.
const revisionContext = buildPlanContext(snapshot, { goalId: goal.id, fromDate: '2030-04-15', toDate: '2030-04-21', instructions: '保留原有任务，补充目标说明。第一项任务在 4 月 20 日 18:00 截止；第一段移到 4 月 15 日 20:00，删除第二段，并在 4 月 17 日 19:00 新增一个 45 分钟错题复盘任务和时段。', includeBusyTitles: false }, context.basis.source);
revisionContext.basis.exportedAt = at;
const revision = {
  format: 'ultimate-calendar-plan', version: 3, timezone: 'Asia/Shanghai',
  planId: 'demo-revision-20300415', title: '示例：修订现有目标并追加练习', basis: revisionContext.basis, goals: [], resources: [],
  updates: [
    { id: 'revise-goal-notes', kind: 'goal', targetId: goal.id, expectedVersion: goal.version, values: { description: '保留已有任务，补充错题复盘；本次调整前两段安排。' } },
    { id: 'revise-task-deadline', kind: 'task', targetId: tasks[0].id, expectedVersion: tasks[0].version, values: { deadline: { date: '2030-04-20', time: '18:00' } } },
    { id: 'move-first-session', kind: 'block', targetId: blocks[0].id, expectedVersion: blocks[0].version, values: { start: '2030-04-15T20:00:00+08:00', end: '2030-04-15T20:45:00+08:00' } },
  ],
  deletions: [{ id: 'remove-second-session', kind: 'block', targetId: blocks[1].id, expectedVersion: blocks[1].version }],
  tasks: [{ id: 'new-review', title: '追加错题复盘', description: '整理三条易错点并各写一个例句', goalId: goal.id }],
  blocks: [{ id: 'new-review-session', title: '错题复盘', taskRef: 'new-review', kind: 'work', start: '2030-04-17T19:00:00+08:00', end: '2030-04-17T19:45:00+08:00' }],
};
PlanContextSchema.parse(revisionContext); PlanFileV3Schema.parse(revision);
await writeFile('docs/examples/revise-existing-plan.calendar-context.json', JSON.stringify(revisionContext, null, 2) + '\n');
await writeFile('docs/examples/revise-existing-plan.calendar-plan.json', JSON.stringify(revision, null, 2) + '\n');

const busy = buildBusyContext(snapshot, { fromDate: '2030-04-15', toDate: '2030-04-21', instructions: '请避开这些忙碌时间，为一个新目标制定完整的一周计划。', includeBusyTitles: false }, context.basis.source);
busy.exportedAt = at;
BusyContextSchema.parse(busy);
await writeFile('docs/examples/planning.calendar-busy.json', JSON.stringify(busy, null, 2) + '\n');
