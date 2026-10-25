import { z } from 'zod';
import { ResourceReferencesSchema, ResourceOwnerSchema } from './resources';
import type { ResourceDesktopAPI } from './resource-host';
import type { CaptureDesktopAPI as importCaptureAPI } from './capture-api';
import { LedgerCommandProposalSchema } from './ledger-command';
import { LedgerMonthSchema } from './ledger';
import { PALETTE_COLORS } from './palette';
import { AiConfigurationRevisionSchema, AiConfigurationStatusSchema } from './ai-configuration-status';

/** Shared transport boundary. Unknown properties are rejected, never silently stripped. */
export const SCHEMA_VERSION = 1;
export const TIMEZONE = 'Asia/Shanghai' as const;
export const MAX_SOURCE_TEXT = 100_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IdSchema = z.string().trim().min(1).max(200);
export const TitleSchema = z.string().trim().min(1).max(500);
const text = z.string().max(MAX_SOURCE_TEXT);
const shortText = z.string().max(2000);
const version = z.number().int().positive();

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
export const DateOnlySchema = z.string().refine(isRealDate, '日期必须真实存在且格式为 YYYY-MM-DD');
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式为 HH:mm');
/** Persisted instants are normalized to Shanghai +08:00; UTC input must be explicitly converted by adapters. */
export const InstantSchema = z.string().refine(value => {
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d):[0-5]\d(?:\.\d{3})?\+08:00$/.exec(value);
  return !!match && isRealDate(match[1]!);
}, '时间必须为有效的 Asia/Shanghai ISO 时间（+08:00）');
export type DateOnly = z.infer<typeof DateOnlySchema>;
export type Instant = z.infer<typeof InstantSchema>;
export function toShanghaiInstant(date: string, time: string): Instant {
  return InstantSchema.parse(`${DateOnlySchema.parse(date)}T${TimeSchema.parse(time)}:00+08:00`);
}
/** Calendar day arithmetic uses UTC date components, never host timezone/DST. */
export function addCalendarDays(date: string, days: number): DateOnly {
  DateOnlySchema.parse(date);
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be a safe integer');
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return DateOnlySchema.parse(next.toISOString().slice(0, 10));
}
export function shanghaiDate(instant: string): DateOnly { return InstantSchema.parse(instant).slice(0, 10); }
export function mondayWeekday(date: string): number {
  const day = new Date(`${DateOnlySchema.parse(date)}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
const monday = DateOnlySchema.refine(date => mondayWeekday(date) === 1, '学期起始日必须是星期一');
export const DeadlineSchema = z.strictObject({ date: DateOnlySchema, time: TimeSchema.nullable() });
export type Deadline = z.infer<typeof DeadlineSchema>;
export const RecordMetadataSchema = z.strictObject({ id: IdSchema, version, createdAt: InstantSchema, updatedAt: InstantSchema });
const metadata = RecordMetadataSchema.shape;

/** null leads inherit global settings; [] explicitly suppresses lead reminders. */
export const ReminderConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  leadMinutes: z.array(z.number().int().min(0).max(525_600)).max(20).nullable().default(null),
  dateOnlyTime: TimeSchema.nullable().default(null),
});
export type ReminderConfig = z.infer<typeof ReminderConfigSchema>;
const reminder = ReminderConfigSchema.default({ enabled: true, leadMinutes: null, dateOnlyTime: null });

// Data URL size is checked by decoded length, before main decodes it. No SVG/HTML content is allowed.
export const ImageDataUrlSchema = z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32).refine(value => {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || !match[1] || match[1].length % 4 !== 0) return false;
  const payload = match[1];
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return payload.length / 4 * 3 - padding <= MAX_IMAGE_BYTES;
}, '仅支持不超过 10 MB 的 PNG/JPEG 图片');
const sourceFields = {
  kind: z.enum(['text', 'image']), text: text.default(''), imageDataUrl: ImageDataUrlSchema.nullable().default(null),
  label: shortText.default(''), sentAt: InstantSchema.nullable().default(null),
};
function validSource(value: { kind: string; text: string; imageDataUrl: string | null }): boolean {
  return value.kind === 'text' ? value.text.trim().length > 0 && value.imageDataUrl === null : value.imageDataUrl !== null;
}
export const SourceImportSchema = z.strictObject(sourceFields).refine(validSource, '文本不能为空，图片来源必须包含图片');
export type SourceImport = z.input<typeof SourceImportSchema>;
const sourceValue = z.strictObject({ ...sourceFields, importedAt: InstantSchema,
  captureRef: z.strictObject({ messageId: IdSchema, accountId: IdSchema, groupId: IdSchema, attachmentId: IdSchema.nullable(), locator: z.string().max(1000), transcribed: z.boolean() }).optional(),
  purpose: z.enum(['message', 'courses']).default('message'),
  status: z.enum(['saved', 'processing', 'needs-review', 'succeeded', 'failed']).default('saved'),
  error: shortText.nullable().default(null),
});
export const SourceInputSchema = sourceValue.refine(validSource, '来源内容无效');
export const SourceSchema = sourceValue.extend(metadata).refine(validSource, '来源内容无效');
export type Source = z.infer<typeof SourceSchema>;
export type SourceInput = z.input<typeof SourceInputSchema>;

export const TemporalEvidenceSchema = z.strictObject({ field: z.enum(['deadline', 'eventStart', 'eventEnd']), basis: z.enum(['explicit', 'relative', 'unknown']), quote: z.string().min(1).max(2000) });
const candidateValue = z.strictObject({
  title: TitleSchema, action: text.default(''), benefit: text.default(''),
  benefitKind: z.enum(['stated', 'inferred', 'unknown']).default('unknown'),
  potentialBenefit: text.default(''), conditions: z.array(shortText).max(100).default([]),
  uncertainties: z.array(shortText).max(100).default([]), sourceIds: z.array(IdSchema).min(1).max(100),
  deadline: DeadlineSchema.nullable().default(null), eventStart: InstantSchema.nullable().default(null), eventEnd: InstantSchema.nullable().default(null),
  sourceQuote: shortText.default(''), temporalEvidence: z.array(TemporalEvidenceSchema).max(10).default([]),
  location: shortText.default(''), status: z.enum(['pending', 'accepted', 'ignored']).default('pending'),
  snoozedUntil: InstantSchema.nullable().default(null), taskId: IdSchema.nullable().default(null),
  duplicateOfId: IdSchema.nullable().default(null), revisionOfId: IdSchema.nullable().default(null),
});
const candidateInterval = (value: { eventStart: string | null; eventEnd: string | null }) =>
  value.eventEnd === null || (value.eventStart !== null && Date.parse(value.eventEnd) > Date.parse(value.eventStart));
export const CandidateInputSchema = candidateValue.refine(candidateInterval, '活动结束必须晚于已知开始');
export const CandidateSchema = candidateValue.extend(metadata).refine(candidateInterval, '活动时间无效');
export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidateInput = z.input<typeof CandidateInputSchema>;
const taskValue = z.strictObject({ title: TitleSchema, description: text.default(''), status: z.enum(['open', 'done']).default('open'),
  deadline: DeadlineSchema.nullable().default(null), goalId: IdSchema.nullable().default(null), candidateId: IdSchema.nullable().default(null), reminders: reminder,
  courseId: IdSchema.nullable().default(null), resources: ResourceReferencesSchema.optional() });
export const TaskInputSchema = taskValue;
export const TaskSchema = taskValue.extend(metadata);
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskInputSchema>;
/** Bounded recurrence expands to linked activity blocks; academic parity uses the term's Monday. */
export const RecurrenceRuleSchema = z.strictObject({
  frequency: z.enum(['weekly', 'biweekly', 'odd-weeks', 'even-weeks']),
  fromDate: DateOnlySchema, untilDate: DateOnlySchema,
  weekday: z.number().int().min(1).max(7), time: TimeSchema,
  durationMinutes: z.number().int().min(1).max(1440).default(30),
  termStart: monday.nullable().default(null),
}).superRefine((rule, ctx) => {
  const days = (Date.parse(`${rule.untilDate}T00:00:00Z`) - Date.parse(`${rule.fromDate}T00:00:00Z`)) / 86400_000;
  if (days < 0 || days > 365) ctx.addIssue({ code: 'custom', message: '重复活动的结束日期不得早于开始日期，范围最多一年', path: ['untilDate'] });
  if ((rule.frequency === 'odd-weeks' || rule.frequency === 'even-weeks') && !rule.termStart) ctx.addIssue({ code: 'custom', message: '单双周活动需要学期起始周一', path: ['termStart'] });
});
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;
export type RecurrenceRuleInput = z.input<typeof RecurrenceRuleSchema>;
export const EventRecurrenceSchema = z.strictObject({ seriesId: IdSchema, occurrenceStart: InstantSchema });
export const RecurringEventScopeSchema = z.enum(['single', 'this-and-following']);
const blockValue = z.strictObject({ title: TitleSchema, start: InstantSchema, end: InstantSchema.nullable(), kind: z.enum(['work', 'event']),
  taskId: IdSchema.nullable().default(null), candidateId: IdSchema.nullable().default(null), location: shortText.default(''), completed: z.boolean().default(false), reminders: reminder, resources: ResourceReferencesSchema.optional() });
const blockInterval = (value: { start: string; end: string | null; kind: string }) =>
  value.end === null ? value.kind === 'event' : Date.parse(value.end) > Date.parse(value.start);
/** Source-event provenance is internal metadata; renderer/AI cannot forge it. */
const blockEditable = blockValue.omit({ candidateId: true });
export const BlockInputSchema = blockEditable.refine(blockInterval, '执行时段必须有结束时间，结束必须晚于开始');
export const BlockSchema = blockValue.extend({ ...metadata, recurrence: EventRecurrenceSchema.nullable().default(null), cancelled: z.boolean().default(false) })
  .refine(blockInterval, '时段无效').refine(value => (!value.recurrence && !value.cancelled) || value.kind === 'event', '重复与取消标记仅适用于固定活动');
export type Block = z.infer<typeof BlockSchema>;
export type BlockInput = z.input<typeof BlockInputSchema>;
/** Belonging color for courses and goals; empty values are filled from the shared palette. */
export const ColorSchema = z.enum(PALETTE_COLORS);
const goalValue = z.strictObject({ title: TitleSchema, description: text.default(''), priority: z.enum(['low', 'medium', 'high']).default('medium'),
  targetDate: DateOnlySchema.nullable().default(null), status: z.enum(['active', 'completed', 'paused']).default('active'),
  color: ColorSchema.nullable().default(null), resources: ResourceReferencesSchema.optional() });
export const GoalInputSchema = goalValue;
export const GoalSchema = goalValue.extend(metadata);
export type Goal = z.infer<typeof GoalSchema>;
export type GoalInput = z.input<typeof GoalInputSchema>;
const courseValue = z.strictObject({ title: TitleSchema, location: shortText.default(''), weekday: z.number().int().min(1).max(7),
  startTime: TimeSchema, endTime: TimeSchema, firstWeek: z.number().int().min(1).max(100), lastWeek: z.number().int().min(1).max(100),
  parity: z.enum(['all', 'odd', 'even']).default('all'), termStart: monday,
  weeks: z.array(z.number().int().min(1).max(100)).min(1).max(100).nullable().default(null), reminders: reminder,
  color: ColorSchema.nullable().default(null), resources: ResourceReferencesSchema.optional() });
const courseInterval = (value: { firstWeek: number; lastWeek: number; startTime: string; endTime: string; weeks: number[] | null }) =>
  value.firstWeek <= value.lastWeek && value.startTime < value.endTime &&
  (value.weeks === null || value.weeks.every(week => week >= value.firstWeek && week <= value.lastWeek));
export const CourseInputSchema = courseValue.refine(courseInterval, '课程周范围或时间无效');
export const CourseSchema = courseValue.extend(metadata).refine(courseInterval, '课程周范围或时间无效');
export type Course = z.infer<typeof CourseSchema>;
export type CourseInput = z.input<typeof CourseInputSchema>;
export const CourseReplacementSchema = z.strictObject({ start: InstantSchema, end: InstantSchema, title: TitleSchema, location: shortText.default('') })
  .refine(value => Date.parse(value.end) > Date.parse(value.start), '调课结束必须晚于开始');
const exceptionValue = z.strictObject({ courseId: IdSchema, originalDate: DateOnlySchema, cancelled: z.boolean(), replacement: CourseReplacementSchema.nullable().default(null) });
const exceptionValid = (value: { cancelled: boolean; replacement: unknown }) => value.cancelled ? value.replacement === null : value.replacement !== null;
export const CourseExceptionInputSchema = exceptionValue.refine(exceptionValid, '取消课程或提供完整调课信息');
export const CourseExceptionSchema = exceptionValue.extend(metadata).refine(exceptionValid, '调课信息无效');
export type CourseException = z.infer<typeof CourseExceptionSchema>;
export type CourseExceptionInput = z.input<typeof CourseExceptionInputSchema>;
const preferenceValue = z.strictObject({ text: text.refine(value => value.trim().length > 0, '偏好不能为空'), enabled: z.boolean().default(true) });
export const PreferenceInputSchema = preferenceValue;
export const PreferenceSchema = preferenceValue.extend(metadata);
export type Preference = z.infer<typeof PreferenceSchema>;
export type PreferenceInput = z.input<typeof PreferenceInputSchema>;
const feedbackValue = z.strictObject({ candidateId: IdSchema, decision: z.enum(['accepted', 'ignored', 'snoozed', 'restored']), reason: shortText.default('') });
export const FeedbackInputSchema = feedbackValue;
export const FeedbackSchema = feedbackValue.extend(metadata);
export type Feedback = z.infer<typeof FeedbackSchema>;
export type FeedbackInput = z.input<typeof FeedbackInputSchema>;

export const PeriodSchema = z.strictObject({ period: z.number().int().min(1).max(30), startTime: TimeSchema, endTime: TimeSchema })
  .refine(value => value.startTime < value.endTime, '节次结束必须晚于开始');
export const SettingsSchema = z.strictObject({
  campus: z.string().trim().max(200).default(''), locationContext: z.string().trim().max(2000).default(''),
  model: z.string().trim().min(1).max(100).default('deepseek-flash'), timezone: z.literal(TIMEZONE).default(TIMEZONE),
  showPending: z.boolean().default(true), weekStartsOn: z.literal(1).default(1), closeToTray: z.boolean().default(true),
  autoLaunch: z.boolean().default(false), remindersEnabled: z.boolean().default(true), courseReminders: z.boolean().default(false),
  taskLeadMinutes: z.array(z.number().int().min(0).max(525_600)).max(20).default([1440, 120]),
  blockLeadMinutes: z.array(z.number().int().min(0).max(525_600)).max(20).default([15]),
  courseLeadMinutes: z.array(z.number().int().min(0).max(525_600)).max(20).default([15]), dateOnlyReminderTime: TimeSchema.default('09:00'),
  termStart: monday.nullable().default(null), termWeeks: z.number().int().min(1).max(100).default(20),
  periodMap: z.array(PeriodSchema).max(30).default([]).refine(periods => new Set(periods.map(p => p.period)).size === periods.length, '节次不得重复'),
  pricingMode: z.enum(['auto', 'manual', 'off']).default('auto'), pricingCurrency: z.enum(['CNY', 'USD']).default('CNY'),
  tokenPrices: z.strictObject({ model: z.string().trim().min(1).max(100).optional(), inputPerMillion: z.number().finite().nonnegative(), cachedInputPerMillion: z.number().finite().nonnegative().nullable().default(null),
    outputPerMillion: z.number().finite().nonnegative(), currency: z.enum(['CNY', 'USD']), updatedAt: InstantSchema }).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
export const KeyStatusSchema = z.strictObject({
  configured: z.boolean(), sessionOnly: z.boolean(),
  loadError: z.enum(['unavailable', 'read', 'decrypt', 'invalid']).optional(),
  scope: z.enum(['local', 'cloud']).optional(),
  cloudConfiguration: AiConfigurationStatusSchema.optional(),
});
export type KeyStatus = z.infer<typeof KeyStatusSchema>;
export const EntityKindSchema = z.enum(['source', 'candidate', 'task', 'block', 'goal', 'course', 'courseException', 'preference', 'feedback']);
export type EntityKind = z.infer<typeof EntityKindSchema>;
export const EntitySchemas = { source: SourceSchema, candidate: CandidateSchema, task: TaskSchema, block: BlockSchema, goal: GoalSchema,
  course: CourseSchema, courseException: CourseExceptionSchema, preference: PreferenceSchema, feedback: FeedbackSchema } as const;
export type EntityMap = { [K in keyof typeof EntitySchemas]: z.infer<(typeof EntitySchemas)[K]> };
export type Entity = EntityMap[EntityKind];
export const EntitySchema = z.union([SourceSchema, CandidateSchema, TaskSchema, BlockSchema, GoalSchema, CourseSchema, CourseExceptionSchema, PreferenceSchema, FeedbackSchema]);

// An update validates provided properties here; service must merge with saved record and reparse the full entity before writing.
type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : T[K]>;
};
const nonemptyPatch = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
  // Zod 4 applies defaults even inside .optional(); .partial() alone would erase existing values.
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => {
    const validator = field as z.ZodType;
    const inner = (validator instanceof z.ZodDefault ? validator.removeDefault() : validator) as z.ZodType;
    return [key, inner.optional()];
  })) as PatchShape<T>;
  return z.strictObject(shape).refine(value => Object.keys(value).length > 0, '更新不能为空');
};
const scopeFields = { scope: z.enum(['single', 'this-and-following', 'all']), occurrenceDate: DateOnlySchema.optional() };
const validScope = (value: { scope: string; occurrenceDate?: string }) => value.scope === 'all' || !!value.occurrenceDate;
function entityMutations<K extends EntityKind, S extends z.ZodType, P extends z.ZodType>(entity: K, values: S, patch: P) {
  return [
    z.strictObject({ type: z.literal('create'), entity: z.literal(entity), values }),
    z.strictObject({ type: z.literal('update'), entity: z.literal(entity), id: IdSchema, expectedVersion: version, values: patch }),
    z.strictObject({ type: z.literal('delete'), entity: z.literal(entity), id: IdSchema, expectedVersion: version }),
  ] as const;
}
const candidateDecision = { id: IdSchema, expectedVersion: version, reason: shortText.optional() };
const candidateEditable = candidateValue.omit({ status: true, taskId: true, sourceIds: true, duplicateOfId: true, revisionOfId: true, snoozedUntil: true, sourceQuote: true, temporalEvidence: true });
const recurringEventEditable = blockEditable.pick({ title: true, start: true, end: true, location: true, reminders: true, resources: true });
export const MutationSchema = z.union([
  z.strictObject({ type: z.literal('updateRecurringEvent'), id: IdSchema, expectedVersion: version, scope: RecurringEventScopeSchema, values: nonemptyPatch(recurringEventEditable), resourceMode: z.literal('append').optional() }),
  z.strictObject({ type: z.literal('cancelRecurringEvent'), id: IdSchema, expectedVersion: version, scope: RecurringEventScopeSchema }),
  z.strictObject({ type: z.literal('delete'), entity: z.literal('source'), id: IdSchema, expectedVersion: version, acknowledgeProvenanceLoss: z.literal(true) }),
  z.strictObject({ type: z.literal('update'), entity: z.literal('candidate'), id: IdSchema, expectedVersion: version, values: nonemptyPatch(candidateEditable) }),
  z.strictObject({ type: z.literal('delete'), entity: z.literal('candidate'), id: IdSchema, expectedVersion: version }),
  ...entityMutations('task', TaskInputSchema, nonemptyPatch(taskValue)),
  ...entityMutations('block', BlockInputSchema, nonemptyPatch(blockEditable)),
  ...entityMutations('goal', GoalInputSchema, nonemptyPatch(goalValue)),
  z.strictObject({ type: z.literal('create'), entity: z.literal('course'), values: CourseInputSchema }),
  z.strictObject({ type: z.literal('update'), entity: z.literal('course'), id: IdSchema, expectedVersion: version, values: nonemptyPatch(courseValue), ...scopeFields }).refine(validScope, '单次或此后修改必须指定原课程日期'),
  z.strictObject({ type: z.literal('delete'), entity: z.literal('course'), id: IdSchema, expectedVersion: version, ...scopeFields }).refine(validScope, '单次或此后删除必须指定原课程日期'),
  ...entityMutations('courseException', CourseExceptionInputSchema, nonemptyPatch(exceptionValue)),
  ...entityMutations('preference', PreferenceInputSchema, nonemptyPatch(preferenceValue)),
  z.strictObject({ type: z.literal('acceptCandidate'), ...candidateDecision }),
  z.strictObject({ type: z.literal('ignoreCandidate'), ...candidateDecision }),
  z.strictObject({ type: z.literal('restoreCandidate'), ...candidateDecision }),
  z.strictObject({ type: z.literal('snoozeCandidate'), ...candidateDecision, until: InstantSchema }),
  z.strictObject({ type: z.literal('finishTask'), id: IdSchema, expectedVersion: version, completed: z.boolean().default(true) }),
  z.strictObject({ type: z.literal('removeTask'), id: IdSchema, expectedVersion: version, includeLinkedBlocks: z.boolean().default(true) }),
  z.strictObject({ type: z.literal('scheduleTaskEvent'), id: IdSchema, expectedVersion: version, values: BlockInputSchema }),
  // One user action creates both records; the service supplies their shared taskId.
  z.strictObject({ type: z.literal('createScheduledTask'), values: TaskInputSchema, start: InstantSchema, end: InstantSchema.nullable().default(null), location: shortText.default(''), reminders: ReminderConfigSchema.optional() })
    .refine(value => value.end === null || Date.parse(value.end) > Date.parse(value.start), '活动结束必须晚于开始'),
  z.strictObject({ type: z.literal('scheduleRecurringTask'), id: IdSchema, expectedVersion: version, rule: RecurrenceRuleSchema, location: shortText.default(''), reminders: ReminderConfigSchema.optional(), resources: ResourceReferencesSchema.optional() }),
  z.strictObject({ type: z.literal('createRecurringTask'), values: TaskInputSchema, rule: RecurrenceRuleSchema, location: shortText.default(''), reminders: ReminderConfigSchema.optional(), resources: ResourceReferencesSchema.optional() }),
  z.strictObject({ type: z.literal('finishBlock'), id: IdSchema, expectedVersion: version, completed: z.boolean().default(true) }),
]);
export type Mutation = z.infer<typeof MutationSchema>;
export type MutationInput = z.input<typeof MutationSchema>;
export const MutationRequestSchema = z.strictObject({ operationId: IdSchema, origin: z.enum(['manual', 'ai']),
  mutations: z.array(MutationSchema).min(1).max(500), confirmed: z.boolean().default(false), confirmationToken: IdSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.origin === 'ai' && (value.confirmed || value.confirmationToken)) ctx.addIssue({ code: 'custom', message: 'AI 不能自行确认操作', path: ['confirmed'] });
  if (value.confirmed && !value.confirmationToken) ctx.addIssue({ code: 'custom', message: '确认必须携带精确预览凭据', path: ['confirmationToken'] });
});
export type MutationRequest = z.infer<typeof MutationRequestSchema>;
export type MutationRequestInput = z.input<typeof MutationRequestSchema>;
export const EntityChangeSchema = z.strictObject({ entity: EntityKindSchema, id: IdSchema, action: z.enum(['create', 'update', 'delete']),
  beforeVersion: version.nullable(), afterVersion: version.nullable(), title: shortText.default('') });
export type EntityChange = z.infer<typeof EntityChangeSchema>;
export const ConflictSchema = z.strictObject({ kind: z.enum(['time', 'version', 'missing', 'provenance', 'revision', 'recurrence']),
  entity: EntityKindSchema, id: IdSchema, message: shortText, conflictingIds: z.array(IdSchema).default([]) });
export type Conflict = z.infer<typeof ConflictSchema>;
const resultFields = { message: shortText, changes: z.array(EntityChangeSchema), conflicts: z.array(ConflictSchema) };
export const PreviewDetailSchema = z.strictObject({ entity: EntityKindSchema, id: IdSchema, before: EntitySchema.nullable(), after: EntitySchema.nullable() });
export type PreviewDetail = z.infer<typeof PreviewDetailSchema>;
export const MutationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), ...resultFields, transactionId: IdSchema }),
  z.strictObject({ status: z.literal('preview'), ...resultFields, confirmationToken: IdSchema, expiresAt: InstantSchema,
    proposedRequest: MutationRequestSchema, details: z.array(PreviewDetailSchema).min(1) }),
  z.strictObject({ status: z.literal('clarification'), ...resultFields, questions: z.array(shortText).min(1) }),
]);
export type MutationResult = z.infer<typeof MutationResultSchema>;
export const JournalSummarySchema = z.strictObject({ id: IdSchema, operationId: IdSchema, createdAt: InstantSchema,
  origin: z.enum(['manual', 'ai']), message: shortText, changes: z.array(EntityChangeSchema), undoneAt: InstantSchema.nullable(), undoable: z.boolean(),
  displayTitle: shortText.optional(), displayDetails: z.array(shortText).max(21).optional() });
export type JournalSummary = z.infer<typeof JournalSummarySchema>;
export const TokenUsageSchema = z.strictObject({ id: IdSchema, operationId: IdSchema, createdAt: InstantSchema, model: z.string().max(100),
  purpose: z.enum(['source', 'command', 'courses']), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0), totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().finite().nonnegative().nullable().default(null), currency: z.enum(['CNY', 'USD']).nullable().default(null),
  estimatedCostMax: z.number().finite().nonnegative().nullable().optional(), pricingSource: z.enum(['official', 'manual']).nullable().optional(),
  pricingUpdatedAt: InstantSchema.nullable().optional() });
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export const SnapshotSchema = z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION),
  sources: z.array(SourceSchema), candidates: z.array(CandidateSchema), tasks: z.array(TaskSchema), blocks: z.array(BlockSchema), goals: z.array(GoalSchema),
  courses: z.array(CourseSchema), courseExceptions: z.array(CourseExceptionSchema), preferences: z.array(PreferenceSchema), feedback: z.array(FeedbackSchema),
  settings: SettingsSchema, journal: z.array(JournalSummarySchema), tokenUsage: z.array(TokenUsageSchema), keyStatus: KeyStatusSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const CalendarItemSchema = z.strictObject({ id: IdSchema, refId: IdSchema, refKind: EntityKindSchema,
  occurrenceDate: DateOnlySchema.optional(),
  title: TitleSchema, start: InstantSchema.nullable(), end: InstantSchema.nullable(), date: DateOnlySchema, busy: z.boolean(), pending: z.boolean(),
  category: z.enum(['candidate', 'deadline', 'work', 'event', 'course']), location: shortText.default('') });
export type CalendarItem = z.infer<typeof CalendarItemSchema>;
export const ReminderSchema = z.strictObject({ id: IdSchema, refId: IdSchema, refKind: z.enum(['task', 'block', 'course']),
  title: TitleSchema, dueAt: InstantSchema, scheduledAt: InstantSchema, dateOnly: z.boolean(), message: shortText });
export type Reminder = z.infer<typeof ReminderSchema>;
/** Include date ranges fromDate <= local date <= toDate. Busy intervals are half-open [start,end). */
export type BuildCalendar = (snapshot: Snapshot, fromDate: DateOnly, toDate: DateOnly, showPending: boolean) => CalendarItem[];
/** Return reminder points in (previousCheck,now], excluding points at/before entity.createdAt. */
export type CollectReminders = (snapshot: Snapshot, previousCheck: Instant, now: Instant) => Reminder[];
export interface PlannerService {
  snapshot(): Snapshot;
  mutate(request: MutationRequest): MutationResult;
  undo(transactionId?: string): MutationResult;
}

export const ApiErrorSchema = z.strictObject({ code: z.enum(['VALIDATION', 'NOT_FOUND', 'CONFLICT', 'NO_API_KEY', 'NETWORK', 'RATE_LIMIT', 'AUTH', 'BALANCE', 'AI_RESPONSE', 'CANCELLED', 'STORAGE', 'INTERNAL']), message: shortText, retryable: z.boolean() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export function apiResultSchema<T extends z.ZodType>(schema: T) {
  return z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), data: schema }), z.strictObject({ ok: z.literal(false), error: ApiErrorSchema })]);
}
export const ImportSourceRequestSchema = z.strictObject({ operationId: IdSchema, source: SourceImportSchema });
export type ImportSourceRequest = z.input<typeof ImportSourceRequestSchema>;
export const AnalyzeSourceRequestSchema = z.strictObject({ operationId: IdSchema, sourceId: IdSchema });
export type AnalyzeSourceRequest = z.infer<typeof AnalyzeSourceRequestSchema>;
export const AnalysisResultSchema = z.strictObject({ sourceId: IdSchema, status: z.enum(['needs-review', 'succeeded', 'failed']), candidateIds: z.array(IdSchema), message: shortText });
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export const ConversationStateSchema = z.strictObject({ domain: z.enum(['calendar', 'ledger']), phase: z.enum(['clarification', 'saved', 'query', 'preview']) });
export type ConversationState = z.infer<typeof ConversationStateSchema>;
/** Visible ledger scope helps interpret questions; it never sets a new transaction's date. */
export const LedgerViewContextSchema = z.strictObject({ month: LedgerMonthSchema, tab: z.enum(['flows', 'accounts']), selectedEntryId: IdSchema.optional() });
export type LedgerViewContext = z.infer<typeof LedgerViewContextSchema>;
export const CommandRequestSchema = z.strictObject({ operationId: IdSchema, text: text.trim().min(1),
  selected: z.array(z.strictObject({ entity: EntityKindSchema, id: IdSchema })).max(100).default([]),
  domain: z.enum(['calendar', 'ledger']).optional(),
  ledgerView: LedgerViewContextSchema.optional(),
  resources: ResourceReferencesSchema.optional(),
  fromDate: DateOnlySchema.optional(), toDate: DateOnlySchema.optional(),
  history: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string().max(10_000), outcome: ConversationStateSchema.optional() })).max(20).default([]),
});
export type CommandRequest = z.input<typeof CommandRequestSchema>;
/** Model output is a proposal, never authorization. The AI adapter executes only through PlannerService. */
export const CommandIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('query'), reply: text, fromDate: DateOnlySchema.optional(), toDate: DateOnlySchema.optional() }),
  z.strictObject({ kind: z.literal('mutate'), reply: text, mutations: z.array(MutationSchema).min(1).max(500) }),
  z.strictObject({ kind: z.literal('undo'), reply: text, transactionId: IdSchema.optional() }),
  z.strictObject({ kind: z.literal('ledger'), reply: text }),
  z.strictObject({ kind: z.literal('resource_open'), reply: text, resourceIds: z.array(IdSchema).min(1).max(10) }),
  z.strictObject({ kind: z.literal('resource_attach'), reply: text, target: ResourceOwnerSchema, expectedVersion: version, resourceIds: z.array(IdSchema).min(1).max(50), scope: RecurringEventScopeSchema.optional() }),
  z.strictObject({ kind: z.literal('clarification'), reply: text, questions: z.array(shortText).min(1).max(20) }),
]);
export type CommandIntent = z.infer<typeof CommandIntentSchema>;
export const CommandResultSchema = z.strictObject({ reply: text, mutationResult: MutationResultSchema.nullable(), items: z.array(CalendarItemSchema).default([]), resourcesToOpen: ResourceReferencesSchema.optional(), conversationState: ConversationStateSchema.optional() });
export type CommandResult = z.infer<typeof CommandResultSchema>;
/** CSV/XLSX chooser runs in main; no arbitrary renderer filesystem path or read/write primitive. */
export const CourseImportRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), operationId: IdSchema }),
  z.strictObject({ kind: z.literal('image'), operationId: IdSchema, imageDataUrl: ImageDataUrlSchema }),
  z.strictObject({ kind: z.literal('source'), operationId: IdSchema, sourceId: IdSchema }),
  z.strictObject({ kind: z.literal('text'), operationId: IdSchema, text: text.trim().min(1) }),
]);
export type CourseImportRequest = z.infer<typeof CourseImportRequestSchema>;
export const CourseDraftSchema = z.strictObject({ row: z.number().int().positive(), cells: z.array(z.string().max(2000)).max(8), errors: z.array(shortText).max(20) });
export const CourseImportResultSchema = z.strictObject({ sourceId: IdSchema.nullable().default(null), courses: z.array(CourseInputSchema), drafts: z.array(CourseDraftSchema).max(500).default([]), uncertainties: z.array(shortText), message: shortText });
export type CourseImportResult = z.infer<typeof CourseImportResultSchema>;
/** Typed private durable receipts; no credentials or unvalidated model output. */
export const WorkflowReceiptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), sourceId: IdSchema }),
  z.strictObject({ kind: z.literal('analysis'), sourceId: IdSchema, result: AnalysisResultSchema.nullable() }),
  z.strictObject({ kind: z.literal('command'), intent: CommandIntentSchema.nullable(), result: CommandResultSchema.nullable(), ledgerProposal: LedgerCommandProposalSchema.optional() }),
  z.strictObject({ kind: z.literal('courses'), sourceId: IdSchema.nullable().default(null), result: CourseImportResultSchema.nullable() }),
]);
export type WorkflowReceipt = z.infer<typeof WorkflowReceiptSchema>;
export const SaveSettingsRequestSchema = z.strictObject({ settings: SettingsSchema, expectedSettings: SettingsSchema.optional() });
export const SetApiKeyRequestSchema = z.strictObject({ key: z.string().trim().min(1).max(2000).nullable(), expectedRevision: AiConfigurationRevisionSchema.optional() });
export const BackupResultSchema = z.strictObject({ path: z.string(), includesSources: z.boolean() });
export type BackupResult = z.infer<typeof BackupResultSchema>;
export const RestoreRequestSchema = z.strictObject({ confirmed: z.boolean().default(false), confirmationToken: IdSchema.optional() });
export type RestoreRequest = z.input<typeof RestoreRequestSchema>;
export const RestoreResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('preview'), message: shortText, confirmationToken: IdSchema, counts: z.record(EntityKindSchema, z.number().int().nonnegative()) }),
  z.strictObject({ status: z.literal('restored'), message: shortText, safetyBackupPath: z.string() }),
]);
export type RestoreResult = z.infer<typeof RestoreResultSchema>;
export const ChangedEventSchema = z.strictObject({ reason: z.enum(['mutation', 'undo', 'import', 'analysis', 'settings', 'restore', 'key']), transactionId: IdSchema.optional() });
export type ChangedEvent = z.infer<typeof ChangedEventSchema>;
export const SelectedImageSchema = z.strictObject({ imageDataUrl: ImageDataUrlSchema, label: z.string().max(2000) });
export const SelectImageResultSchema = apiResultSchema(SelectedImageSchema.nullable());
export type SelectedImage = z.infer<typeof SelectedImageSchema>;
export const LocalSourceEvidenceRequestSchema = z.strictObject({ sourceId: IdSchema });
export const LocalSourceEvidenceSchema = z.strictObject({ sourceId: IdSchema, match: z.enum(['legacy-id', 'distilled-index']), sources: z.array(SourceSchema).min(1).max(100) });
export const NavigateEventSchema = z.strictObject({ entity: EntityKindSchema, id: IdSchema });
export type NavigateEvent = z.infer<typeof NavigateEventSchema>;
/** Only this narrow asynchronous surface may cross the sandboxed renderer/preload boundary. */
export interface DesktopAPI extends importCaptureAPI, ResourceDesktopAPI {
  localSourceEvidence(request: z.input<typeof LocalSourceEvidenceRequestSchema>): Promise<ApiResult<z.infer<typeof LocalSourceEvidenceSchema>>>;
  spaceSnapshot(): Promise<ApiResult<import('./space').SpaceSnapshot>>;
  spaceConfigure(policy: import('./space').SpacePolicy): Promise<ApiResult<import('./space').SpaceSnapshot>>;
  spaceCleanup(request: { clearCache: boolean }): Promise<ApiResult<import('./space').SpaceSnapshot>>;
  updateSnapshot(): Promise<ApiResult<import('./update').UpdateState>>;
  checkForUpdates(): Promise<ApiResult<import('./update').UpdateState>>;
  downloadUpdate(): Promise<ApiResult<import('./update').UpdateState>>;
  installUpdate(): Promise<ApiResult<import('./update').UpdateState>>;
  onUpdateChanged(listener: (state: import('./update').UpdateState) => void): () => void;
  ledgerSnapshot(request?: { month?: string }): Promise<ApiResult<import('./ledger').LedgerSnapshot>>;
  ledgerMutate(request: import('./ledger').LedgerMutationRequest): Promise<ApiResult<import('./ledger').LedgerMutationResult>>;
  ledgerUndo(request: import('./ledger').LedgerUndoRequest): Promise<ApiResult<import('./ledger').LedgerMutationResult>>;
  ledgerExport(request: { format: 'csv' | 'json'; month?: string }): Promise<ApiResult<{ path: string }>>;
  accountSnapshot(): Promise<ApiResult<import('./account').AccountState>>;
  refreshAccount(): Promise<ApiResult<import('./account').AccountState>>;
  onAccountChanged(listener: (state: import('./account').AccountState) => void): () => void;
  selectImage(): Promise<ApiResult<SelectedImage | null>>;
  onNavigate(listener: (event: NavigateEvent) => void): () => void;
  snapshot(): Promise<ApiResult<Snapshot>>;
  mutate(request: MutationRequestInput): Promise<ApiResult<MutationResult>>;
  undo(transactionId?: string): Promise<ApiResult<MutationResult>>;
  importSource(request: ImportSourceRequest): Promise<ApiResult<Source>>;
  analyzeSource(request: AnalyzeSourceRequest): Promise<ApiResult<AnalysisResult>>;
  command(request: CommandRequest): Promise<ApiResult<CommandResult>>;
  importCourses(request: CourseImportRequest): Promise<ApiResult<CourseImportResult>>;
  saveSettings(request: z.input<typeof SaveSettingsRequestSchema>): Promise<ApiResult<Settings>>;
  setApiKey(request: z.input<typeof SetApiKeyRequestSchema>): Promise<ApiResult<KeyStatus>>;
  retryApiKey(): Promise<ApiResult<KeyStatus>>;
  backup(): Promise<ApiResult<BackupResult>>;
  restore(request: RestoreRequest): Promise<ApiResult<RestoreResult>>;
  onChanged(listener: (event: ChangedEvent) => void): () => void;
}
declare global { interface Window { planner?: DesktopAPI } }
