import { describe, expect, it } from 'vitest';
import { CandidateSchema, SourceSchema } from '../shared/contracts';
import { recentCaptureCandidates } from './candidate-context';

const at = '2027-03-08T09:00:00+08:00';
function event(id: string, status = 'pending', groupId = 'synthetic-group') {
  const source = SourceSchema.parse({ id: `source-${id}`, version: 1, createdAt: at, updatedAt: at, importedAt: at,
    kind: 'text', text: '合成活动通知', sentAt: at,
    captureRef: { accountId: 'synthetic-account', groupId, messageId: `message-${id}`, attachmentId: null, locator: '正文', transcribed: false } });
  const candidate = CandidateSchema.parse({ id, version: 1, createdAt: at, updatedAt: at,
    title: `合成活动${id}`, status, sourceIds: [source.id] });
  return { source, candidate };
}
const scope = { accountId: 'synthetic-account', groupId: 'synthetic-group' };

describe('candidate IDs for preceding notice context', () => {
  it('retains an accepted contextual target ahead of unrelated pending cards without changing it', () => {
    const unrelated = Array.from({ length: 35 }, (_, index) => event(`other-${index}`));
    const original = event('meeting', 'accepted');
    const all = [...unrelated, original], candidates = all.map(item => item.candidate), sources = all.map(item => item.source);
    expect(recentCaptureCandidates(candidates, sources, scope).some(item => item.id === 'meeting')).toBe(false);
    const result = recentCaptureCandidates(candidates, sources, scope, new Set(), new Set(['message-meeting']));
    expect(result).toHaveLength(30);
    expect(result[0]).toEqual(original.candidate);
    expect(result[0]!.status).toBe('accepted');
  });

  it('keeps current staged targets first and never imports another group through context priority', () => {
    const staged = event('staged'), original = event('meeting', 'accepted'), other = event('other', 'pending', 'another-group');
    const all = [original, other, staged];
    const result = recentCaptureCandidates(all.map(item => item.candidate), all.map(item => item.source), scope,
      new Set(['staged']), new Set(['message-meeting', 'message-other']));
    expect(result.map(item => item.id)).toEqual(['staged', 'meeting']);
  });
});
