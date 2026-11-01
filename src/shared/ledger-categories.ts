/** Suggestions only. Ledger categories remain open text, including user-defined names. */
export const LEDGER_CATEGORY_SUGGESTIONS: readonly string[] = [
  '餐饮', '交通', '购物', '日用品', '学习', '医疗健康', '娱乐', '软件服务', '通讯', '快递物流',
  '水费', '住房', '手续费', '生活费', '工资', '奖金', '借款', '转账', '退款', '其他',
];

export function ledgerCategorySuggestions(entries: readonly { category: string }[]): string[] {
  return [...new Set([...LEDGER_CATEGORY_SUGGESTIONS, ...entries.map(entry => entry.category.trim()).filter(Boolean)])];
}
