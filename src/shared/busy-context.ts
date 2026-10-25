import { z } from 'zod';
import { DateOnlySchema, InstantSchema, type ApiResult } from './contracts';
import { PlanSourceSchema, PlanExportSaveRequestSchema, PlanExportSaveResultSchema } from './plan-context';

const range = { fromDate: DateOnlySchema, toDate: DateOnlySchema };
function validRange(value: { fromDate: string; toDate: string }) {
  const days = (Date.parse(`${value.toDate}T00:00:00Z`) - Date.parse(`${value.fromDate}T00:00:00Z`)) / 86400000;
  return days >= 0 && days <= 365;
}
export const BusyExportRequestSchema = z.strictObject({ ...range,
  includeBusyTitles: z.boolean().default(false), instructions: z.string().max(10000).default(''),
}).refine(validRange, '规划结束日期不得早于开始日期，范围最多 366 天');
export type BusyExportRequest = z.infer<typeof BusyExportRequestSchema>;
export const BusyExportPreviewSchema = z.strictObject({ token: z.string(), sourceKind: z.enum(['cloud', 'local']), ...range,
  counts: z.strictObject({ intervals: z.number().int().nonnegative(), courses: z.number().int().nonnegative(), work: z.number().int().nonnegative(), events: z.number().int().nonnegative() }),
  warnings: z.array(z.string()),
});
export type BusyExportPreview = z.infer<typeof BusyExportPreviewSchema>;
export interface BusyExportDesktopAPI {
  busyExportPreview(request: z.input<typeof BusyExportRequestSchema>): Promise<ApiResult<BusyExportPreview>>;
  busyExportSave(request: z.infer<typeof PlanExportSaveRequestSchema>): Promise<ApiResult<z.infer<typeof PlanExportSaveResultSchema>>>;
}
export const BusyContextSchema = z.strictObject({ format: z.literal('ultimate-calendar-busy'), version: z.literal(1), timezone: z.literal('Asia/Shanghai'),
  source: PlanSourceSchema, ...range, exportedAt: InstantSchema, request: z.string(), instructions: z.array(z.string()),
  busyIntervals: z.array(z.strictObject({ start: InstantSchema, end: InstantSchema, category: z.enum(['course', 'work', 'event']), title: z.string().optional() })),
  coverage: z.string(),
}).refine(validRange, '规划日期范围需为 1–366 天');
export type BusyContext = z.infer<typeof BusyContextSchema>;
