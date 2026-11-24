import type { CommandRequest } from '../shared/contracts';
import { isLedgerClarificationAnswer } from '../shared/command-continuation';
import { ledgerEvidenceHistory } from '../shared/command-attachments';
import { ledgerAccounts, type LedgerAccount, type LedgerEntryDraft, type LedgerMutationRequest, type LedgerSnapshot } from '../shared/ledger';
import { amountsIn } from './ledger-amounts';
import { explicitFundingAccounts } from './ledger-accounts';

function clauses(text: string): string[] {
  return text.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:,\d{3})*(?!\d))/g, '')
    .split(/[,;。！？!?\n、]/u).map(value => value.trim()).filter(Boolean);
}

// A channel for a message, the original payer of a refunded expense and a
// negated account are not evidence of which account funded this cashflow.
function paymentWords(text: string, entry: LedgerEntryDraft): string {
  const receipt = ['aa_return', 'reimbursement', 'refund'].includes(entry.kind);
  const words = receipt ? clauses(text).filter(clause =>
    !/(?:原(?:本|来|先)?|之前|当时|上次).{0,25}(?:支付|付的|扣款|付款)/.test(clause) ||
    /到账|退到|打到|收到/.test(clause)).join('，') : text;
  return words.replace(/(?:微信|支付宝)(?:上(?:看到|说)|聊天|群|通知|消息|客服|发来|转发)/g, '')
    .replace(/(?:而不是|不是|不用|并非|而非)(?:从|用)?(?:微信(?:余额)?|支付宝(?:余额)?|银行卡|亲情卡)/g, '');
}

// Accept a consistent account-before-amount or amount-before-account list.
// The gap between adjacent amounts contains only the local account evidence,
// unlike the full prefix/suffix which also includes the other transactions.
function amountAccounts(clause: string, accounts: readonly LedgerAccount[], amounts: ReturnType<typeof amountsIn>) {
  if (!amounts.length) return [];
  if (amounts.length === 1) return [{ scope: clause, accounts: explicitFundingAccounts(accounts, clause) }];
  const before = amounts.map(amount => ({ scope: amount.between, accounts: explicitFundingAccounts(accounts, amount.between) }));
  if (before.every(item => item.accounts.length === 1)) return before;
  const suffix = amounts.at(-1)!.suffix;
  const after = [...before.slice(1), { scope: suffix, accounts: explicitFundingAccounts(accounts, suffix) }];
  if (after.every(item => item.accounts.length === 1)) return after;
  // A named account at an outer edge belongs to that amount even when the
  // user left other accounts unspecified. An isolated mention between two
  // amounts can refer to either one.
  if (before[0]!.accounts.length && !after.at(-1)!.accounts.length) return before;
  if (after.at(-1)!.accounts.length && !before[0]!.accounts.length) return after;
  return undefined;
}

type RowEvidence = { text: string; ambiguous: string[]; unresolved: boolean };

function evidenceByRow(text: string, rows: LedgerEntryDraft[], accounts: readonly LedgerAccount[]): Map<string, RowEvidence> {
  if (rows.length === 1) return new Map([[rows[0]!.id, { text, ambiguous: [], unresolved: false }]]);
  const chosen = new Map<string, RowEvidence>();
  function attach(entries: LedgerEntryDraft[], segment: string, ambiguous = false, unresolved = false): void {
    for (const entry of entries) {
      const evidence = chosen.get(entry.id) ?? { text: '', ambiguous: [], unresolved: false };
      evidence.text = [evidence.text, segment].filter(Boolean).join('，');
      if (ambiguous) evidence.ambiguous.push(segment);
      evidence.unresolved ||= unresolved;
      chosen.set(entry.id, evidence);
    }
  }
  let preceding: LedgerEntryDraft[] = [];
  for (const segment of clauses(text)) {
    const amounts = amountsIn(segment);
    const titled = rows.filter(entry => segment.includes(entry.title));
    const priced = rows.filter(entry => amounts.some(amount => amount.cents === entry.amountCents));
    if (titled.length || amounts.length) preceding = titled.length ? titled : priced;
    const shared = /(?:都(?:是|用|走|从)?|均(?:为|从|用)?)(?:微信|支付宝|银行卡|亲情卡|饭卡)/.test(segment);
    if (!shared && amounts.length > 1 && priced.length > 1) {
      const bindings = amountAccounts(segment, accounts, amounts);
      if (bindings && bindings.every(binding => binding.accounts.length <= 1)) {
        for (const [index, amount] of amounts.entries()) {
          if (!bindings[index]!.accounts.length) continue;
          const byPrice = rows.filter(entry => entry.amountCents === amount.cents);
          const byTitle = byPrice.filter(entry => amount.between.includes(entry.title));
          const targets = byTitle.length ? byTitle : byPrice;
          attach(targets, bindings[index]!.scope, targets.length > 1);
        }
      } else if (explicitFundingAccounts(accounts, segment).length) {
        attach(priced, segment, false, true);
      }
      // Principal and interest may share a sentence without an account for
      // either amount. A separate “均微信” clause can still identify both.
      continue;
    }
    attach(shared ? rows : preceding, segment, !shared && preceding.length > 1);
  }
  return chosen;
}

