import { z } from 'zod';

export const SpacePolicySchema = z.strictObject({
  enabled: z.boolean().default(true),
  autoBackupKeep: z.number().int().min(1).max(30).default(7),
  safetyBackupKeep: z.number().int().min(1).max(20).default(3),
  backupBudgetMiB: z.number().int().min(256).max(65536).default(2048),
  attachmentDays: z.number().int().min(7).max(365).default(30),
  attachmentBudgetMiB: z.number().int().min(128).max(65536).default(1024),
});
export type SpacePolicy = z.infer<typeof SpacePolicySchema>;
const bytes = z.number().nonnegative();
export const AttachmentSpaceSchema = z.strictObject({
  totalBytes: bytes, eligibleBytes: bytes, protectedBytes: bytes, reclaimableBytes: bytes, remainingBytes: bytes,
  selectedAttachments: z.number().int().nonnegative(), protectedAttachments: z.number().int().nonnegative(), overBudgetBytes: bytes,
});
export const SpaceSnapshotSchema = z.strictObject({
  policy: SpacePolicySchema,
  backupDirectory: z.string(),
  databaseBytes: bytes, reusableBytes: bytes, cacheBytes: bytes,
  backupBytes: bytes, managedBackupBytes: bytes, unmanagedBackupBytes: bytes,
  backupCount: z.number().int().nonnegative(), removableBackupCount: z.number().int().nonnegative(), removableBackupBytes: bytes,
  attachments: AttachmentSpaceSchema,
  lastRunAt: z.string().nullable(), lastResult: z.string().nullable(), warnings: z.array(z.string()),
});
export type SpaceSnapshot = z.infer<typeof SpaceSnapshotSchema>;
export const SpaceCleanupRequestSchema = z.strictObject({ clearCache: z.boolean().default(false) });
