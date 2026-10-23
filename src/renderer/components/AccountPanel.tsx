import type { AccountState, PriceQuote } from '../../shared/account';
import { displayInstant } from '../calendar-layout';

type Status = { updatedAt: string | null; loading: boolean; error: string | null; data: unknown };
export function AccountResourceStatus({ resource, label, staleAfter }: { resource: Status | undefined; label: string; staleAfter: number }) {
  if (!resource) return <p className="hint">正在读取{label}状态…</p>;
  const stale = !!resource.updatedAt && Date.now() - Date.parse(resource.updatedAt) > staleAfter;
  return <div className="account-status" aria-live="polite">
    {resource.loading && <p className="hint">正在刷新{label}…</p>}
    {resource.error && <p className="error">{label}：{resource.error}{resource.data ? '；以下保留上次结果' : ''}</p>}
    {resource.updatedAt && <p className="fine-print">{label}更新于 {displayInstant(resource.updatedAt)}{stale ? ' · 已过期，等待刷新' : ''}</p>}
  </div>;
}

export function AccountPanel({ state, error, refreshing, refresh, configured }: {
  state: AccountState | null; error: string; refreshing: boolean; refresh: () => Promise<void>; configured: boolean;
}) {
  const balance = state?.balance.data;
  return <div className="account-panel">
    <div className="section-heading account-heading">
      <h4>账户余额 · 官方查询</h4>
      <button type="button" onClick={() => void refresh()} disabled={refreshing}>
        {refreshing ? '正在刷新…' : '刷新账户与价格'}
      </button>
    </div>
    <p className="hint">余额直接来自 DeepSeek 账户，不根据 token 推算。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!configured ? <p className="hint">保存密钥后自动读取可用模型和余额。</p> : balance ? <>
      <div className="account-balances">
        {balance.balances.map(item => <div className="account-balance" key={item.currency}>
          <span>{item.currency === 'CNY' ? '人民币' : '美元'} · {item.currency}</span>
          <strong>{item.total}</strong>
          <small>充值余额 {item.toppedUp} · 赠送余额 {item.granted}</small>
        </div>)}
      </div>
      <p className={balance.isAvailable ? 'success' : 'warning'}>{balance.isAvailable ? '账户余额可用于 API 调用' : '账户余额不足，暂时无法调用 API'}</p>
      {!balance.balances.length && <p className="hint">接口未返回币种余额明细。</p>}
    </> : <p className="hint">余额暂不可用。</p>}
    {configured && <AccountResourceStatus resource={state?.balance} label="余额" staleAfter={60_000} />}
    <p className="fine-print">窗口显示时每 30 秒查询，托盘运行时每 5 分钟查询；AI 请求结束后再刷新。余额以接口返回为准，更新可能有延迟。</p>
  </div>;
}

export function OfficialPrices({ quote, state, model, currency }: { quote: PriceQuote | undefined; state: AccountState | null; model: string; currency: string }) {
  return <div className="official-prices">
    <p className="hint">{model} · {currency} / 百万 tokens · 官方单价</p>
    {quote ? <>
      <div className="table-scroll"><table>
        <thead><tr><th>计费项</th><th>空闲时段</th><th>高峰时段</th></tr></thead>
        <tbody>
          <tr><td>输入 · 缓存命中</td><td>{quote.low.cachedInputPerMillion}</td><td>{quote.high.cachedInputPerMillion}</td></tr>
          <tr><td>输入 · 缓存未命中</td><td>{quote.low.inputPerMillion}</td><td>{quote.high.inputPerMillion}</td></tr>
          <tr><td>输出</td><td>{quote.low.outputPerMillion}</td><td>{quote.high.outputPerMillion}</td></tr>
        </tbody>
      </table></div>
      <p className="fine-print">该单价更新于 {displayInstant(quote.updatedAt)}{Date.now() - Date.parse(quote.updatedAt) > 86_400_000 ? ' · 已过期，不用于新的自动估算' : ''}</p>
      <p className="fine-print">来源：<span className="account-source">{quote.sourceUrl}</span></p>
    </> : <p className="hint">暂未获取此模型与币种的官方价格；新请求会记录 token 用量，费用暂不估算。</p>}
    <AccountResourceStatus resource={state?.prices} label="官方价格" staleAfter={86_400_000} />
    {state?.prices.data?.rule && <p className="fine-print">{state.prices.data.rule}</p>}
    <p className="fine-print">单价每日从官方价格页同步，也可手动刷新。自动费用显示空闲至高峰的估算范围，实际扣费以 DeepSeek 账单为准。</p>
  </div>;
}
