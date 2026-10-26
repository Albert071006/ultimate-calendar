import { z } from 'zod';
import { LocalSourceEvidenceRequestSchema, LocalSourceEvidenceSchema } from '../shared/contracts';
import type { Repository } from '../storage/repository';
import { evidenceIndexPath, readEvidenceSourceIds } from '../bridge/evidence-index';
import { WorkflowError } from '../ai/deepseek';

export { LocalSourceEvidenceRequestSchema };
export const LocalSourceEvidenceResultSchema = LocalSourceEvidenceSchema;
export type LocalSourceEvidenceResult = z.infer<typeof LocalSourceEvidenceResultSchema>;

/** The collector owns this already-open repository. The cloud window never opens a second local writer. */
export function createLocalEvidenceResolver(repository: Pick<Repository, 'path' | 'read'>) {
  return (input: unknown): LocalSourceEvidenceResult => {
    const { sourceId } = LocalSourceEvidenceRequestSchema.parse(input), sources = repository.read().entities.source;
    const sameId = sources.find(value => value.id === sourceId);
    if (sameId) return LocalSourceEvidenceResultSchema.parse({ sourceId, match: 'legacy-id', sources: [sameId] });
    const ids = readEvidenceSourceIds(evidenceIndexPath(repository.path), sourceId);
    const matched = ids.map(id => sources.find(value => value.id === id)).filter(value => value !== undefined);
    if (!matched.length) throw new WorkflowError('NOT_FOUND', '本机没有找到这份来源的对应原文；可能尚未建立关联或原文已经清理。');
    return LocalSourceEvidenceResultSchema.parse({ sourceId, match: 'distilled-index', sources: matched });
  };
}
