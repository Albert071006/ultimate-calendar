import { z } from 'zod';
import { AiApiKeySchema, AiConfigurationRevisionSchema } from './ai-configuration';
import { RemoteIdentitySchema, type RemoteIdentity } from './remote';
import { SettingsSchema } from './contracts';

export const MAX_AI_KEY_SYNC_BYTES = 32 * 1024;
export const AiKeySyncKeyIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const AiKeySyncNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
// Canonical, unpadded base64url, including zero padding bits in the final sextet.
const encoded = z.string().min(1).max(2048).regex(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]|[A-Za-z0-9_-][AQgw])?$/);
export const AiKeySyncRequestSchema = z.strictObject({
  identity: RemoteIdentitySchema,
  nonce: AiKeySyncNonceSchema,
  keyId: AiKeySyncKeyIdSchema,
});
export type AiKeySyncRequest = z.infer<typeof AiKeySyncRequestSchema>;
export const AiKeySyncPlaintextSchema = z.strictObject({
  apiKey: AiApiKeySchema.nullable(),
  revision: AiConfigurationRevisionSchema,
  settings: SettingsSchema.pick({ model: true, reasoningEffort: true }).optional(),
});
export type AiKeySyncPlaintext = z.infer<typeof AiKeySyncPlaintextSchema>;
export const AiKeySyncEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  deviceId: z.string().uuid(),
  keyId: AiKeySyncKeyIdSchema,
  nonce: AiKeySyncNonceSchema,
  revision: AiConfigurationRevisionSchema,
  wrappedKey: encoded.length(512),
  iv: encoded.length(16),
  ciphertext: encoded,
  tag: encoded.length(22),
});
export type AiKeySyncEnvelope = z.infer<typeof AiKeySyncEnvelopeSchema>;
export const AiKeySyncResponseSchema = z.strictObject({
  ok: z.literal(true),
  identity: RemoteIdentitySchema,
  envelope: AiKeySyncEnvelopeSchema,
});
export type AiKeySyncResponse = z.infer<typeof AiKeySyncResponseSchema>;

/** Authenticates every binding field with identical ordering on both endpoints. */
export function aiKeySyncAad(identity: RemoteIdentity, envelope: Pick<AiKeySyncEnvelope, 'version' | 'deviceId' | 'keyId' | 'nonce' | 'revision'>): string {
  return JSON.stringify({
    version: envelope.version, deviceId: envelope.deviceId, keyId: envelope.keyId, nonce: envelope.nonce,
    identity: { protocolVersion: identity.protocolVersion, dataInstanceId: identity.dataInstanceId, generation: identity.generation },
    revision: envelope.revision,
  });
}
