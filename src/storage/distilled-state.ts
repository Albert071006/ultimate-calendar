import { z } from 'zod';
import { CandidateSchema } from '../shared/contracts';
import { DistilledEventIdSchema, DistilledFieldsSchema, DistilledRevisionSchema, distilledFields } from '../shared/distilled';
import type { StoredState } from './repository';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidateId = z.union([z.string().uuid(), z.string().regex(/^distilled-candidate:[a-f0-9]{64}$/)]);
const eventVersion = z.strictObject({ revision: DistilledRevisionSchema, fingerprint: digest });
export const DistilledBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), id: z.string().regex(/^distilled-event:[a-f0-9]{64}$/), candidateId, baseline: DistilledFieldsSchema, version: eventVersion.nullable() }),
  z.strictObject({ kind: z.literal('revision'), id: z.string().regex(/^distilled-event-item:[a-f0-9]{64}$/), fingerprint: digest, candidateId }),
  z.strictObject({ kind: z.literal('legacy'), id: z.string().regex(/^distilled-item:[a-f0-9]{64}$/), fingerprint: digest, candidateId, baseline: DistilledFieldsSchema }),
  z.strictObject({ kind: z.literal('owner'), id: z.string().regex(/^distilled-(migration|legacy)-owner:[a-f0-9]{64}$/), eventId: DistilledEventIdSchema }),
]);
export type DistilledBinding = z.infer<typeof DistilledBindingSchema>;

function legacyEventVersion(encoded: string) {
  const match = /^event-head-v1:([1-9][0-9]*):([1-9][0-9]*):([a-f0-9]{64})$/.exec(encoded);
  // Early exports replaced a literal JSON version with a one-way digest.
  if (/^redacted:[a-f0-9]{64}$/.test(encoded)) return null;
  try { return eventVersion.parse(match ? { revision: [Number(match[1]), Number(match[2])], fingerprint: match[3] } : JSON.parse(encoded)); }
  catch { throw Error('事件同步状态损坏'); }
}

/** Only historical bridge-owned entity receipts have a business projection. Batch and
 * workflow receipts never enter it. Copy only whitelisted collector fields, never the
 * candidate's user edits, original quotes, capture references or source image. */
function legacyBinding(operation: StoredState['operations'][number]): DistilledBinding | undefined {
  const { id, result, fingerprint } = operation;
  if (!/^distilled-(event|event-item|item|legacy-owner|migration-owner):[a-f0-9]{64}$/.test(id)
      || !('entities' in result) || result.entities.length !== 1) return;
  const candidate = CandidateSchema.parse(result.entities[0]);
  if (id.startsWith('distilled-event:')) return DistilledBindingSchema.parse({
    kind: 'event', id, candidateId: candidate.id, baseline: distilledFields(candidate), version: legacyEventVersion(fingerprint),
  });
  if (id.startsWith('distilled-event-item:')) return DistilledBindingSchema.parse({ kind: 'revision', id, candidateId: candidate.id, fingerprint });
  if (id.startsWith('distilled-item:')) return DistilledBindingSchema.parse({ kind: 'legacy', id, candidateId: candidate.id, fingerprint, baseline: distilledFields(candidate) });
  return DistilledBindingSchema.parse({ kind: 'owner', id, eventId: fingerprint });
}

export function migrateLegacyDistilledState(state: StoredState): void {
  const seen = new Set(state.distilled?.map(binding => binding.id));
  state.operations = state.operations.filter(operation => {
    const binding = legacyBinding(operation);
    if (!binding) return true;
    if (seen.has(binding.id)) throw Error('摘要事件状态重复');
    seen.add(binding.id); (state.distilled ??= []).push(binding);
    return false;
  });
}
