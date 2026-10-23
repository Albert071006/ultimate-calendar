import { parse } from 'parse5';
import { PriceCatalogSchema, type PriceCatalog, type PriceQuote, type TokenRates } from '../shared/account';

export const PRICE_URLS = {
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing/',
} as const;
type HtmlNode = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] };
function descendants(node: HtmlNode, name: string): HtmlNode[] {
  return (node.childNodes ?? []).flatMap(child => child.nodeName === name ? [child] : descendants(child, name));
}
function textContent(node: HtmlNode): string {
  if (['script', 'style', 'sup'].includes(node.nodeName)) return '';
  if (node.nodeName === 'br') return ' ';
  return node.value ?? (node.childNodes ?? []).map(textContent).join('');
}
const clean = (node: HtmlNode) => textContent(node).replace(/\s+/g, ' ').trim();
function span(node: HtmlNode, name: string): number {
  const value = node.attrs?.find(a => a.name === name)?.value ?? '1';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error('价格表跨度无效');
  return Number(value);
}
/** Expand physical cells into logical columns before matching model IDs and billing labels. */
function grid(table: HtmlNode): string[][] {
  const rows = descendants(table, 'tr'); if (rows.length > 150) throw new Error('价格表过大');
  const result: string[][] = [];
  rows.forEach((row, ri) => {
    const current = result[ri] ??= []; let ci = 0;
    for (const cell of (row.childNodes ?? []).filter(n => n.nodeName === 'td' || n.nodeName === 'th')) {
      while (current[ci] !== undefined) ci++;
      const width = span(cell, 'colspan'), height = span(cell, 'rowspan');
      if (ci + width > 100 || ri + height > 150) throw new Error('价格表过大');
      for (let r = ri; r < ri + height; r++) {
        const target = result[r] ??= [];
        for (let c = ci; c < ci + width; c++) { if (target[c] !== undefined) throw new Error('价格表单元格重叠'); target[c] = clean(cell); }
      }
      ci += width;
    }
  });
  return result;
}
function price(value: string | undefined, currency: 'CNY' | 'USD'): number {
  const match = (value ?? '').match(currency === 'CNY' ? /^(?:¥|￥)?\s*(\d+(?:\.\d+)?)\s*元$/ : /^\$\s*(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error('未识别的价格单位');
  const result = Number(match[1]); if (!Number.isFinite(result)) throw new Error('价格无效');
  return result;
}
/** Only recognized per-million, peak/off-peak tables are usable; never guess a changed layout. */
export function parsePricing(html: string, currency: 'CNY' | 'USD', updatedAt: string): PriceCatalog {
  if (html.length > 2_000_000) throw new Error('价格页面过大');
  const document = parse(html) as unknown as HtmlNode;
  const grids = descendants(document, 'table').slice(0, 20).map(grid);
  const tables = grids.filter(rows => rows.some(row => /^(MODEL|模型)$/i.test(row[0] ?? '') && row.some(cell => /^deepseek-[a-z0-9-]+$/.test(cell))));
  if (tables.length !== 1) throw new Error('未识别官方模型价格表');
  const rows = tables[0]!;
  const header = rows.find(row => /^(MODEL|模型)$/i.test(row[0] ?? ''))!;
  const columns = header.flatMap((cell, index) => /^deepseek-[a-z0-9-]+$/.test(cell) ? [{ model: cell, index }] : []);
  if (!columns.length || new Set(columns.map(c => c.model)).size !== columns.length) throw new Error('价格表模型重复');
  const firstModel = Math.min(...columns.map(c => c.index));
  const rates = new Map<string, { low: Partial<TokenRates>; high: Partial<TokenRates> }>();
  for (const { model } of columns) rates.set(model, { low: {}, high: {} });
  let count = 0;
  for (const row of rows) {
    const labels = row.slice(0, firstModel).join(' ').toUpperCase();
    if (!/PRICING|价格/.test(labels)) continue;
    if (!/1M |百万/.test(labels)) throw new Error('价格计量单位已改变');
    const field: keyof TokenRates | null = /CACHE MISS|缓存未命中/.test(labels) ? 'inputPerMillion'
      : /CACHE HIT|缓存命中/.test(labels) ? 'cachedInputPerMillion'
        : /OUTPUT|输出/.test(labels) ? 'outputPerMillion' : null;
    const tier = /OFF-PEAK|空闲时段/.test(labels) ? 'low' : /(?:^|\s)PEAK(?:\s|$)|高峰时段/.test(labels) ? 'high' : null;
    if (!field || !tier) throw new Error('价格分档已改变');
    for (const { model, index } of columns) {
      const target = rates.get(model)![tier]; if (target[field] !== undefined) throw new Error('重复的价格分档');
      target[field] = price(row[index], currency);
    }
    count++;
  }
  if (count !== 6) throw new Error('价格表字段不完整');
  const paragraphs = descendants(document, 'p').map(clean);
  const rule = paragraphs.find(p => currency === 'CNY' ? /北京时间/.test(p) && /法定节假日/.test(p) && /高峰时段/.test(p)
    : /Peak hours/.test(p) && /Chinese public holidays/.test(p))?.replace(/^\(\d+\)\s*/, '');
  if (!rule) throw new Error('价格时段规则已改变');
  const entries: PriceQuote[] = columns.map(({ model }) => ({ model, currency, ...rates.get(model)! as { low: TokenRates; high: TokenRates }, updatedAt, sourceUrl: PRICE_URLS[currency] }));
  // These two aliases are only recognized while the official page explicitly describes their Flash billing.
  const aliasParagraph = paragraphs.find(p => p.includes('deepseek-flash') && /Flash (?:价格|price)/.test(p));
  const canonical = entries.find(p => p.model === 'deepseek-flash');
  if (canonical && aliasParagraph) {
    for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      if (new RegExp(`\\b${alias}\\b`).test(aliasParagraph)) entries.push({ ...canonical, model: alias });
    }
  }
  return PriceCatalogSchema.parse({ entries, rule });
}