function differentFlow(entry: LedgerEntryDraft, accounts: readonly LedgerAccount[], words: string, named: LedgerAccount[]): boolean {
  const flows = entry.cashflows.filter(flow => flow.deltaCents !== 0);
  if (entry.kind === 'transfer') {
    const sides = words.match(/(?:从|由)(.+?)(?:转入|转到|转至|到)(.+)/u);
    if (sides) {
      const from = explicitFundingAccounts(accounts, sides[1]!), to = explicitFundingAccounts(accounts, sides[2]!);
      if (from.some(account => !flows.some(flow => flow.accountId === account.id && flow.deltaCents < 0)) ||
          to.some(account => !flows.some(flow => flow.accountId === account.id && flow.deltaCents > 0))) return true;
    }
    return named.some(account => !flows.some(flow => flow.accountId === account.id));
  }
  // Amount-qualified split payments take precedence over channel language
  // elsewhere in the sentence, e.g. 微信零钱 20，银行卡实际扣款 80.
  const allocations = new Map<string, number>();
  for (const clause of clauses(words)) {
    const amounts = amountsIn(clause);
    const bindings = amountAccounts(clause, accounts, amounts);
    if (!bindings || !bindings.every(binding => binding.accounts.length === 1)) continue;
    for (const [index, amount] of amounts.entries()) {
      const id = bindings[index]!.accounts[0]!.id;
      if (amount.cents > 0) allocations.set(id, (allocations.get(id) ?? 0) + amount.cents);
    }
  }
  if (allocations.size > 1 && [...allocations.values()].reduce((sum, cents) => sum + cents, 0) === entry.amountCents) {
    for (const [id, cents] of allocations) {
      if (flows.reduce((sum, flow) => sum + (flow.accountId === id ? Math.abs(flow.deltaCents) : 0), 0) !== cents) return true;
    }
    return false;
  }
  if (named.length === 1) return !flows.length || flows.some(flow => flow.accountId !== named[0]!.id);
  if (/拆分|混合|组合支付|分别|各(?:付|出)/.test(words)) return named.some(account => !flows.some(flow => flow.accountId === account.id));
  // Several mentions without an identifiable funding source can describe e.g.
  // the original payment and the reimbursement. Do not guess between them.
  return false;
}

export function ledgerCashflowQuestion(request: CommandRequest, changes: LedgerMutationRequest['changes'], snapshot: LedgerSnapshot): string | undefined {
  const accounts = new Map(ledgerAccounts(snapshot).map(account => [account.id, account]));
  for (const change of changes) if (change.type === 'putAccount') accounts.set(change.account.id, change.account);
  const directory = [...accounts.values()];
  const accountCorrection = !changes.some(change => change.type === 'putEntry' && change.expectedVersion === null) &&
    (isLedgerClarificationAnswer(request) || /(?:收付|收款|付款|支付|到账)账户|(?:账户|付款方式).{0,8}(?:改|更正)/.test(request.text));
  const rows = changes.flatMap(change => {
    if (change.type !== 'putEntry' || change.entry.kind === 'adjustment') return [];
    const old = snapshot.entries.find(entry => entry.id === change.entry.id);
    return old && !accountCorrection && JSON.stringify(old.cashflows) === JSON.stringify(change.entry.cashflows) ? [] : [change.entry];
  });
  if (!rows.length) return;
  const turns = [request.text, ...ledgerEvidenceHistory(request).filter(turn => turn.role === 'user').map(turn => turn.text).reverse()]
    .map(text => evidenceByRow(text, rows, directory));
  for (const row of rows) {
    // An explicit answer to a pending account question supersedes its earlier
    // evidence. Assistant turns and unrelated completed requests never qualify.
    for (const turn of turns) {
      const evidence = turn.get(row.id);
      if (!evidence) continue;
      if (evidence.unresolved) return '尚不能确定原话中的账户对应哪笔金额。请分别说明项目、金额及实际收付账户。';
      for (const segment of evidence.ambiguous) {
        const payer = explicitFundingAccounts(directory, paymentWords(segment, row));
        if (payer.length === 1 && differentFlow(row, directory, segment, payer))
          return '有多笔同金额的账目，无法将每笔原话中的账户与草稿项目逐一对应。请把项目和实际收付账户分别列明。';
      }
      const words = paymentWords(evidence.text, row);
      if (!words) continue;
      const named = explicitFundingAccounts(directory, words);
      if (!named.length) continue;
      if (differentFlow(row, directory, words, named)) {
        const proposed = [...new Set(row.cashflows.map(flow => accounts.get(flow.accountId ?? '')?.name ?? '待确认'))];
        return '「' + row.title.slice(0, 100) + '」原话提到' + named.slice(0, 4).map(account => account.name).join('、') +
          '，草稿的收付账户或分项不符（' + proposed.slice(0, 4).join('、') + '）。请确认实际账户及各自金额。';
      }
      break;
    }
  }
}
