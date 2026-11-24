import { hasCommandAttachments, WorkflowReceiptSchema, type CommandRequest } from '../shared/contracts';
import type { LedgerMutationRequest } from '../shared/ledger';
import type { Repository } from '../storage/repository';
import { WorkflowError } from '../ai/deepseek';

/** Only the reply to an actual stored duplicate review may replay its frozen batch. */
export function confirmedLedgerDuplicate(request: CommandRequest, repository: Repository) {
  const question = request.history?.at(-1);
  const reference = question?.text.match(/^重复核对单号 ([a-f0-9]{16})\n/u)?.[1];
  if (!reference || question?.role !== 'assistant' || question.outcome?.phase !== 'clarification' || question.outcome.domain !== 'ledger' ||
      hasCommandAttachments(request) || request.resources?.length ||
      !/^(?:是|是的|对|对的|确认|确认重复|确认重复仍记|确实是另一笔|都是不同笔|都是不同的交易)[。！!]?$/u.test(request.text.trim())) return;
  const candidates = repository.read().operations.filter(operation => operation.id.startsWith('workflow:') && operation.id.endsWith(reference));
  const parsed = WorkflowReceiptSchema.safeParse(candidates.length === 1 ? candidates[0]!.result : undefined);
  const command = parsed.success && parsed.data.kind === 'command' ? parsed.data : undefined;
  const proposal = command?.ledgerProposal, mutation = proposal?.mutationRequest;
  if (command?.result?.conversationState?.phase !== 'clarification' || command.result.conversationState.domain !== 'ledger' ||
      command.result.reply !== question.text || proposal?.intent.kind !== 'mutate' || !proposal.duplicateMatches?.length || !mutation)
    throw new WorkflowError('CONFLICT', '这次确认找不到对应的账本草稿和重复记录，请重新核对。');
  const draftIds = new Set(proposal.duplicateMatches.map(match => match.draftId));
  // The original operation ID provides replay safety across replies/devices. Its
  // expected revision pins both stored duplicates and any intra-batch matches.
  return { intent: proposal.intent, revision: proposal.revision, mutationRequest: { ...mutation,
    changes: mutation.changes.map(change => change.type === 'putEntry'
      ? { ...change, confirmDuplicate: change.expectedVersion === null && draftIds.has(change.entry.id) } : change) } };
}

export function duplicateReviewLines(request: LedgerMutationRequest, matches: readonly { draftId: string; existingId: string }[]) {
  const entries = request.changes.flatMap(change => change.type === 'putEntry' ? [change.entry] : []);
  return matches.map(match => {
    const index = entries.findIndex(entry => entry.id === match.draftId), entry = entries[index]!;
    const original = entries.findIndex(row => row.id === match.existingId);
    const title = entry.title.replace(/[\r\n]+/g, ' ').slice(0, 48);
    const record = original < 0 ? '原账（编号末段 ' + match.existingId.slice(-16) + '）' : '本批第' + (original + 1) + '笔';
    return `第${index + 1}笔「${title}」 ${entry.date ?? entry.month} ¥${(entry.amountCents / 100).toFixed(2)}，与${record}相同。`;
  }).join('\n');
}
