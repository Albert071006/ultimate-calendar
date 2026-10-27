import { z } from 'zod';
import { GoalInputSchema, TaskInputSchema, InstantSchema, ReminderConfigSchema, TitleSchema, IdSchema, type ApiResult } from './contracts';
import { ResourceReferenceSchema } from './resources';
import { PlanBasisSchema } from './plan-context';

export const MAX_PLAN_FILE_BYTES = 1024 * 1024;
const localId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, '编号须为 1–80 位字母、数字、点、下划线或短横线');
const refs = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)).max(50).default([]);
const goal = GoalInputSchema.omit({ resources: true }).extend({ id: localId, resourceRefs: refs });
const task = TaskInputSchema.omit({ resources: true, goalId: true, candidateId: true }).extend({
  id: localId, goalRef: localId.optional(), goalId: IdSchema.optional(), resourceRefs: refs,
}).refine(value => !(value.goalRef && value.goalId), 'goalRef 与 goalId 只能填写一个');
const block = z.strictObject({ id: localId, title: TitleSchema, start: InstantSchema, end: InstantSchema,
  kind: z.enum(['work', 'event']).default('work'), taskRef: localId.optional(), taskId: IdSchema.optional(),
  location: z.string().max(2000).default(''), resourceRefs: refs,
  reminders: ReminderConfigSchema.default({ enabled: true, leadMinutes: null, dateOnlyTime: null }),
}).refine(value => Date.parse(value.end) > Date.parse(value.start), '结束时间必须晚于开始时间')
  .refine(value => !(value.taskRef && value.taskId), 'taskRef 与 taskId 只能填写一个');

type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : T[K]>;
};
function nonemptyPatch<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => {
    const validator = field as z.ZodType;
    const inner = (validator instanceof z.ZodDefault ? validator.removeDefault() : validator) as z.ZodType;
    return [key, inner.optional()];
  })) as PatchShape<T>;
  return z.strictObject(shape).refine(value => Object.values(value).some(child => child !== undefined), '修改内容不能为空');
}
// Reminder replacement must be explicit too: a partial object must not reset omitted settings.
const revisionReminders = ReminderConfigSchema.extend({
  enabled: ReminderConfigSchema.shape.enabled.removeDefault(),
  leadMinutes: ReminderConfigSchema.shape.leadMinutes.removeDefault(),
  dateOnlyTime: ReminderConfigSchema.shape.dateOnlyTime.removeDefault(),
});
const updateIdentity = { id: localId, targetId: IdSchema, expectedVersion: z.number().int().positive() };
export const PlanUpdateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...updateIdentity, kind: z.literal('goal'), values: nonemptyPatch(GoalInputSchema.omit({ resources: true }).extend({ resourceRefs: refs })) }),
  z.strictObject({ ...updateIdentity, kind: z.literal('task'), values: nonemptyPatch(TaskInputSchema.pick({ title: true, description: true, deadline: true, scheduleMode: true }).extend({ reminders: revisionReminders, resourceRefs: refs })) }),
  z.strictObject({ ...updateIdentity, kind: z.literal('block'), values: nonemptyPatch(z.strictObject({ title: TitleSchema, start: InstantSchema, end: InstantSchema, location: z.string().max(2000), reminders: revisionReminders, resourceRefs: refs })) }),
]);
export const PlanDeletionSchema = z.strictObject({ ...updateIdentity, kind: z.enum(['task', 'block']) });
export type PlanUpdate = z.infer<typeof PlanUpdateSchema>;
export type PlanDeletion = z.infer<typeof PlanDeletionSchema>;

