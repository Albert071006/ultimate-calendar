import { z } from 'zod';
import { RemoteIdentitySchema } from './remote';
import { AiConfigurationRevisionSchema } from './ai-configuration-status';
export { AiConfigurationRevisionSchema, AiConfigurationStatusSchema, type AiConfigurationStatus } from './ai-configuration-status';

// Accept surrounding paste whitespace, but never whitespace or control characters inside a token.
export const AiApiKeySchema = z.string().trim().min(16).max(512).regex(/^[\x21-\x7e]+$/);
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
