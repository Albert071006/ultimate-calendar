import { z } from 'zod';
import { IdSchema, InstantSchema } from './contracts';

/** Bridge credentials never belong to this transport contract. */
export const LoopbackEndpointSchema = z.string().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'QQ 桥接地址必须是本机回环地址，且不能含凭据或查询参数');
export const CaptureConfigSchema = z.strictObject({
  enabled: z.boolean().default(false), analysisEnabled: z.boolean().default(true),
  accountId: IdSchema.nullable().default(null), groupIds: z.array(IdSchema).max(100).default([]),
  endpoint: LoopbackEndpointSchema.default('ws://127.0.0.1:43131'),
  flavor: z.enum(['napcat', 'snowluma']).default('napcat'),
  historyDays: z.literal(7).default(7), intervalSeconds: z.literal(120).default(120),
}).refine(value => new Set(value.groupIds).size === value.groupIds.length, '群选择不能重复')
  .refine(value => value.accountId !== null || (!value.enabled && value.groupIds.length === 0), '启用采集或选择群之前需要确认 QQ 账号');
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

export const CapturePageRequestSchema = z.strictObject({
  accountId: IdSchema.optional(), groupId: IdSchema.optional(), messageId: IdSchema.optional(),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});
export type CapturePageRequest = z.input<typeof CapturePageRequestSchema>;
export const AttachmentStatusSchema = z.enum(['pending', 'downloading', 'extracting', 'ready', 'unsupported', 'failed', 'too-large', 'encrypted', 'deleted']);
export const AttachmentSummarySchema = z.strictObject({
  id: IdSchema, name: z.string().max(1000), kind: z.enum(['image', 'file', 'voice', 'video', 'other']),
  status: AttachmentStatusSchema, size: z.number().int().nonnegative().nullable(),
  error: z.string().max(2000).nullable(), chunkCount: z.number().int().nonnegative(),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;
export const CaptureMessageViewSchema = z.strictObject({
  id: IdSchema, accountId: IdSchema, groupId: IdSchema, messageId: IdSchema,
  groupName: z.string().max(1000), senderName: z.string().max(1000),
  sentAt: InstantSchema, importedAt: InstantSchema, text: z.string().max(1_000_000),
  changed: z.boolean(), deleted: z.boolean(), attachments: z.array(AttachmentSummarySchema).max(100),
});
export type CaptureMessageView = z.infer<typeof CaptureMessageViewSchema>;
export const BatchStatusSchema = z.enum(['pending', 'preparing', 'requesting', 'uncertain', 'result-ready', 'applied', 'failed']);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export const CaptureBatchViewSchema = z.strictObject({
  id: IdSchema, operationId: IdSchema, accountId: IdSchema, groupId: IdSchema,
  status: BatchStatusSchema, createdAt: InstantSchema, updatedAt: InstantSchema,
  messageCount: z.number().int().nonnegative(), attemptCount: z.number().int().nonnegative(),
  error: z.string().max(2000).nullable(),
});
export type CaptureBatchView = z.infer<typeof CaptureBatchViewSchema>;
export const GroupCoverageSchema = z.strictObject({
  accountId: IdSchema, groupId: IdSchema,
  status: z.enum(['not-started', 'fetching', 'complete', 'partial', 'failed']),
  windowStart: InstantSchema, windowEnd: InstantSchema, earliestAt: InstantSchema.nullable(),
  cursor: z.string().max(2000).nullable(), fetchedCount: z.number().int().nonnegative(),
  updatedAt: InstantSchema, error: z.string().max(2000).nullable(),
});
export type GroupCoverage = z.infer<typeof GroupCoverageSchema>;
export const CaptureCleanupRequestSchema = z.strictObject({
  accountId: IdSchema, groupId: IdSchema.optional(), before: InstantSchema.optional(),
}).refine(value => value.groupId !== undefined || value.before !== undefined, '清理需要指定群或截止时间');
export type CaptureCleanupRequest = z.infer<typeof CaptureCleanupRequestSchema>;
export const CaptureStatsSchema = z.strictObject({
  messages: z.number().int().nonnegative(), attachments: z.number().int().nonnegative(),
  attachmentBytes: z.number().int().nonnegative(), pendingMessages: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(), pendingBatches: z.number().int().nonnegative(),
  uncertainBatches: z.number().int().nonnegative(), failedAttachments: z.number().int().nonnegative(),
});
export type CaptureStats = z.infer<typeof CaptureStatsSchema>;
export const CaptureSnapshotSchema = z.strictObject({
  config: CaptureConfigSchema,
  connection: z.enum(['disconnected', 'connecting', 'online', 'error', 'account-changed']),
  accountLabel: z.string().max(200).nullable(), error: z.string().max(2000).nullable(),
  accountName: z.string().max(200).nullable().default(null),
  lastReceivedAt: InstantSchema.nullable(), credentialConfigured: z.boolean(),
  stats: CaptureStatsSchema, coverage: z.array(GroupCoverageSchema).max(100),
});
export type CaptureSnapshot = z.infer<typeof CaptureSnapshotSchema>;
export const CaptureGroupSchema = z.strictObject({ id: IdSchema, name: z.string().max(1000) });
export type CaptureGroup = z.infer<typeof CaptureGroupSchema>;
export const CaptureMessagePageSchema = z.strictObject({ items: z.array(CaptureMessageViewSchema).max(100), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() });
export const CaptureBatchPageSchema = z.strictObject({ items: z.array(CaptureBatchViewSchema).max(100), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() });
