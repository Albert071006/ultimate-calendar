import { z } from 'zod';
import { RemoteIdentitySchema } from './remote';

// Accept surrounding paste whitespace, but never whitespace or control characters inside a token.
export const AiApiKeySchema = z.string().trim().min(16).max(512).regex(/^[\x21-\x7e]+$/);
export const AiConfigurationRevisionSchema = z.string().uuid().nullable();
export const AiConfigurationStatusSchema = z.strictObject({
  provider: z.literal('deepseek'),
  configured: z.boolean(),
  editable: z.boolean(),
  source: z.enum(['managed', 'external', 'none']),
  revision: AiConfigurationRevisionSchema,
});
export type AiConfigurationStatus = z.infer<typeof AiConfigurationStatusSchema>;
export const AiConfigurationUpdateSchema = z.strictObject({
  identity: RemoteIdentitySchema,
  expectedRevision: AiConfigurationRevisionSchema,
  apiKey: AiApiKeySchema,
});
export type AiConfigurationUpdate = z.infer<typeof AiConfigurationUpdateSchema>;
export const AiConfigurationClearSchema = z.strictObject({
  identity: RemoteIdentitySchema,
  expectedRevision: AiConfigurationRevisionSchema,
});
export type AiConfigurationClear = z.infer<typeof AiConfigurationClearSchema>;
