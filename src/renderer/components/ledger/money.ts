export const ledgerMoney = (cents: number | null | undefined) => cents == null ? '待确认' : `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A change in balance: "+¥12.00" / "−¥36.00". */
export const ledgerChange = (cents: number) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${ledgerMoney(Math.abs(cents))}`;
