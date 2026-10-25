import { z } from 'zod';

// Keep status independent of request identity/contracts so desktop IPC can share it.
export const AiConfigurationRevisionSchema = z.string().uuid().nullable();
export const AiConfigurationStatusSchema = z.strictObject({
  provider: z.literal('deepseek'),
  configured: z.boolean(),
  editable: z.boolean(),
  source: z.enum(['managed', 'external', 'none']),
  revision: AiConfigurationRevisionSchema,
});
export type AiConfigurationStatus = z.infer<typeof AiConfigurationStatusSchema>;
