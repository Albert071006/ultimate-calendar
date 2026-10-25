import { z } from 'zod';
import { DeadlineSchema, InstantSchema, TitleSchema, IdSchema } from './contracts';
import { RemoteIdentitySchema } from './remote';

/** Only extracted actionable fields cross from the collection computer. No raw evidence. */
export const DistilledItemSchema = z.strictObject({
  distilledId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
  // Optional lineage for newer collectors. Only opaque hashes and an ordered revision cross the bridge.
  eventId: z.string().regex(/^qqe_[a-f0-9]{64}$/).optional(),
  eventRevision: z.tuple([z.number().int().positive().safe(), z.number().int().positive().safe()]).optional(),
  legacyDistilledIds: z.array(z.string().regex(/^qqd_[a-f0-9]{64}$/)).max(100).optional(),
  legacyCandidateKey: z.string().regex(/^qqm_[a-f0-9]{64}$/).optional(),
  title: TitleSchema, action: z.string().max(4000).default(''), benefit: z.string().max(2000).default(''),
  benefitKind: z.enum(['stated', 'inferred', 'unknown']).default('unknown'), potentialBenefit: z.string().max(2000).default(''),
  conditions: z.array(z.string().max(500)).max(30).default([]), uncertainties: z.array(z.string().max(500)).max(30).default([]),
  deadline: DeadlineSchema.nullable().default(null), eventStart: InstantSchema.nullable().default(null), eventEnd: InstantSchema.nullable().default(null),
  location: z.string().max(500).default(''),
}).refine(value => value.eventEnd === null || value.eventStart !== null && Date.parse(value.eventEnd) > Date.parse(value.eventStart), '结束时间必须晚于开始')
  .refine(value => Boolean(value.eventId) === Boolean(value.eventRevision) && (!(value.legacyDistilledIds || value.legacyCandidateKey) || Boolean(value.eventId)), '事件身份和修订必须同时提供');
export const DistilledRequestSchema = z.strictObject({ requestId: IdSchema, identity: RemoteIdentitySchema, items: z.array(DistilledItemSchema).min(1).max(100) });
export type DistilledRequest = z.infer<typeof DistilledRequestSchema>;
export const DistilledResultSchema = z.strictObject({ candidateIds: z.array(IdSchema), created: z.number().int().nonnegative() });
export type DistilledResult = z.infer<typeof DistilledResultSchema>;
