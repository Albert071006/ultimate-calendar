export const ledgerMoney = (cents: number | null | undefined) => cents == null ? '待确认' : `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
