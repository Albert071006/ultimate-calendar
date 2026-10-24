import { addCalendarDays, type CommandRequest, type Mutation, type Snapshot } from '../shared/contracts';
import { buildCalendar } from '../domain/calendar';
import { WorkflowError } from './deepseek';
import { candidateDisposition } from '../domain/candidate-eligibility';
import { dayDistance } from '../domain/time';
import { locationProfile } from './prompts';
import { explicitReminderStart } from './timed-commands';

/** Bounded relevant records; raw imported sources/images never enter command context. */
export function buildCommandContext(snapshot: Snapshot, request: CommandRequest, now: string) {
  const fromDate = request.fromDate ?? now.slice(0, 10); const toDate = request.toDate ?? addCalendarDays(fromDate, 14);
  if (fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) > 366 * 86400_000) throw new WorkflowError('VALIDATION', '查询范围需要在一年以内');
  const selected = new Set((request.selected ?? []).map(x => x.id));
  const { termStart, termWeeks } = snapshot.settings;
  const termEnd = termStart ? addCalendarDays(termStart, termWeeks * 7 - 1) : null;
  const week = termStart ? Math.floor(dayDistance(termStart, now.slice(0, 10)) / 7) + 1 : null;
  const academicTerm = { termStart, termWeeks, termEnd, currentWeek: week !== null && week >= 1 && week <= termWeeks ? week : null };
  const normalizeText = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const text = request.text.toLowerCase();
  // Recent user turns help retrieve a target when the current turn only supplies a missing
  // field or answers a question. They broaden context, never authorize a mutation.
  const recentTexts = (request.history ?? []).filter(entry => entry.role === 'user').slice(-4).reverse().map(entry => entry.text.toLowerCase());
  const titleQueries = [text, ...recentTexts].map(normalizeText);
  const titleScores = new Map<string, { current: number; recent: number }>();
  const titleScore = (title?: string) => {
    if (!title) return { current: 0, recent: 0 };
    const cached = titleScores.get(title); if (cached !== undefined) return cached;
    const normalized = title.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const score = (query: string) => {
      for (let length = Math.min(normalized.length, query.length, 64); length >= 2; length--)
        for (let start = 0; start <= normalized.length - length; start++) if (query.includes(normalized.slice(start, start + length))) return length;
      return 0;
    };
    const value = { current: score(titleQueries[0]!), recent: Math.max(0, ...titleQueries.slice(1).map((query, index) => score(query) / (index + 1))) };
    titleScores.set(title, value); return value;
  };
  const titleMentioned = (title: string) => { const score = titleScore(title); return score.current >= 2 || score.recent > 0; };
  const dateMentioned = (instant: string, query: string) => {
    const date = instant.slice(0, 10); const [, month, day] = date.split('-').map(Number);
    return query.includes(date) || query.includes(`${month}月${day}日`) || query.includes(`${month}/${day}`);
  };
  const mentionsBlockDate = (block: Snapshot['blocks'][number], query: string) => dateMentioned(block.start, query) || !!block.recurrence && dateMentioned(block.recurrence.occurrenceStart, query);
  const datedBlocks = new Set(snapshot.blocks.filter(block => mentionsBlockDate(block, text)).map(block => block.id));
  const recentDatedBlocks = new Set(snapshot.blocks.filter(block => recentTexts.some(query => mentionsBlockDate(block, query))).map(block => block.id));
  const rank = <T extends { id: string; title?: string }>(list: T[], limit = 60) => [...list].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || Number(datedBlocks.has(b.id)) - Number(datedBlocks.has(a.id)) || titleScore(b.title).current - titleScore(a.title).current || Number(recentDatedBlocks.has(b.id)) - Number(recentDatedBlocks.has(a.id)) || titleScore(b.title).recent - titleScore(a.title).recent).slice(0, limit);
  const trim = <T extends { id: string }>(list: T[], limit = 60) => rank(list, limit).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !['imageDataUrl', 'sourceQuote', 'temporalEvidence'].includes(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 1200) : v])));
  const relevantTasks = new Set(snapshot.tasks.filter(task => selected.has(task.id) || titleMentioned(task.title)).map(task => task.id));
  const mentionedBlocks = new Set(snapshot.blocks.filter(block => selected.has(block.id) || datedBlocks.has(block.id) || recentDatedBlocks.has(block.id) || titleMentioned(block.title) || !!block.taskId && relevantTasks.has(block.taskId)).map(block => block.id));
  const relevantSeries = new Set(snapshot.blocks.filter(block => block.recurrence && mentionedBlocks.has(block.id)).map(block => block.recurrence!.seriesId));
  const blocks = snapshot.blocks.filter(block =>
    mentionedBlocks.has(block.id) || block.recurrence && relevantSeries.has(block.recurrence.seriesId) ||
    block.start.slice(0, 10) <= toDate && (block.end ?? block.start).slice(0, 10) >= fromDate);
  const seriesIds = [...new Set(rank(blocks, 120).flatMap(block => block.recurrence ? [block.recurrence.seriesId] : []))].slice(0, 20);
  const recurringSeries = seriesIds.map(seriesId => {
    const occurrences = snapshot.blocks.filter(block => block.recurrence?.seriesId === seriesId).sort((a, b) => a.recurrence!.occurrenceStart.localeCompare(b.recurrence!.occurrenceStart));
    return { seriesId, title: occurrences[0]!.title.slice(0, 500), taskId: occurrences[0]!.taskId, occurrenceCount: occurrences.length, firstOccurrenceStart: occurrences[0]!.recurrence!.occurrenceStart, lastOccurrenceStart: occurrences.at(-1)!.recurrence!.occurrenceStart };
  });
  const context = { now, timezone: snapshot.settings.timezone, explicitReminderStart: explicitReminderStart(request.text, now), academicTerm, userProfile: locationProfile(snapshot.settings), fromDate, toDate, selected: request.selected ?? [], tasks: trim(snapshot.tasks), goals: trim(snapshot.goals), candidates: trim(snapshot.candidates.map(candidate => ({ ...candidate, classification: candidateDisposition(candidate, now) }))), blocks: trim(blocks, 120), recurringSeries, courses: trim(snapshot.courses), courseExceptions: trim(snapshot.courseExceptions), preferences: snapshot.preferences.filter(p => p.enabled).slice(0, 20).map(p => ({ id: p.id, version: p.version, text: p.text.slice(0, 500), enabled: p.enabled })), journal: snapshot.journal.slice(0, 10).map(j => ({ id: j.id, message: j.message, undoable: j.undoable, undoneAt: j.undoneAt })), calendar: buildCalendar(snapshot, fromDate, toDate, true).slice(0, 150) };
  // Bound serialized context without silently truncating JSON; progressively shrink record lists.
  while (JSON.stringify(context).length > 60_000) {
    const lists = [context.tasks, context.goals, context.candidates, context.blocks, context.recurringSeries, context.courses, context.courseExceptions, context.calendar];
    const largest = lists.sort((a, b) => b.length - a.length)[0]!; if (!largest.length) break; largest.pop();
  }
  return context;
}
export function validateCommandReferences(mutations: Mutation[], context: ReturnType<typeof buildCommandContext>) {
  const lists: Record<string, { id?: unknown }[]> = { task: context.tasks, goal: context.goals, candidate: context.candidates, block: context.blocks, course: context.courses, courseException: context.courseExceptions, preference: context.preferences };
  const known = (kind: string | undefined, id: string) => !!kind && lists[kind]?.some(r => r.id === id);
  const semanticEntities: Record<string, string> = {
    finishTask: 'task', removeTask: 'task', scheduleTaskEvent: 'task', scheduleRecurringTask: 'task', finishBlock: 'block', updateRecurringEvent: 'block', cancelRecurringEvent: 'block',
    acceptCandidate: 'candidate', ignoreCandidate: 'candidate', restoreCandidate: 'candidate', snoozeCandidate: 'candidate',
  };
  for (const mutation of mutations) {
    if ('id' in mutation) {
      const kind = 'entity' in mutation ? mutation.entity : semanticEntities[mutation.type];
      if (!known(kind, mutation.id)) throw new WorkflowError('AI_RESPONSE', 'AI 选择了上下文之外的记录，请明确选择事项');
    }
    if ('values' in mutation) for (const [key, kind] of [['taskId', 'task'], ['goalId', 'goal'], ['candidateId', 'candidate'], ['courseId', 'course']] as const) {
      const id = (mutation.values as Record<string, unknown>)[key]; if (typeof id === 'string' && !known(kind, id)) throw new WorkflowError('AI_RESPONSE', 'AI 创建了未知关联，请重新选择事项');
    }
  }
}
