import { createHash } from 'node:crypto';
import { ledgerAccounts, type LedgerAccount, type LedgerMutationRequest, type LedgerQuery, type LedgerSnapshot } from '../shared/ledger';
import type { LedgerIntent } from '../shared/ledger-command';
import type { CommandRequest } from '../shared/contracts';
import { WorkflowError } from './deepseek';

const bankNames = [
  ['中国银行', '中行'], ['招商银行', '招行'], ['中国工商银行', '工商银行', '工行'],
  ['中国农业银行', '农业银行', '农行'], ['中国建设银行', '建设银行', '建行'], ['交通银行', '交行'],
  ['中国邮政储蓄银行', '邮政储蓄银行', '邮储银行', '邮储'], ['中信银行'], ['光大银行'], ['华夏银行'],
  ['民生银行'], ['广发银行'], ['平安银行'], ['兴业银行'], ['浦发银行'], ['北京银行'], ['上海银行'], ['宁波银行'],
] as const;
const compact = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').replace(/尾号|尾数|卡号后四位|卡号后4位/g, '');
const bankAliases = new Map<string, string>(bankNames.flatMap(names => names.map(alias => [alias, names[0]] as [string, string])));
const bankPattern = new RegExp([...bankAliases.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
const normalize = (value: string) => compact(value).replace(bankPattern, alias => bankAliases.get(alias)!);
const genericName = (name: string) => /^(?:银行(?:卡|账户)?|储蓄(?:卡|账户)?|借记卡|现金账户|现金|会员卡|储值卡|储值会员卡|会员账户|储值账户|银行卡账户|未命名账户|新账户)$/.test(compact(name));
const labels = (account: LedgerAccount) => [account.name, ...account.aliases];
const evidence = (request: CommandRequest) => {
  const history = request.history ?? [];
  const prior = history.at(-1), user = history.at(-2);
  return [request.text, ...(prior?.role === 'assistant' && prior.outcome?.phase === 'clarification' && user?.role === 'user' ? [user.text] : [])].join('\n');
};
const mentionedBanks = (value: string): string[] => bankNames.filter(names => names.some(name => value.includes(name))).map(names => names[0]);
// Unknown bank names remain literal identities; this is not a bank-name allowlist.
const bankIdentity = (label: string) => normalize(label).match(/^[\p{Script=Han}a-z]{2,24}?银行/u)?.[0];
const accountBanks = (account: LedgerAccount) => [...new Set(labels(account).flatMap(label => {
  const identity = bankIdentity(label); return identity ? [identity] : mentionedBanks(label);
}))];
const isBank = (account: LedgerAccount) => account.id === 'cmb' || labels(account).some(label => /银行|储蓄卡|借记卡/.test(label)) || accountBanks(account).length > 0;
const nameCore = (label: string) => normalize(label).replace(/(?:账户|余额|储值会员卡|储值卡|会员卡|银行卡|借记卡|储蓄卡)$/u, '');
const specificLabels = (account: LedgerAccount) => [...new Set(labels(account).flatMap(label => [normalize(label), nameCore(label), nameCore(normalize(label).replace(/\d{2,}$/, ''))]))]
  .filter(label => label.length > 1 && !genericName(label) && !/^\d+$/.test(label));
const tails = (words: string) => [...words.matchAll(/(?:尾号|尾数|卡号后四位|卡号后4位)\s*[:：]?\s*(\d{2,})/g)].map(match => match[1]!);
const hasTail = (account: LedgerAccount, tail: string) => labels(account).some(label => (label.match(/\d{2,}/g) ?? []).some(number => number.endsWith(tail)));
const specificMention = (account: LedgerAccount, words: string) => specificLabels(account).some(label => normalize(words).includes(label)) || tails(words).some(tail => hasTail(account, tail));
function uniqueMention(account: LedgerAccount, accounts: readonly LedgerAccount[], words: string): boolean {
  const requested = normalize(words), explicitTails = tails(words);
  if (explicitTails.some(tail => hasTail(account, tail) && accounts.filter(candidate => hasTail(candidate, tail)).length === 1)) return true;
  return specificLabels(account).some(label => requested.includes(label) &&
    (!/\d{2,}/.test(label) || explicitTails.some(tail => hasTail(account, tail))) &&
    accounts.filter(candidate => specificLabels(candidate).includes(label)).length === 1);
}
function sameIdentity(left: LedgerAccount, right: LedgerAccount): boolean {
  if (left.kind !== right.kind) return false;
  const rightLabels = specificLabels(right), rightBanks = accountBanks(right);
  return specificLabels(left).some(label => rightLabels.includes(label)) || accountBanks(left).some(bank => rightBanks.includes(bank));
}
const namedInRequest = (name: string, words: string) => {
  const coreName = nameCore(name);
  return coreName.length > 1 && normalize(words).includes(coreName);
};
function assertNewAccountLabels(name: string, aliases: readonly string[], words: string): void {
  if (!namedInRequest(name, words)) throw new WorkflowError('AI_RESPONSE', '新账户名称未由本条指令明确提供，不能擅自建立或合并账户，请核对银行或店铺名称');
  const identity = bankIdentity(name), core = nameCore(name), requested = normalize(words);
  for (const alias of aliases) {
    const aliasIdentity = bankIdentity(alias), value = normalize(alias), aliasCore = nameCore(alias);
    if (identity && aliasIdentity && identity !== aliasIdentity) throw new WorkflowError('AI_RESPONSE', '新账户的银行名称与别名不一致，不能把不同银行合并为一张卡');
    // Canonical bank abbreviations and names derived from the stated merchant
    // are grounded; unrelated invented nicknames are not.
    if (!requested.includes(value) && !(aliasCore.length > 1 && (aliasCore === core || core.includes(value)))) {
      throw new WorkflowError('AI_RESPONSE', '新账户别名没有本条指令中的名称依据，请只使用用户提供的银行、店铺或专属称呼');
    }
  }
}

/** A narrow deterministic boundary for explicit account names. It rejects an AI
 * proposal that substitutes a different bank or a generic card; it does not try
 * to infer every transaction's account from free-form prose. */
function assertGroundedAccounts(ids: Array<string | null>, accounts: readonly LedgerAccount[], request: CommandRequest): void {
  const words = evidence(request), banks = mentionedBanks(words);
  const selected = accounts.filter(account => ids.includes(account.id));
  for (const account of selected) {
    if (isBank(account)) {
      const identities = accountBanks(account);
      if (banks.length && !identities.some(name => banks.includes(name)) && !specificMention(account, words)) throw new WorkflowError('AI_RESPONSE', '账户识别不一致：不能把明确的银行记到另一家银行或泛称银行卡；请重新分析并使用独立账户。');
      if (/银行|储蓄卡|借记卡/.test(words) && !specificMention(account, words)) throw new WorkflowError('AI_RESPONSE', '银行卡尚未匹配，不能把明确的银行记到泛称或另一账户；请使用对应独立账户。');
    }
    if (account.kind === 'stored' && /会员卡|储值卡|储值会员卡/.test(words) && !specificMention(account, words)) {
      throw new WorkflowError('AI_RESPONSE', '会员卡所属店铺尚未匹配，不能把不同店铺记到同一张卡；请说明店铺名称后重新分析。');
    }
    if ((isBank(account) || account.kind === 'stored') && accounts.some(other => other.id !== account.id && sameIdentity(account, other)) && !uniqueMention(account, accounts, words)) {
      throw new WorkflowError('AI_RESPONSE', '这个银行或店铺有多张卡，不能擅自选择其中一张；请提供尾号或唯一专属称呼后重新分析');
    }
  }
}

export function prepareLedgerAccounts(intent: Extract<LedgerIntent, { kind: 'mutate' }>, snapshot: LedgerSnapshot, request: CommandRequest) {
  const accounts = ledgerAccounts(snapshot).map(account => ({ ...account, aliases: [...account.aliases] }));
  const keys = new Map<string, string>();
  const changes: LedgerMutationRequest['changes'] = [];
  for (const change of intent.changes) if (change.type === 'createAccount') {
    if (keys.has(change.key)) throw new WorkflowError('AI_RESPONSE', '账户提案包含重复编号，请重新分析');
    if (genericName(change.name)) throw new WorkflowError('AI_RESPONSE', '新账户需要明确的银行、店铺或账户名称，不能新建泛称银行卡或会员卡');
    assertNewAccountLabels(change.name, change.aliases, evidence(request));
    const name = normalize(change.name);
    const matches = accounts.filter(account => labels(account).some(label => normalize(label) === name));
    if (matches.length > 1) throw new WorkflowError('AI_RESPONSE', '这个账户名称对应多张卡，请说明尾号或其他标识，不能擅自合并');
    if (matches[0]) {
      if (matches[0].kind !== change.kind) throw new WorkflowError('AI_RESPONSE', '账户类型与已有账户不一致，请核对');
      assertGroundedAccounts([matches[0].id], accounts, request);
      keys.set(change.key, matches[0].id);
      if (!changes.some(item => item.type === 'putAccount' && item.account.id === matches[0]!.id)) changes.push({ type: 'putAccount', account: matches[0] });
      continue;
    }
    const account: LedgerAccount = { id: `account:${createHash('sha256').update(`${request.operationId}:${change.key}`).digest('hex')}`, name: change.name, kind: change.kind, aliases: [...new Set(change.aliases)] };
    accounts.push(account); keys.set(change.key, account.id); changes.push({ type: 'putAccount', account });
  }
  const resolve = (id: string | null): string | null => {
    if (id === null) return null;
    const resolved = keys.get(id) ?? id;
    if (!accounts.some(account => account.id === resolved)) throw new WorkflowError('AI_RESPONSE', '未找到提案使用的账户，请重新分析并引用已有账户或建立独立账户');
    return resolved;
  };
  return { changes, accounts, resolve, assertGrounded: (ids: Array<string | null>) => assertGroundedAccounts(ids, accounts, request) };
}

export function validateLedgerQueryAccount(query: LedgerQuery, snapshot: LedgerSnapshot, request: CommandRequest): void {
  if (query.accountId === undefined) return;
  const accounts = ledgerAccounts(snapshot);
  if (!accounts.some(account => account.id === query.accountId)) throw new WorkflowError('AI_RESPONSE', '查询引用了不存在的账户，请重新分析');
  assertGroundedAccounts([query.accountId], accounts, request);
}
