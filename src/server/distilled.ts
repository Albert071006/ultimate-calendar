import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CandidateSchema, SourceSchema, WorkflowReceiptSchema, type Candidate } from '../shared/contracts';
import { DistilledRequestSchema, DistilledResultSchema, type DistilledRequest } from '../shared/distilled';
import { type Repository, type StoredState, findEntity, putEntity, records } from '../storage/repository';
import { nowInstant } from '../domain/time';
import { RemoteFault } from './state';
import { SOURCE_PLACEHOLDER } from './backup';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Item = DistilledRequest['items'][number];
const EventHeadSchema = z.strictObject({
  revision: z.tuple([z.number().int().positive().safe(), z.number().int().positive().safe()]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
function readEventHead(encoded: string) {
  const match = /^event-head-v1:([1-9][0-9]*):([1-9][0-9]*):([a-f0-9]{64})$/.exec(encoded);
  let value: unknown;
  try { value = match ? { revision: [Number(match[1]), Number(match[2])], fingerprint: match[3] } : JSON.parse(encoded); }
  catch { throw Error('事件同步状态损坏'); }
  const parsed = EventHeadSchema.safeParse(value); if (!parsed.success) throw Error('事件同步状态损坏');
  return parsed.data;
}
// Only revision integers and a digest: safe backups redact literal JSON request fingerprints.
const encodeEventHead = (revision: [number, number], fingerprint: string) => `event-head-v1:${revision[0]}:${revision[1]}:${fingerprint}`;
function summary(item: Item) {
  const { distilledId: _id, eventId: _event, eventRevision: _revision, legacyDistilledIds: _aliases, legacyCandidateKey: _migration, ...values } = item;
  return values;
}
function baseline(receipt: StoredState['operations'][number]): Candidate {
  if (!('entities' in receipt.result)) throw Error('提炼条目回执损坏');
  return CandidateSchema.parse(receipt.result.entities[0]);
}
function createCandidate(state: StoredState, item: Item, key: unknown, previous?: Candidate): Candidate {
  const candidateId = `distilled-candidate:${hash(key)}`, sourceId = previous?.sourceIds[0] ?? `distilled-source:${hash(key)}`, at = nowInstant();
  if (findEntity(state, 'candidate', candidateId) || !previous && findEntity(state, 'source', sourceId)) throw new RemoteFault(409, '提炼编号与已有资料冲突');
  if (!previous) putEntity(state, 'source', SourceSchema.parse({ id: sourceId, version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text: '原文留在采集电脑；此处仅保存提炼结果。', label: '采集电脑提炼', status: 'succeeded' }));
  const candidate = CandidateSchema.parse({ ...summary(item), id: candidateId, version: 1, createdAt: at, updatedAt: at, sourceIds: previous?.sourceIds ?? [sourceId], sourceQuote: '', temporalEvidence: [], revisionOfId: previous?.id ?? null });
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
  const ownerId = `distilled-migration-owner:${hash(item.legacyCandidateKey)}`, owner = state.operations.find(operation => operation.id === ownerId);
  if (owner && owner.fingerprint !== item.eventId) return;
  if (!owner) state.operations.push({ id: ownerId, fingerprint: item.eventId!, result: { entities: [candidate] } });
  return candidate;
}
/** A field edited on the receiving device wins over the collector's next update. */
function mergePending(current: Candidate, before: Candidate, item: Item): Candidate {
  const values = summary(item), merged = { ...current };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    if (key === 'eventStart' || key === 'eventEnd') continue;
    if (equal(current[key], before[key])) Object.assign(merged, { [key]: values[key] });
  }
  // The interval is one editable value: never combine independently edited endpoints.
  if (current.eventStart === before.eventStart && current.eventEnd === before.eventEnd) Object.assign(merged, { eventStart: values.eventStart, eventEnd: values.eventEnd });
  return equal(merged, current) ? current : CandidateSchema.parse({ ...merged, version: current.version + 1, updatedAt: nowInstant() });
}
function importEvent(state: StoredState, item: Item): { candidate: Candidate; created: number } {
  const eventId = item.eventId!, revision = item.eventRevision!, itemFingerprint = hash({ ...summary(item), eventId, eventRevision: revision });
  const receiptId = `distilled-event-item:${hash({ eventId, revision })}`, headId = `distilled-event:${hash(eventId)}`;
  const receipt = state.operations.find(operation => operation.id === receiptId);
  if (receipt) {
    if (receipt.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一事件修订内容不同，请在采集端核对');
    return { candidate: baseline(receipt), created: 0 };
  }
  let head = state.operations.find(operation => operation.id === headId), before: Candidate | undefined, migrated = false;
  if (head) {
    before = baseline(head);
    const previous = readEventHead(head.fingerprint);
    const order = revision[0] - previous.revision[0] || revision[1] - previous.revision[1];
    if (order === 0 && previous.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一事件修订内容不同，请在采集端核对');
    if (order <= 0) {
      const candidate = findEntity(state, 'candidate', before.id) ?? before;
      state.operations.push({ id: receiptId, fingerprint: itemFingerprint, result: { entities: [candidate] } });
      return { candidate, created: 0 };
    }
  } else {
    before = claimMigratedCandidate(state, item); migrated = Boolean(before);
    // Claim only an actual old-client receipt, once. Equal text from independent new events never merges.
    for (const alias of before ? [] : new Set([item.distilledId, ...(item.legacyDistilledIds ?? [])])) {
      const legacy = state.operations.find(operation => operation.id === `distilled-item:${hash(alias)}`);
      if (!legacy) continue;
      const ownerId = `distilled-legacy-owner:${hash(alias)}`, owner = state.operations.find(operation => operation.id === ownerId);
      if (owner && owner.fingerprint !== eventId) continue;
      before = baseline(legacy);
      if (!owner) state.operations.push({ id: ownerId, fingerprint: eventId, result: { entities: [before] } });
      break;
    }
  }
  let candidate: Candidate, created = 0;
  if (!before) { candidate = createCandidate(state, item, eventId); created = 1; }
  else {
    const current = findEntity(state, 'candidate', before.id);
    // Deletion and ignore are decisions, not a reason to recreate a card.
    // A migrated card has no reliable collector baseline: first contact only binds it, preserving every user field/decision.
    if (!current || current.status === 'ignored' || migrated) candidate = current ?? before;
    else if (current.status === 'accepted') {
      if (Object.entries(summary(item)).every(([key, value]) => equal(before[key as keyof Candidate], value))) candidate = current;
      else { candidate = createCandidate(state, item, { eventId, revision }, current); created = 1; }
    } else { candidate = mergePending(current, before, item); putEntity(state, 'candidate', candidate); }
  }
  // Keep the collector's values as the three-way baseline, separately from any user's edited values.
  const nextBaseline = CandidateSchema.parse({ ...candidate, ...summary(item) });
  const next = { id: headId, fingerprint: encodeEventHead(revision, itemFingerprint), result: { entities: [nextBaseline] } };
  if (head) Object.assign(head, next); else { state.operations.push(next); head = next; }
  state.operations.push({ id: receiptId, fingerprint: itemFingerprint, result: { entities: [candidate] } });
  return { candidate, created };
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
        const imported = importEvent(state, item); candidateIds.push(imported.candidate.id); created += imported.created; continue;
      }
      const receiptId = `distilled-item:${hash(item.distilledId)}`, itemFingerprint = hash(item);
      const receipt = state.operations.find(operation => operation.id === receiptId);
      if (receipt) {
        if (receipt.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一提炼编号内容不同，请在采集端核对');
        if (!('entities' in receipt.result)) throw Error('提炼条目回执损坏');
        candidateIds.push(CandidateSchema.parse(receipt.result.entities[0]).id); continue;
      }
      const candidate = createCandidate(state, item, item.distilledId);
      state.operations.push({ id: receiptId, fingerprint: itemFingerprint, result: { entities: [candidate] } });
      candidateIds.push(candidate.id); created++;
    }
    const result = DistilledResultSchema.parse({ candidateIds, created });
    state.operations.push({ id: batchId, fingerprint, result: { kind: 'analysis', sourceId: batchId, result: { sourceId: batchId, status: 'succeeded', candidateIds, message: String(created) } } }); return result;
  });
}