/** A file is immutable for retries. v1/v2 create; v3 may explicitly revise selected existing records. */
export const PlanFileSchema = z.strictObject({
  format: z.literal('ultimate-calendar-plan'), version: z.union([z.literal(1), z.literal(2), z.literal(3)]), timezone: z.literal('Asia/Shanghai'),
  basis: PlanBasisSchema.optional(),
  planId: localId, title: TitleSchema,
  resources: z.array(ResourceReferenceSchema).max(500).default([]),
  goals: z.array(goal).max(500).default([]), tasks: z.array(task).max(500).default([]), blocks: z.array(block).max(500).default([]),
  // Do not default these fields: old v1/v2 parsed files retain their exact receipt fingerprint.
  updates: z.array(PlanUpdateSchema).max(500).optional(), deletions: z.array(PlanDeletionSchema).max(500).optional(),
}).superRefine((plan, ctx) => {
  if ((plan.version !== 1) !== Boolean(plan.basis)) ctx.addIssue({ code: 'custom', message: 'v2、v3 必须原样携带上下文 basis；v1 不接受 basis', path: ['basis'] });
  if (plan.version !== 3 && (plan.updates !== undefined || plan.deletions !== undefined)) ctx.addIssue({ code: 'custom', message: '只有 v3 支持 updates 和 deletions', path: ['updates'] });
  if (plan.version === 3 && plan.goals.length) ctx.addIssue({ code: 'custom', message: '修订计划必须沿用原目标，goals 应为空', path: ['goals'] });
  const total = plan.goals.length + plan.tasks.length + plan.blocks.length + (plan.updates?.length ?? 0) + (plan.deletions?.length ?? 0);
  if (!total || total > 500) ctx.addIssue({ code: 'custom', message: '每份计划需有 1–500 条新增、修改或删除条目', path: ['tasks'] });
  for (const key of ['goals', 'tasks', 'blocks', 'resources', 'updates', 'deletions'] as const) {
    const ids = new Set<string>();
    plan[key]?.forEach((item, index) => {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', message: '编号重复', path: [key, index, 'id'] });
      ids.add(item.id);
    });
  }
  const resources = new Set(plan.resources.map(value => value.id));
  for (const key of ['goals', 'tasks', 'blocks'] as const) plan[key].forEach((item, index) => {
    if (new Set(item.resourceRefs).size !== item.resourceRefs.length) ctx.addIssue({ code: 'custom', message: '资料引用重复', path: [key, index, 'resourceRefs'] });
    item.resourceRefs.forEach(ref => { if (!resources.has(ref)) ctx.addIssue({ code: 'custom', message: `资料 ${ref} 不存在`, path: [key, index, 'resourceRefs'] }); });
  });
  const revisedTargets = new Set<string>();
  for (const key of ['updates', 'deletions'] as const) plan[key]?.forEach((item, index) => {
    const target = `${item.kind}:${item.targetId}`;
    if (revisedTargets.has(target)) ctx.addIssue({ code: 'custom', message: '同一记录只能修改或删除一次', path: [key, index, 'targetId'] });
    revisedTargets.add(target);
  });
  plan.updates?.forEach((item, index) => {
    const referenced = item.values.resourceRefs;
    if (!referenced) return;
    if (new Set(referenced).size !== referenced.length) ctx.addIssue({ code: 'custom', message: '资料引用重复', path: ['updates', index, 'values', 'resourceRefs'] });
    referenced.forEach(ref => { if (!resources.has(ref)) ctx.addIssue({ code: 'custom', message: `资料 ${ref} 不存在`, path: ['updates', index, 'values', 'resourceRefs'] }); });
  });
  plan.tasks.forEach((item, index) => { if (item.goalRef && !plan.goals.some(value => value.id === item.goalRef)) ctx.addIssue({ code: 'custom', message: 'goalRef 未对应文件中的目标', path: ['tasks', index, 'goalRef'] }); });
  plan.blocks.forEach((item, index) => { if (item.taskRef && !plan.tasks.some(value => value.id === item.taskRef)) ctx.addIssue({ code: 'custom', message: 'taskRef 未对应文件中的任务', path: ['blocks', index, 'taskRef'] }); });
});
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type PlanFileInput = z.input<typeof PlanFileSchema>;
/** Version-specific schemas for external agents; all pass the same runtime checks. */
export const PlanFileV1Schema = PlanFileSchema.safeExtend({ version: z.literal(1), basis: z.never().optional(), updates: z.never().optional(), deletions: z.never().optional() });
export const PlanFileV2Schema = PlanFileSchema.safeExtend({ version: z.literal(2), basis: PlanBasisSchema, updates: z.never().optional(), deletions: z.never().optional() });
export const PlanFileV3Schema = PlanFileSchema.safeExtend({ version: z.literal(3), basis: PlanBasisSchema });

export const PlanImportRowSchema = z.strictObject({
  kind: z.enum(['goal', 'task', 'block']), localId: localId, title: z.string(),
  state: z.enum(['new', 'update', 'delete', 'existing', 'blocked']), detail: z.string(), existingId: z.string().optional(),
  action: z.enum(['create', 'update', 'delete']).optional(),
  changes: z.array(z.strictObject({ field: z.string(), before: z.string(), after: z.string() })).optional(),
  start: z.string().optional(), end: z.string().optional(),
});
export const PlanImportPreviewSchema = z.strictObject({
  token: z.string(), planId: localId, title: z.string(), expiresAt: z.string(),
  rows: z.array(PlanImportRowSchema), conflicts: z.array(z.string()), warnings: z.array(z.string()),
  resources: z.array(ResourceReferenceSchema),
  canVerifyPending: z.boolean().optional(),
  requiresDeletionApproval: z.boolean().optional(),
});
export type PlanImportPreview = z.infer<typeof PlanImportPreviewSchema>;
export type PlanImportRow = z.infer<typeof PlanImportRowSchema>;
export const PlanImportConfirmSchema = z.strictObject({ token: z.string().min(1), allowConflicts: z.boolean().default(false), allowDeletions: z.boolean().default(false) });
export const PlanImportResultSchema = z.strictObject({ status: z.enum(['complete', 'partial']), message: z.string(), applied: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), preview: PlanImportPreviewSchema.optional() });
export type PlanImportResult = z.infer<typeof PlanImportResultSchema>;
export interface PlanImportDesktopAPI {
  planImportOpen(): Promise<ApiResult<PlanImportPreview | null>>;
  planImportConfirm(request: z.input<typeof PlanImportConfirmSchema>): Promise<ApiResult<PlanImportResult>>;
  planImportTemplate(): Promise<ApiResult<{ saved: boolean }>>;
}

export const PLAN_FILE_EXAMPLE: PlanFileInput = {
  format: 'ultimate-calendar-plan', version: 1, timezone: 'Asia/Shanghai', planId: 'demo-study-2026-11-v1', title: '示例：一周学习计划',
  resources: [{ id: 'course-notes', kind: 'web', name: '示例课程资料（请替换）', url: 'https://example.com/course' }],
  goals: [{ id: 'learn-basics', title: '掌握基础知识', description: '完成阅读与练习', targetDate: '2026-11-08', resourceRefs: ['course-notes'] }],
  tasks: [{ id: 'read-chapter', goalRef: 'learn-basics', title: '阅读第一章并整理笔记', deadline: { date: '2026-11-04', time: '21:00' } }],
  blocks: [{ id: 'reading-session', taskRef: 'read-chapter', title: '第一章阅读与笔记', kind: 'work', start: '2026-11-02T19:00:00+08:00', end: '2026-11-02T20:00:00+08:00' }],
};
