import { hasCommandAttachments, type CommandRequest } from '../shared/contracts';
import { ledgerLoans } from '../shared/ledger-loans';
import { pendingClarificationHistory } from '../shared/command-continuation';
import { formatLedgerMoney, ledgerAccounts, type LedgerMutationRequest, type LedgerSnapshot } from '../shared/ledger';
import { ledgerSavedEntryLine } from './ledger';

type Changes = LedgerMutationRequest['changes'];
type Amount = { cents: number; clause: string; prefix: string; suffix: string; between: string };
type Proposed = { cents: number; title: string; labels: string[] };
const money = (cents: number) => '¥' + formatLedgerMoney(cents);
const digits = '零〇一二两三四五六七八九';
const chineseNumber = '[' + digits + '十百千万亿]+';
const foreignCurrency = /(?:美元|美金|美分|港[元币]|欧元|英镑|日[元圆]|韩元|新台币|澳元|加元|USD|HKD|EUR|GBP|JPY|KRW|[$€£])/i;
const actual = /(?:实付|实收|实际(?:付款|支付|收款|到账)|折[合算](?:人民币)?|折后(?:价)?|到手(?:价)?|合计|一共|总共|总计|总额|总价|共计|共付|共收)\s*[:是为共]?\s*$/;
const secondary = /(?:原价|标价|优惠(?:券)?|[减省]了?|折扣|每人|人均|单价|自己(?:出|承担)|我(?:出|承担)|个人(?:承担|份额)|冲减[^,;]{0,10}|多[的出]|其中(?:的)?)\s*[:是为共]?\s*$/;

function chineseInteger(value: string): number {
  const digit = (char: string) => '零一二三四五六七八九'.indexOf(char.replace('〇', '零').replace('两', '二'));
  if (![...value].some(char => '十百千万亿'.includes(char))) return Number([...value].map(digit).join(''));
  let total = 0, section = 0, last = 0;
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  for (const char of value) {
    const unit = units[char];
    if (!unit) last = digit(char);
    else if (unit < 10000) { section += (last || 1) * unit; last = 0; }
    else { total += (section + last || 1) * unit; section = 0; last = 0; }
  }
  // “一千二” means 1200; “一千零二” has an explicit gap and means 1002.
  const shorthand = value.match(/([百千万亿])([一二两三四五六七八九])$/);
  if (shorthand) last *= units[shorthand[1]!]! / 10;
  return total + section + last;
}

const scales: Record<string, number> = { 亿: 1e10, 万: 1e6, 千: 1e5, 百: 1e4, 角: 10, 毛: 10, 分: 1 };
const foreignBefore = new RegExp('(?:' + foreignCurrency.source + ')\\s*$', 'i');
const foreignAfter = new RegExp('^\\s*(?:' + foreignCurrency.source + ')', 'i');
const numberPattern = '(?:[+-]?\\d+(?:\\.\\d+)?|' + chineseNumber + '(?:点[' + digits + ']+)?)';
const amountPattern = new RegExp('(?:人民币\\s*|¥\\s*)?(' + numberPattern + ')\\s*([亿万千百](?:元|块钱?)?|元|圆|块钱?|角|毛钱?|分钱?)?', 'g');

function scaledCents(raw: string, scale: number): number {
  const arabic = /^[+-]?\d/.test(raw);
  const [whole, fraction = ''] = raw.split(arabic ? '.' : '点');
  const decimal = arabic ? fraction : [...fraction].map(char => chineseInteger(char)).join('');
  const integer = arabic ? Math.abs(Number(whole)) : chineseInteger(whole!);
  return (raw.startsWith('-') ? -1 : 1) * (integer * scale + Number(decimal) * scale / 10 ** decimal.length);
}

