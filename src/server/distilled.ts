import { createHash } from 'node:crypto';
import { CandidateSchema, SourceSchema, WorkflowReceiptSchema } from '../shared/contracts';
import { DistilledRequestSchema, DistilledResultSchema, type DistilledRequest } from '../shared/distilled';
import { type Repository, findEntity, putEntity } from '../storage/repository';
import { nowInstant } from '../domain/time';
import { RemoteFault } from './state';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function importDistilled(repository: Repository, input: DistilledRequest) {
  const request = DistilledRequestSchema.parse(input), batchId = `distilled-batch:${hash(request.requestId)}`, fingerprint = hash(request.items);
  return repository.transact(state => {
    const previous = state.operations.find(operation => operation.id === batchId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RemoteFault(409, '提炼请求编号已用于不同内容');
      const cached = WorkflowReceiptSchema.parse(previous.result);
      if (cached.kind !== 'analysis' || !cached.result) throw Error('提炼回执损坏');
      return DistilledResultSchema.parse({ candidateIds: cached.result.candidateIds, created: Number(cached.result.message) });
    }
    const candidateIds: string[] = []; let created = 0;
    for (const item of request.items) {
      const receiptId = `distilled-item:${hash(item.distilledId)}`, itemFingerprint = hash(item);
      const receipt = state.operations.find(operation => operation.id === receiptId);
      if (receipt) {
        if (receipt.fingerprint !== itemFingerprint) throw new RemoteFault(409, '同一提炼编号内容不同，请在采集端核对');
        if (!('entities' in receipt.result)) throw Error('提炼条目回执损坏');
        candidateIds.push(CandidateSchema.parse(receipt.result.entities[0]).id); continue;
      }
      const sourceId = `distilled-source:${hash(item.distilledId)}`, candidateId = `distilled-candidate:${hash(item.distilledId)}`;
      if (findEntity(state, 'source', sourceId) || findEntity(state, 'candidate', candidateId)) throw new RemoteFault(409, '提炼编号与已有资料冲突');
      const at = nowInstant();
      putEntity(state, 'source', SourceSchema.parse({ id: sourceId, version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text: '原文留在采集电脑；此处仅保存提炼结果。', label: '采集电脑提炼', status: 'succeeded' }));
      const { distilledId: _id, ...values } = item;
      const candidate = CandidateSchema.parse({ ...values, id: candidateId, version: 1, createdAt: at, updatedAt: at, sourceIds: [sourceId], sourceQuote: '', temporalEvidence: [] });
      putEntity(state, 'candidate', candidate);
      state.operations.push({ id: receiptId, fingerprint: itemFingerprint, result: { entities: [candidate] } });
      candidateIds.push(candidateId); created++;
    }
    const result = DistilledResultSchema.parse({ candidateIds, created });
    state.operations.push({ id: batchId, fingerprint, result: { kind: 'analysis', sourceId: batchId, result: { sourceId: batchId, status: 'succeeded', candidateIds, message: String(created) } } }); return result;
  });
}
