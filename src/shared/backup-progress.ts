import { z } from 'zod';

/** Only operational backup status crosses the UI boundary, never paths or data. */
export const BackupProgressSchema = z.object({
  status: z.enum(['never', 'ok', 'failed']),
  lastSuccessAt: z.string().nullable(),
  pending: z.boolean().default(false),
  pendingSince: z.string().nullable().default(null),
  running: z.boolean().default(false),
});
export type BackupProgress = z.infer<typeof BackupProgressSchema>;
