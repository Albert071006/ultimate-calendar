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

/** A file is an immutable creation plan. It never updates/deletes existing user records. */
export const PlanFileSchema = z.strictObject({
  format: z.literal('ultimate-calendar-plan'), version: z.union([z.literal(1), z.literal(2)]), timezone: z.literal('Asia/Shanghai'),
  basis: PlanBasisSchema.optional(),
  planId: localId, title: TitleSchema,
  resources: z.array(ResourceReferenceSchema).max(500).default([]),
  goals: z.array(goal).max(500).default([]), tasks: z.array(task).max(500).default([]), blocks: z.array(block).max(500).default([]),
}).superRefine((plan, ctx) => {
  if ((plan.version === 2) !== Boolean(plan.basis)) ctx.addIssue({ code: 'custom', message: 'v2 必须原样携带上下文 basis；v1 不接受 basis', path: ['basis'] });
  const total = plan.goals.length + plan.tasks.length + plan.blocks.length;
  if (!total || total > 500) ctx.addIssue({ code: 'custom', message: '每份计划需有 1–500 条目标、任务或时段', path: ['tasks'] });
  for (const key of ['goals', 'tasks', 'blocks', 'resources'] as const) {
    const ids = new Set<string>();
    plan[key].forEach((item, index) => {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', message: '编号重复', path: [key, index, 'id'] });
      ids.add(item.id);
    });
  }
  const resources = new Set(plan.resources.map(value => value.id));
  for (const key of ['goals', 'tasks', 'blocks'] as const) plan[key].forEach((item, index) => {
    if (new Set(item.resourceRefs).size !== item.resourceRefs.length) ctx.addIssue({ code: 'custom', message: '资料引用重复', path: [key, index, 'resourceRefs'] });
    item.resourceRefs.forEach(ref => { if (!resources.has(ref)) ctx.addIssue({ code: 'custom', message: `资料 ${ref} 不存在`, path: [key, index, 'resourceRefs'] }); });
  });
  plan.tasks.forEach((item, index) => { if (item.goalRef && !plan.goals.some(value => value.id === item.goalRef)) ctx.addIssue({ code: 'custom', message: 'goalRef 未对应文件中的目标', path: ['tasks', index, 'goalRef'] }); });
  plan.blocks.forEach((item, index) => { if (item.taskRef && !plan.tasks.some(value => value.id === item.taskRef)) ctx.addIssue({ code: 'custom', message: 'taskRef 未对应文件中的任务', path: ['blocks', index, 'taskRef'] }); });
});
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type PlanFileInput = z.input<typeof PlanFileSchema>;
/** Version-specific schemas for external agents; both pass the same runtime checks. */
export const PlanFileV1Schema = PlanFileSchema.safeExtend({ version: z.literal(1), basis: z.never().optional() });
export const PlanFileV2Schema = PlanFileSchema.safeExtend({ version: z.literal(2), basis: PlanBasisSchema });

export const PlanImportRowSchema = z.strictObject({
  kind: z.enum(['goal', 'task', 'block']), localId: localId, title: z.string(),
  state: z.enum(['new', 'existing', 'blocked']), detail: z.string(), existingId: z.string().optional(),
  start: z.string().optional(), end: z.string().optional(),
});
export const PlanImportPreviewSchema = z.strictObject({
  token: z.string(), planId: localId, title: z.string(), expiresAt: z.string(),
  rows: z.array(PlanImportRowSchema), conflicts: z.array(z.string()), warnings: z.array(z.string()),
  resources: z.array(ResourceReferenceSchema),
  canVerifyPending: z.boolean().optional(),
});
export type PlanImportPreview = z.infer<typeof PlanImportPreviewSchema>;
export type PlanImportRow = z.infer<typeof PlanImportRowSchema>;
export const PlanImportConfirmSchema = z.strictObject({ token: z.string().min(1), allowConflicts: z.boolean().default(false) });
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
