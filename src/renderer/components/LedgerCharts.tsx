import { todayDate } from '../calendar-layout';

export const ledgerMoney = (cents: number | null | undefined) => cents == null ? '待确认' : `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const colors = ['#267e70', '#8ea99a', '#b7a17b', '#8095b6', '#b096b3', '#c2c9bd', '#7d9da0', '#c6ad98'];

export function LedgerCategoryChart({ values, onSelect }: {
  values: Array<{ category: string; cents: number }>;
  onSelect: (category: string) => void;
}) {
  const positive = values.filter(value => value.cents > 0).sort((a, b) => b.cents - a.cents);
  const total = positive.reduce((sum, value) => sum + value.cents, 0);
  let offset = 0;
  return <section className="ledger-card ledger-chart-card" aria-label="开销分类">
    <div className="ledger-section-heading"><h3>开销分类</h3><small>个人承担金额</small></div>
    {positive.length ? <div className="ledger-category-chart">
      <div className="ledger-donut">
        <svg viewBox="0 0 120 120" role="img" aria-label={`按分类统计的个人开销，共 ${ledgerMoney(total)}`}>
          <circle cx="60" cy="60" r="45" fill="none" stroke="#edf0e8" strokeWidth="14" />
          {positive.map((value, index) => {
            const length = value.cents / total * 100;
            const start = offset; offset += length;
            return <circle key={value.category} cx="60" cy="60" r="45" fill="none" pathLength="100"
              stroke={colors[index % colors.length]} strokeWidth="14" strokeDasharray={`${length} ${100 - length}`}
              strokeDashoffset={-start} transform="rotate(-90 60 60)"><title>{value.category} {ledgerMoney(value.cents)}</title></circle>;
          })}
        </svg>
        <div><small>个人开销</small><strong>{ledgerMoney(total)}</strong></div>
      </div>
      <div className="ledger-legend">{positive.map((value, index) => <button type="button" key={value.category} onClick={() => onSelect(value.category)}
        aria-label={`查看${value.category}明细 ${ledgerMoney(value.cents)}`}>
        <span className="ledger-swatch" style={{ background: colors[index % colors.length] }} />
        <span>{value.category}</span><strong>{ledgerMoney(value.cents)}</strong>
      </button>)}</div>
    </div> : <p className="ledger-empty-chart">这个月还没有已确认的个人开销</p>}
  </section>;
}

export function LedgerDailyChart({ month, values, unknownDateCents, onSelect }: {
  month: string;
  values: Array<{ date: string; cents: number }>;
  unknownDateCents: number;
  onSelect: (date: string) => void;
}) {
  const current = todayDate(), daysInMonth = new Date(`${month}-01T00:00:00Z`);
  daysInMonth.setUTCMonth(daysInMonth.getUTCMonth() + 1); daysInMonth.setUTCDate(0);
  const days = month === current.slice(0, 7) ? Number(current.slice(8)) : month > current.slice(0, 7) ? 0 : daysInMonth.getUTCDate();
  const byDate = new Map(values.map(value => [value.date, value.cents]));
  const maximum = Math.max(1, ...values.map(value => value.cents));
  return <section className="ledger-card ledger-chart-card" aria-label="每日开销">
    <div className="ledger-section-heading"><h3>每日开销</h3><small>{days ? `${Number(month.slice(5))} 月 1–${days} 日 · 元` : '未来月份'}</small></div>
    <div className="ledger-trend" role="group" aria-label="每日个人开销，点击查看明细">
      <span className="ledger-trend-max">{(maximum / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</span>
      {Array.from({ length: days }, (_, index) => {
        const day = index + 1, date = `${month}-${String(day).padStart(2, '0')}`, cents = byDate.get(date) ?? 0;
        return <button type="button" key={date} className="ledger-day-bar" onClick={() => onSelect(date)}
          aria-label={`${date} 个人开销 ${ledgerMoney(cents)}`} title={`${date} · ${ledgerMoney(cents)}`}>
          <span className="ledger-bar-track"><span style={{ height: `${Math.max(cents ? 2 : 0, cents / maximum * 100)}%` }} /></span>
          <small>{day === 1 || day % 5 === 0 || day === days ? day : ''}</small>
        </button>;
      })}
      {!days && <p className="ledger-empty-chart">尚未发生的日期不展示消费</p>}
    </div>
    <small className="ledger-chart-note">{unknownDateCents ? `另有 ${ledgerMoney(unknownDateCents)} 日期待确认，已计入月合计` : '按原消费日期统计；退款、报销回改原消费月'}</small>
  </section>;
}
