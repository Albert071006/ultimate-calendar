import { createHash } from 'node:crypto';
import { CandidateSchema, SourceSchema, WorkflowReceiptSchema, type Candidate } from '../shared/contracts';
import { DistilledRequestSchema, DistilledResultSchema, distilledFields, type DistilledFields, type DistilledRequest } from '../shared/distilled';
import type { DistilledBinding } from '../storage/distilled-state';
import { type Repository, type StoredState, findEntity, putEntity, records } from '../storage/repository';
import { nowInstant } from '../domain/time';
import { RemoteFault } from './state';
import { SOURCE_PLACEHOLDER } from './backup';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Item = DistilledRequest['items'][number];
function binding<K extends DistilledBinding['kind']>(state: StoredState, id: string, kind: K) {
  return state.distilled?.find((value): value is Extract<DistilledBinding, { kind: K }> => value.kind === kind && value.id === id);
}
function createCandidate(state: StoredState, item: Item, key: unknown, previous?: Candidate): Candidate {
  const candidateId = `distilled-candidate:${hash(key)}`, sourceId = previous?.sourceIds[0] ?? `distilled-source:${hash(key)}`, at = nowInstant();
  if (findEntity(state, 'candidate', candidateId) || !previous && findEntity(state, 'source', sourceId)) throw new RemoteFault(409, '提炼编号与已有资料冲突');
  if (!previous) putEntity(state, 'source', SourceSchema.parse({ id: sourceId, version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text: '原文留在采集电脑；此处仅保存提炼结果。', label: '采集电脑提炼', status: 'succeeded' }));
  const candidate = CandidateSchema.parse({ ...distilledFields(item), id: candidateId, version: 1, createdAt: at, updatedAt: at, sourceIds: previous?.sourceIds ?? [sourceId], sourceQuote: '', temporalEvidence: [], revisionOfId: previous?.id ?? null });
  putEntity(state, 'candidate', candidate); return candidate;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function claimMigratedCandidate(state: StoredState, item: Item): Candidate | undefined {
  if (!item.legacyCandidateKey) return;
  // Offline migration retained UUIDs, but intentionally did not invent distilled-item receipts.
  const candidate = records(state, 'candidate').find(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id) && `qqm_${hash({ legacyCandidateId: value.id })}` === item.legacyCandidateKey);
  if (!candidate || candidate.sourceQuote || candidate.temporalEvidence.length || !candidate.sourceIds.every(id => {
    const source = findEntity(state, 'source', id);
    return source?.kind === 'text' && source.text === SOURCE_PLACEHOLDER && source.label === '采集电脑提炼' && source.imageDataUrl === null && !source.captureRef;
  })) return;
  const ownerId = `distilled-migration-owner:${hash(item.legacyCandidateKey)}`, owner = binding(state, ownerId, 'owner');
  if (owner && owner.eventId !== item.eventId) return;
  if (!owner) (state.distilled ??= []).push({ kind: 'owner', id: ownerId, eventId: item.eventId! });
  return candidate;
}
/** Early online restores erased the bridge's event heads but retained its generated
 * entity IDs and the sanitized source. With no upstream baseline, the first
 * contact may only rebind a single proven root, never change the card itself. */
