import type { Candidate, Source } from '../shared/contracts';

type Scope = { accountId: string; groupId: string };
/** Never infer cross-group identity from a similar title or copied notification. */
export function candidatesInCaptureScope(candidates: Candidate[], sources: Source[], scope: Scope): Candidate[] {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  return candidates.filter(candidate => candidate.sourceIds.length > 0 && candidate.sourceIds.every(id => {
    const ref = sourceById.get(id)?.captureRef;
    return ref?.accountId === scope.accountId && ref.groupId === scope.groupId;
  }));
}

export function captureCandidateContext(candidate: Candidate, sources: Source[]) {
  const ids = new Set(candidate.sourceIds);
  return { id: candidate.id, title: candidate.title, action: candidate.action, benefit: candidate.benefit,
    benefitKind: candidate.benefitKind, potentialBenefit: candidate.potentialBenefit, conditions: candidate.conditions,
    deadline: candidate.deadline, eventStart: candidate.eventStart, eventEnd: candidate.eventEnd,
    location: candidate.location, status: candidate.status, revisionOfId: candidate.revisionOfId,
    sourceSentAt: [...new Set(sources.filter(source => ids.has(source.id)).map(source => source.sentAt))].slice(-20),
  };
}

/** Bound the whole summaries, rather than truncating an event's conditions or repeating old images. */
export function recentCaptureCandidates(candidates: Candidate[], sources: Source[], scope: Scope, preferred: ReadonlySet<string> = new Set()): Candidate[] {
  const byId = new Map(sources.map(source => [source.id, source]));
  const latest = (candidate: Candidate) => Math.max(...candidate.sourceIds.map(id => Date.parse(byId.get(id)?.sentAt ?? '') || 0));
  const priority = { pending: 0, accepted: 1, ignored: 2 };
  const scoped = candidatesInCaptureScope(candidates, sources, scope).sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)) || priority[a.status] - priority[b.status] || latest(b) - latest(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const selected: Candidate[] = []; let budget = 40_000;
  for (const candidate of scoped) {
    const size = JSON.stringify(captureCandidateContext(candidate, sources)).length;
    if (size > budget) continue;
    selected.push(candidate); budget -= size;
    if (selected.length >= 30) break;
  }
  return selected;
}
