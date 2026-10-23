import { z } from 'zod';

/** The renderer can observe updates, but cannot choose a source URL or installer path. */
export const UpdateStateSchema = z.strictObject({
  currentVersion: z.string().min(1).max(100),
  status: z.enum(['unavailable', 'idle', 'checking', 'available', 'downloading', 'downloaded', 'installing', 'error']),
  latestVersion: z.string().min(1).max(100).nullable(),
  releaseNotes: z.string().max(20_000),
  progressPercent: z.number().finite().min(0).max(100).nullable(),
  checkedAt: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(2000),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;
