import { useState } from 'react';
import { LedgerAccountSchema, type LedgerAccount } from '../../../shared/ledger';
import { operationId } from '../../calendar-layout';
import type { Save } from './editors';

export function AccountEditor({ account, accounts, busy, error, save, close }: {
  account?: LedgerAccount; accounts: readonly LedgerAccount[]; busy: boolean; error: string; save: Save; close: () => void;
}) {
  const [id] = useState(account?.id ?? `account:${operationId()}`);
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<LedgerAccount['kind']>(account?.kind ?? 'cash');
  const [aliases, setAliases] = useState(account?.aliases.join('\n') ?? '');
  const [formError, setFormError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setFormError('');
    try {
      const cleanName = name.trim();
      if (!cleanName) throw new Error('请填写能区分这个账户的名称。');
      if (accounts.some(value => value.id !== id && value.name.trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new Error('已有同名账户；同一家银行的多张卡请在名称中加尾号区分。');
      const next = LedgerAccountSchema.safeParse({ id, name: cleanName, kind: account?.kind ?? kind,
        aliases: [...new Set(aliases.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))] });
      if (!next.success) throw new Error('账户名称或别名过长，请缩短后再保存。');
      if (await save([{ type: 'putAccount', account: next.data }])) close();
    } catch (value) { setFormError(value instanceof Error ? value.message : '账户尚未保存，请核对后重试。'); }
  };
  return <form className="editor-form ledger-form" onSubmit={event => void submit(event)}>
    <label>账户名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如：中国银行 · 尾号 1234、某店会员卡" /></label>
    <label>账户类型<select value={kind} disabled={!!account} onChange={event => setKind(event.target.value as LedgerAccount['kind'])}>
      <option value="cash">现金账户（银行、支付余额等）</option><option value="stored">储值账户（饭卡、会员卡等）</option>{account?.kind === 'family' && <option value="family">亲情卡</option>}
    </select></label>
    <label>别名（可留空，每行一个）<textarea rows={3} maxLength={4000} value={aliases} onChange={event => setAliases(event.target.value)} placeholder="记账时你会使用的称呼" /></label>
    <p className="ledger-form-note">同一家银行的多张卡请用尾号等不同名称区分。别名相同会先询问，不会自动合并账户。</p>
    <p className="ledger-form-note">{account ? '只更改名称和别名，原有流水与余额继续属于同一个账户。' : '新增后余额为未知；需要时再核对余额。不会把历史账目自动归到新账户。'}</p>
    {(formError || error) && <p className="error" role="alert">{formError || error}</p>}
    <footer className="form-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存账户'}</button></footer>
  </form>;
}