function restoredEventRoot(state: StoredState, eventId: string): Candidate | undefined {
  const key = hash(eventId), candidate = findEntity(state, 'candidate', `distilled-candidate:${key}`);
  if (!candidate) return;
  const sourceId = `distilled-source:${key}`, source = findEntity(state, 'source', sourceId);
  if (candidate.revisionOfId || candidate.sourceIds.length !== 1 || candidate.sourceIds[0] !== sourceId
      || candidate.sourceQuote || candidate.temporalEvidence.length
      || source?.kind !== 'text' || source.text !== SOURCE_PLACEHOLDER || source.label !== '采集电脑提炼'
      || source.imageDataUrl !== null || source.captureRef) return;
  if (state.distilled?.some(entry => 'candidateId' in entry && entry.candidateId === candidate.id)
      || records(state, 'candidate').some(other => other.id !== candidate.id
        && (other.revisionOfId === candidate.id || other.sourceIds.includes(sourceId)))) return;
  return candidate;
}
/** A field edited on the receiving device wins over the collector's next update. */
function mergePending(current: Candidate, before: DistilledFields, values: DistilledFields): Candidate {
  const merged = { ...current };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    if (key === 'eventStart' || key === 'eventEnd') continue;
    if (equal(current[key], before[key])) Object.assign(merged, { [key]: values[key] });
  }
  // The interval is one editable value: never combine independently edited endpoints.
  if (current.eventStart === before.eventStart && current.eventEnd === before.eventEnd) Object.assign(merged, { eventStart: values.eventStart, eventEnd: values.eventEnd });
  return equal(merged, current) ? current : CandidateSchema.parse({ ...merged, version: current.version + 1, updatedAt: nowInstant() });
}
function importEvent(state: StoredState, item: Item): { candidateId: string; created: number } {
  const eventId = item.eventId!, revision = item.eventRevision!, values = distilledFields(item), itemFingerprint = hash({ ...values, eventId, eventRevision: revision });
  const receiptId = `distilled-event-item:${hash({ eventId, revision })}`, headId = `distilled-event:${hash(eventId)}`;
  const receipt = binding(state, receiptId, 'revision'), bindings = state.distilled ??= [];
  if (receipt) {
    if (receipt.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一事件修订内容不同，请在采集端核对');
    return { candidateId: receipt.candidateId, created: 0 };
  }
  const head = binding(state, headId, 'event');
  let candidateId: string | undefined, before: DistilledFields | undefined, bindOnly = false;
  if (head) {
    candidateId = head.candidateId; before = head.baseline;
    if (head.version) {
      const previous = head.version, order = revision[0] - previous.revision[0] || revision[1] - previous.revision[1];
      if (order === 0 && previous.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一事件修订内容不同，请在采集端核对');
      if (order <= 0) {
        bindings.push({ kind: 'revision', id: receiptId, fingerprint: itemFingerprint, candidateId });
        return { candidateId, created: 0 };
      }
    } else {
      // Very old backups hashed away the previous revision. Establish the next known
      // baseline without overwriting a user's card with a possibly stale update.
      bindOnly = true;
    }
  } else {
    const migrated = claimMigratedCandidate(state, item);
    if (migrated) { candidateId = migrated.id; bindOnly = true; }
    // Claim only an actual old-client receipt, once. Equal text from independent new events never merges.
    for (const alias of migrated ? [] : new Set([item.distilledId, ...(item.legacyDistilledIds ?? [])])) {
      const legacy = binding(state, `distilled-item:${hash(alias)}`, 'legacy');
      if (!legacy) continue;
      const ownerId = `distilled-legacy-owner:${hash(alias)}`, owner = binding(state, ownerId, 'owner');
      if (owner && owner.eventId !== eventId) continue;
      candidateId = legacy.candidateId; before = legacy.baseline;
      if (!owner) bindings.push({ kind: 'owner', id: ownerId, eventId });
      break;
    }
    if (!candidateId) {
      const restored = restoredEventRoot(state, eventId);
      if (restored) { candidateId = restored.id; bindOnly = true; }
    }
  }
  let created = 0;
  if (!candidateId) { candidateId = createCandidate(state, item, eventId).id; created = 1; }
  else if (!bindOnly && before) {
    const current = findEntity(state, 'candidate', candidateId);
    if (current?.status === 'pending') putEntity(state, 'candidate', mergePending(current, before, values));
    if (current?.status === 'accepted' && !equal(before, values)) {
      candidateId = createCandidate(state, item, { eventId, revision }, current).id; created = 1;
    }
  }
  const next: DistilledBinding = { kind: 'event', id: headId, candidateId, version: { revision, fingerprint: itemFingerprint }, baseline: values };
  if (head) Object.assign(head, next); else bindings.push(next);
  bindings.push({ kind: 'revision', id: receiptId, fingerprint: itemFingerprint, candidateId });
  return { candidateId, created };
}
export function importDistilled(repository: Repository, input: DistilledRequest) {
  const request = DistilledRequestSchema.parse(input), batchId = `distilled-batch:${hash(request.requestId)}`, fingerprint = hash(request.items);
  return repository.transact(state => {
    const previous = state.operations.find(operation => operation.id === batchId);
    if (previous) {
      // A newly available migration hint must not invalidate a durable pre-upgrade request receipt.
      const beforeMigrationHint = request.items.some(item => item.legacyCandidateKey) ? hash(request.items.map(({ legacyCandidateKey: _hint, ...item }) => item)) : null;
      if (previous.fingerprint !== fingerprint && previous.fingerprint !== beforeMigrationHint) throw new RemoteFault(409, '提炼请求编号已用于不同内容');
      const cached = WorkflowReceiptSchema.parse(previous.result);
      if (cached.kind !== 'analysis' || !cached.result) throw Error('提炼回执损坏');
      return DistilledResultSchema.parse({ candidateIds: cached.result.candidateIds, created: Number(cached.result.message) });
    }
    const candidateIds: string[] = []; let created = 0;
    for (const item of request.items) {
      if (item.eventId) {
        const imported = importEvent(state, item); candidateIds.push(imported.candidateId); created += imported.created; continue;
      }
      const receiptId = `distilled-item:${hash(item.distilledId)}`, itemFingerprint = hash(item);
      const receipt = binding(state, receiptId, 'legacy');
      if (receipt) {
        if (receipt.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一提炼编号内容不同，请在采集端核对');
        candidateIds.push(receipt.candidateId); continue;
      }
      const candidate = createCandidate(state, item, item.distilledId);
      (state.distilled ??= []).push({ kind: 'legacy', id: receiptId, fingerprint: itemFingerprint, candidateId: candidate.id, baseline: distilledFields(item) });
      candidateIds.push(candidate.id); created++;
    }
    const result = DistilledResultSchema.parse({ candidateIds, created });
    state.operations.push({ id: batchId, fingerprint, result: { kind: 'analysis', sourceId: batchId, result: { sourceId: batchId, status: 'succeeded', candidateIds, message: String(created) } } }); return result;
  });
}
