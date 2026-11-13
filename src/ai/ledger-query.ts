import { hasCommandAttachments, type CommandRequest } from '../shared/contracts';
import { LedgerQueryChoicesSchema, LedgerQuerySchema, type LedgerQuery } from '../shared/ledger';
import type { LedgerIntent } from '../shared/ledger-command';

export function ledgerMonthDescription(month: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}

/** AI topic searches refer to the individual record, not a shared batch transcript. */
export function normalizeLedgerQueryScope(query: LedgerQuery): LedgerQuery {
  const parsed = LedgerQuerySchema.parse(query);
  return parsed.search && !parsed.searchFields
    ? { ...parsed, searchFields: ['title', 'note', 'counterparty'] }
    : parsed;
}

/** Summary.month remains legacy metadata, not a month filter for exact IDs. */
export function ledgerQueryRangeDescription(query: LedgerQuery, defaultMonth: string): string {
  if (query.from || query.to) return `${query.from ?? '最早记录'} 至 ${query.to ?? '今天'}`;
  if (query.month) return ledgerMonthDescription(query.month);
  return query.entryIds !== undefined ? '指定账目（不限月份）' : ledgerMonthDescription(defaultMonth);
}

/** Resolve only an unambiguous choice of the immediately pending read-only question. */
export function resolveLedgerQueryChoice(request: Pick<CommandRequest, 'text' | 'history' | 'image' | 'images' | 'documents' | 'resources'>): Extract<LedgerIntent, { kind: 'query' }> | undefined {
  if (hasCommandAttachments(request) || request.resources?.length) return;
  const previous = request.history?.at(-1);
  if (previous?.role !== 'assistant' || previous.outcome?.domain !== 'ledger' || previous.outcome.phase !== 'clarification') return;
  const choices = LedgerQueryChoicesSchema.safeParse(previous.outcome.ledgerQueryChoices);
  if (!choices.success) return;
  const answer = request.text.trim().replace(/[。.!！]$/, '').trim();
  const ordinal = answer.match(/^(?:选(?:择)?\s*)?(?:第\s*)?([1-5一二两三四五])\s*(?:个|项|种|条)?$/);
  if (!ordinal) return;
  const numeric = Number(ordinal[1]);
  const index = (Number.isNaN(numeric) ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 } as Record<string, number>)[ordinal[1]!]! : numeric) - 1;
  const choice = choices.data[index];
  if (!choice) return;
  return { kind: 'query', query: normalizeLedgerQueryScope(choice.query), detail: choice.detail };
}

/** Make the executed keyword/record scope visible without exposing internal IDs. */
export function ledgerQueryScopeDescription(query: LedgerQuery): string | undefined {
  const fields = { title: '标题', note: '备注', counterparty: '对方', originalText: '来源原文' };
  const parts: string[] = [];
  if (query.search) parts.push(`关键词「${query.search}」（${query.searchFields?.map(field => fields[field]).join('、') ?? '标题、备注、对方及来源原文'}）`);
  if (query.entryIds) parts.push(`指定 ${new Set(query.entryIds).size} 笔账目`);
  if (query.category) parts.push(`分类「${query.category}」`);
  return parts.length ? `筛选范围：${parts.join('；')}。` : undefined;
}
