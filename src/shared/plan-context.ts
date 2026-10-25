import { z } from 'zod';
import { DateOnlySchema, InstantSchema, IdSchema, GoalSchema, TaskSchema, ReminderConfigSchema, EventRecurrenceSchema, type ApiResult } from './contracts';
import { ResourceReferenceSchema, ResourceOwnerSchema } from './resources';

export const PlanSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloud'), dataInstanceId: z.string().uuid(), generation: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('local'), dataInstanceId: z.string().uuid() }),
]);
export type PlanSource = z.infer<typeof PlanSourceSchema>;
const range = { fromDate: DateOnlySchema, toDate: DateOnlySchema };
function validRange(value: { fromDate: string; toDate: string }) {
  const days = (Date.parse(`${value.toDate}T00:00:00Z`) - Date.parse(`${value.fromDate}T00:00:00Z`)) / 86400000;
  return days >= 0 && days <= 365;
}
export const PlanBasisSchema = z.strictObject({ source: PlanSourceSchema, goalId: IdSchema, ...range,
  exportedAt: InstantSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(validRange, '规划日期范围需为 1–366 天');
export type PlanBasis = z.infer<typeof PlanBasisSchema>;
export const PlanExportRequestSchema = z.strictObject({ goalId: IdSchema, ...range,
  includeBusyTitles: z.boolean().default(false), instructions: z.string().max(10000).default(''),
}).refine(validRange, '规划结束日期不得早于开始日期，范围最多 366 天');
export type PlanExportRequest = z.infer<typeof PlanExportRequestSchema>;
export const PlanExportPreviewSchema = z.strictObject({ token: z.string(), title: z.string(), sourceKind: z.enum(['cloud', 'local']), ...range,
  counts: z.strictObject({ tasks: z.number().int().nonnegative(), completedTasks: z.number().int().nonnegative(), blocks: z.number().int().nonnegative(), resources: z.number().int().nonnegative(), busyIntervals: z.number().int().nonnegative() }),
  warnings: z.array(z.string()),
});
export type PlanExportPreview = z.infer<typeof PlanExportPreviewSchema>;
export const PlanExportSaveRequestSchema = z.strictObject({ token: z.string().min(1) });
export const PlanExportSaveResultSchema = z.strictObject({ saved: z.boolean(), filename: z.string().optional() });
export interface PlanExportDesktopAPI {
  planExportPreview(request: z.input<typeof PlanExportRequestSchema>): Promise<ApiResult<PlanExportPreview>>;
  planExportSave(request: z.infer<typeof PlanExportSaveRequestSchema>): Promise<ApiResult<z.infer<typeof PlanExportSaveResultSchema>>>;
}

const ContextBlockSchema = z.strictObject({ id: IdSchema, version: z.number().int().positive(), createdAt: InstantSchema, updatedAt: InstantSchema,
  title: z.string(), kind: z.enum(['work', 'event']), start: InstantSchema, end: InstantSchema.nullable(), taskId: IdSchema.nullable(),
  location: z.string(), completed: z.boolean(), cancelled: z.boolean(), recurrence: EventRecurrenceSchema.nullable(),
  reminders: ReminderConfigSchema, resources: z.array(ResourceReferenceSchema).optional(),
});
export const PlanContextSchema = z.strictObject({ format: z.literal('ultimate-calendar-context'), version: z.literal(1), timezone: z.literal('Asia/Shanghai'),
  basis: PlanBasisSchema, request: z.string(), instructions: z.array(z.string()),
  goal: GoalSchema, tasks: z.array(TaskSchema.omit({ candidateId: true })), blocks: z.array(ContextBlockSchema),
  resourceLinks: z.array(z.strictObject({ target: ResourceOwnerSchema, owner: ResourceOwnerSchema, ownerTitle: z.string(), resource: ResourceReferenceSchema, inherited: z.boolean() })),
  busyIntervals: z.array(z.strictObject({ start: InstantSchema, end: InstantSchema, category: z.enum(['course', 'work', 'event']), title: z.string().optional(), selectedPlan: z.boolean() })),
  coverage: z.string(),
});
export type PlanContext = z.infer<typeof PlanContextSchema>;
