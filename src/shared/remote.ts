import { z } from 'zod';
import { IdSchema } from './contracts';

export const RemoteIdentitySchema = z.strictObject({ protocolVersion: z.literal(1), dataInstanceId: z.string().uuid(), generation: z.number().int().positive() });
export type RemoteIdentity = z.infer<typeof RemoteIdentitySchema>;
export const REMOTE_METHODS = ['snapshot', 'mutate', 'undo', 'command', 'importSource', 'analyzeSource', 'ledgerSnapshot', 'ledgerMutate', 'ledgerUndo'] as const;
export const RemoteMethodSchema = z.enum(REMOTE_METHODS);
export type RemoteMethod = z.infer<typeof RemoteMethodSchema>;
export const RemoteRequestSchema = z.strictObject({ requestId: IdSchema, identity: RemoteIdentitySchema, input: z.unknown().optional() });
export type RemoteRequest = z.infer<typeof RemoteRequestSchema>;
export const RemoteDeviceSchema = z.strictObject({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) });
export type RemoteDevice = z.infer<typeof RemoteDeviceSchema>;
export const RemoteSessionSchema = z.union([
  z.strictObject({ paired: z.literal(false) }),
  z.strictObject({ paired: z.literal(true), identity: RemoteIdentitySchema, device: RemoteDeviceSchema, csrfToken: z.string(), aiConfigured: z.boolean() }),
]);
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;
export const RemoteOperationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('processing'), requestId: IdSchema, method: RemoteMethodSchema }),
  z.strictObject({ status: z.literal('interrupted'), requestId: IdSchema, method: RemoteMethodSchema }),
  z.strictObject({ status: z.literal('completed'), requestId: IdSchema, method: RemoteMethodSchema, result: z.unknown() }),
]);
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;
export const PairRequestSchema = z.strictObject({ code: z.string().min(16).max(100), name: RemoteDeviceSchema.shape.name });