// Mask dates, times, identifiers and counters before recognizing shorthand
// such as “午饭41.9支付宝”. Preserve decimal points in monetary amounts.
function amountsIn(text: string): Amount[] {
  const clean = text.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:,\d{3})*(?!\d))/g, '')
    .replace(/(?:尾号|尾数|卡号(?:后[四4]位)?|末四位|末4位|订单号|编号|单号|流水号)\s*[:#]?\s*[A-Za-z0-9-]+/gi, ' ')
    .replace(/(?:19|20)\d{2}\.\d{1,2}\.\d{1,2}|\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}[点时]\d{1,2}分?/g, ' ')
    .replace(/(?:第\s*)?\d+(?:\.\d+)?\s*(?:月份?|分钟|小时|公斤|GB|TB|[年月日号点时岁折%期页次人件份张笔个瓶杯天斤])/gi, ' ')
    .replace(/(?:汇率|汇价)\s*[:约是为]?\s*\d+(?:\.\d+)?/g, ' ');
  const amounts: Amount[] = [];
  let previousEnd = 0;
  for (const chunk of clean.matchAll(/[^,;；。！!？?\n、]+/g)) {
    const clause = chunk[0];
    if (/^\s*(?:别|不要|不用|不必)(?:再|另外|另行|单独)?(?:补|新增|新建|加|记)/.test(clause)) continue;
    const matches = [...clause.matchAll(amountPattern)];
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index]!, raw = match[1]!, unit = match[2] ?? '';
      const prefix = clause.slice(0, match.index).trimEnd();
      let end = match.index + match[0].length, suffix = clause.slice(end).trimStart();
      if (foreignBefore.test(prefix) || foreignAfter.test(suffix)) continue;
      if (!unit && (/^(?:月份?|年月|[年月日号点时份笔个人项次条张折%])/.test(suffix) || /(?:第|尾号|序号|编号|#)\s*$/.test(prefix))) continue;
      const numeric = /^[+-]?\d/.test(raw);
      if (!numeric && !unit && !(raw.length > 1 && /[十百千万亿]/.test(raw) && /到|付|收|转|花|报销/.test(prefix + suffix))) continue;
      if (!unit && numeric && /^\d{11,}$/.test(raw)) continue;
      let scale = scales[unit[0] ?? ''] ?? 100;
      let cents = scaledCents(raw, scale);
      // “三块五”, “一元五角二分”, “2万3千” are each one amount.
      while (unit && index + 1 < matches.length) {
        const next = matches[index + 1]!, nextRaw = next[1]!, nextUnit = next[2] ?? '';
        if (clause.slice(end, next.index).trim()) break;
        const nextScale = nextUnit ? scales[nextUnit[0]!] ?? 100 : scale / 10;
        if (nextScale >= scale || (!nextUnit && !/^[0-9零〇一二两三四五六七八九]$/.test(nextRaw))) break;
        cents += scaledCents(nextRaw, nextScale) * (raw.startsWith('-') ? -1 : 1);
        scale = nextScale;
        end = next.index + next[0].length;
        suffix = clause.slice(end).trimStart();
        index++;
      }
      amounts.push({ cents, prefix, suffix, clause, between: clean.slice(previousEnd, chunk.index + match.index).trim() });
      previousEnd = chunk.index + end;
    }
  }
  return amounts;
}

function amountEditIn(amounts: Amount[]): { replacement: Amount; prior?: Amount; contrast?: boolean } | undefined {
  const [first, second] = amounts;
  if (amounts.length === 2 && first && second) {
    const negated = /(?:不是|并非|而非)\s*$/;
    if (negated.test(first.prefix) && /^[\s,、;。]*(?:而|实际|其实|应该|正确的?)?(?:是|为)\s*$/.test(second.between))
      return { prior: first, replacement: second, contrast: true };
    if (!negated.test(first.prefix) && /^[\s,、;。]*(?:而不是|并不是|不是|而非|并非)\s*$/.test(second.between))
      return { prior: second, replacement: first, contrast: true };
  }
  const replacement = amounts.find(amount => /(?:改(?:成|为|到)|更正(?:成|为)|调整(?:成|为))\s*$/.test(amount.prefix));
  if (!replacement) return;
  const prior = amounts.find(amount => amount.clause === replacement.clause &&
    /^(?:元|块)?\s*(?:改(?:成|为|到)|更正(?:成|为)|调整(?:成|为))/.test(amount.suffix));
  return { replacement, prior };
}

/** The two amounts come from the user. The last completed receipt only identifies
 * the record, including when another record happens to have the same amount. */
function contrastTarget(request: CommandRequest, pendingTurns: number, text: string, priorCents: number, snapshot: LedgerSnapshot): string | undefined {
  const candidates = snapshot.entries.filter(entry => !entry.voided && entry.amountCents === priorCents);
  const named = candidates.filter(entry => text.includes(entry.title) || text.includes(entry.id));
  if (named.length === 1) return named[0]!.id;
  const eligible = named.length ? named : candidates;
  const history = request.history ?? [];
  const receipt = history[history.length - pendingTurns - 1];
  if (receipt?.role === 'assistant' && receipt.outcome?.domain === 'ledger' && receipt.outcome.phase === 'saved') {
    const lines = new Set(receipt.text.split(/\r?\n/));
    const receipted = eligible.filter(entry => lines.has(ledgerSavedEntryLine(entry, snapshot)));
    if (receipted.length === 1) return receipted[0]!.id;
  }
  return eligible.find(entry => entry.id === request.ledgerView?.selectedEntryId)?.id;
}

function accountLabels(ids: (string | null)[], changes: Changes, snapshot: LedgerSnapshot): string[] {
  const accounts = [...ledgerAccounts(snapshot), ...changes.flatMap(change => change.type === 'putAccount' ? [change.account] : [])];
  return accounts.filter(account => ids.includes(account.id)).flatMap(account => [account.name, ...account.aliases]);
}

function proposedAmounts(changes: Changes, snapshot: LedgerSnapshot, includeUnchanged: boolean): Proposed[] {
  const rows: Proposed[] = [];
  for (const change of changes) {
    if (change.type === 'putEntry') {
      const entry = change.entry, old = snapshot.entries.find(item => item.id === entry.id);
      // Normalization can update an old expense's personal share alongside an AA
      // receipt. Its unchanged gross amount is not another payment in the user's text.
      if ((!includeUnchanged && old?.amountCents === entry.amountCents) || entry.kind === 'adjustment') continue;
      rows.push({ cents: entry.amountCents, title: entry.title, labels: accountLabels(entry.cashflows.map(flow => flow.accountId), changes, snapshot) });
    } else if (change.type === 'setBalance') {
      rows.push({ cents: change.snapshot.balanceCents, title: '余额', labels: accountLabels([change.snapshot.accountId], changes, snapshot) });
    } else if (change.type === 'updateRules') {
      if (change.rules.monthlyAllowance.amountCents !== snapshot.rules.monthlyAllowance.amountCents)
        rows.push({ cents: change.rules.monthlyAllowance.amountCents, title: '生活费', labels: [] });
      if (change.rules.familyMonthlyLimitCents !== snapshot.rules.familyMonthlyLimitCents)
        rows.push({ cents: change.rules.familyMonthlyLimitCents, title: '额度', labels: [] });
      if (change.rules.familyActualRemainingCents !== null && change.rules.familyActualRemainingCents !== snapshot.rules.familyActualRemainingCents)
        rows.push({ cents: change.rules.familyActualRemainingCents, title: '剩余', labels: [] });
    }
  }
  return rows;
}

const display = (values: number[]) => values.slice(0, 12).map(money).join('、') + (values.length > 12 ? '等' : '');
const mismatch = (source: Amount[], rows: Proposed[]) => '你说的金额是' + display(source.map(a => a.cents)) + '，拟保存的金额是' +
  (rows.length ? display(rows.map(row => row.cents)) : '（没有对应账目）') + '。请确认每笔实际金额和对应项目。';

// Prefer an explicit title or account that identifies the particular clause,
// then match distinct occurrences (including equal amounts in different rows).
function matchAmounts(amounts: Amount[], rows: Proposed[]): boolean {
  if (amounts.length !== rows.length) return false;
  const options = amounts.map(amount => {
    const scores = rows.map(row => (amount.clause.includes(row.title) ? 2 : 0) + Number(row.labels.some(label => amount.clause.includes(label))));
    const max = Math.max(...scores);
    return rows.map((row, index) => scores[index] === max && row.cents === amount.cents ? index : -1).filter(index => index >= 0);
  });
  const assigned = new Map<number, number>();
  function assign(i: number, seen: Set<number>): boolean {
    for (const row of options[i]!) {
      if (seen.has(row)) continue;
      seen.add(row);
      const prior = assigned.get(row);
      if (prior === undefined || assign(prior, seen)) { assigned.set(row, i); return true; }
    }
    return false;
  }
  return options.every((_, i) => assign(i, new Set()));
}

// An explicit full settlement may specify the amount by reference to an existing
// entry. Only accept an identifiable original and an independently known total.
function fullSettlementCents(text: string, changes: Changes, snapshot: LedgerSnapshot, selected?: string): number | undefined {
  if (!/全额|全部|全款|还清|结清/.test(text)) return;
  const writes = changes.filter(change => change.type === 'putEntry');
  if (writes.length !== 1 || writes[0]!.expectedVersion !== null) return;
  const entry = writes[0]!.entry;
  const ids = new Set([...entry.relatedEntryIds, ...entry.adjustments.flatMap(adjustment => adjustment.targetEntryIds)]);
  if (ids.size !== 1) return;
  const original = snapshot.entries.find(item => ids.has(item.id) && !item.voided);
  if (!original || (selected !== original.id &&
      (!text.includes(original.title) || snapshot.entries.filter(item => !item.voided && item.title === original.title).length !== 1))) return;
  if (entry.kind === 'loan_repay' || entry.kind === 'loan_collect') {
    return ledgerLoans(snapshot.entries).items.find(item => item.entryId === original.id)?.outstandingCents;
  }
  if (!['refund', 'reimbursement'].includes(entry.kind) || original.kind !== 'expense' || original.personalCents !== original.amountCents) return;
  if (snapshot.entries.some(item => !item.voided && (item.relatedEntryIds.includes(original.id) ||
      item.adjustments.some(adjustment => adjustment.targetEntryIds.includes(original.id))))) return;
  return original.amountCents;
}

/** Ground actual receipt/payment amounts in the user's own words, before the
 * shared desktop/server mutation boundary. Never derive the user's evidence
 * from model notes, assistant replies or already-completed history. */
export function ledgerAmountQuestion(request: CommandRequest, changes: Changes, snapshot: LedgerSnapshot): string | undefined {
  const history = pendingClarificationHistory(request);
  const turns = [...history.filter(turn => turn.role === 'user').map(turn => turn.text), request.text];
  const evidence = turns.map(text => {
    const amounts = amountsIn(text);
    return { text, amounts, edit: amountEditIn(amounts) };
  }).filter(turn => turn.amounts.length);
  const source = evidence.at(-1);
  if (!source) {
    const rows = proposedAmounts(changes, snapshot, false);
    if (!rows.length) return;
    if (turns.some(turn => foreignCurrency.test(turn))) return '账本按人民币记账。请补充这笔交易实际折合的人民币金额。';
    // The existing attachment flow reads the requested receipts directly.
    if ([request, ...history.filter(turn => turn.role === 'user')].some(hasCommandAttachments)) return;
    const settled = fullSettlementCents(turns.join('\n'), changes, snapshot, request.ledgerView?.selectedEntryId);
    if (rows.length === 1 && settled !== undefined) {
      if (rows[0]!.cents !== settled) return '原账目可核对的全额为' + money(settled) + '，拟保存' + money(rows[0]!.cents) + '。请确认金额。';
      return;
    }
    return '你还没有说明实际金额，拟保存的金额是' + display(rows.map(row => row.cents)) + '。请补充每笔实际金额。';
  }

  const editSource = evidence.findLast(turn => turn.edit);
  const statedReplacement = editSource?.edit?.replacement;
  const priorAmount = editSource?.edit?.prior;
  const replacement = source === editSource ? statedReplacement : source.amounts.length === 1 && statedReplacement ? source.amounts[0] : undefined;
  if (statedReplacement && priorAmount) {
    const rows = proposedAmounts(changes, snapshot, true);
    const edits = changes.filter(change => change.type === 'putEntry');
    if (editSource?.edit?.contrast) {
      const target = contrastTarget(request, history.length, turns.join('\n'), priorAmount.cents, snapshot);
      if (!target) return '请指出原来金额为' + money(priorAmount.cents) + '的那笔账目（项目或在账单中选中），以便原位更正。';
      if (changes.length !== 1 || edits[0]?.entry.id !== target) return '需要在原来金额为' + money(priorAmount.cents) + '的同一笔账目上更正为' + money(replacement?.cents ?? statedReplacement.cents) + '。请核对原项目。';
    }
    if (rows.length !== 1 || edits.length !== 1 || edits[0]!.expectedVersion === null ||
        snapshot.entries.find(entry => entry.id === edits[0]!.entry.id)?.amountCents !== priorAmount.cents ||
        rows[0]!.cents !== replacement?.cents || changes.some(change => change.type === 'voidEntry')) {
      return mismatch(replacement ? [replacement] : source.amounts, rows) + ' 请核对要原位更正的那笔记录。';
    }
    return;
  }

  const amountEdit = !!replacement || /(?:更正|改一下|改下|修改)(?:这笔|原笔|那笔)?(?:的)?(?:实际)?金额/.test(source.text);
  const rows = proposedAmounts(changes, snapshot, amountEdit);
  if (!rows.length && !amountEdit) return;
  if (source.amounts.some(amount => !Number.isSafeInteger(amount.cents)))
    return '请用人民币明确每笔金额，最多保留到分。';
  if (replacement && /(?:那|这|上|原)(?:一)?笔|原记录|原账目/.test(editSource!.text) &&
      changes.some(change => change.type === 'putEntry' && change.expectedVersion === null))
    return mismatch([replacement], rows) + ' 请核对要原位更正的那笔记录。';
  if (foreignCurrency.test(source.text) && !/(?:人民币|[¥￥]|RMB|CNY|折合|折算)/i.test(source.text))
    return '这条指令含外币金额。请确认实际记账的人民币金额。';
  const amounts = replacement ? [replacement] : source.amounts.filter(amount => !secondary.test(amount.prefix));
  const totals = amounts.filter(amount => actual.test(amount.prefix));
  const parts = amounts.filter(amount => !totals.includes(amount));
  if (totals.length === 1 && parts.length === rows.length && parts.reduce((sum, a) => sum + a.cents, 0) === totals[0]!.cents &&
      matchAmounts(parts, rows)) return;
  if (rows.length === 1) {
    const newEntries = changes.flatMap(change => change.type === 'putEntry' && change.expectedVersion === null ? [change.entry] : []);
    const entry = newEntries.length === 1 ? newEntries[0] : undefined;
    if (entry && source.amounts.length > 1 && (entry.adjustments.length > 1 || entry.cashflows.length > 1)) {
      const partRows = entry.adjustments.length > 1 ? entry.adjustments.map(adjustment => {
        const originals = snapshot.entries.filter(item => adjustment.targetEntryIds.includes(item.id));
        return { cents: adjustment.amountCents, title: originals[0]?.title ?? '冲减项目',
          labels: originals.flatMap(item => [item.title, item.category]) };
      }) : entry.cashflows.map(flow => {
        const labels = accountLabels([flow.accountId], changes, snapshot);
        return { cents: Math.abs(flow.deltaCents), title: labels[0] ?? '待确认账户', labels };
      });
      const explicitTotal = totals.length === 1 && totals[0]!.cents === entry.amountCents ? totals[0] : undefined;
      const allocated = source.amounts.filter(amount => amount !== explicitTotal);
      if (allocated.length === partRows.length && allocated.reduce((sum, amount) => sum + amount.cents, 0) === entry.amountCents) {
        if (!matchAmounts(allocated, partRows)) return '你说的分项金额是' + display(allocated.map(amount => amount.cents)) + '，拟保存' +
          partRows.map(part => part.title + money(part.cents)).join('、') + '。请确认各项对应的金额。';
        const earlier = evidence.at(-2)?.amounts.filter(amount => !secondary.test(amount.prefix));
        return earlier?.length === 1 && earlier[0]!.cents !== entry.amountCents ? mismatch(earlier, rows) : undefined;
      }
    }
  }
  if (!amounts.length) {
    const price = source.amounts.filter(amount => /(?:原价|标价)\s*[:是为]?\s*$/.test(amount.prefix));
    const discount = source.amounts.filter(amount => /(?:优惠(?:券)?|减|省)(?:了)?\s*[:是为]?\s*$/.test(amount.prefix));
    if (rows.length === 1 && source.amounts.length === 2 && price.length === 1 && discount.length === 1) {
      const paid = price[0]!.cents - discount[0]!.cents;
      if (paid >= 0 && paid === rows[0]!.cents) return;
    }
    return '你提到了' + display(source.amounts.map(amount => amount.cents)) + '，拟保存的金额是' +
      display(rows.map(row => row.cents)) + '。请确认实际收付金额。';
  }
  if (!matchAmounts(amounts, rows)) return mismatch(amounts, rows);
}
