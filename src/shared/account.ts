import { z } from 'zod';

export const CurrencySchema = z.enum(['CNY', 'USD']);
const timestamp = z.iso.datetime({ offset: true });
const modelId = z.string().trim().min(1).max(100);
const decimal = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/);
export const ModelInfoSchema = z.strictObject({
  id: modelId, name: z.string().min(1).max(200).optional(),
  contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.string().min(1).max(30)).max(20).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export const BalanceInfoSchema = z.strictObject({
  isAvailable: z.boolean(),
  balances: z.array(z.strictObject({ currency: CurrencySchema, total: decimal, granted: decimal, toppedUp: decimal })).max(10)
    .refine(items => new Set(items.map(item => item.currency)).size === items.length, '币种不得重复'),
});
export type BalanceInfo = z.infer<typeof BalanceInfoSchema>;
export const TokenRatesSchema = z.strictObject({
  inputPerMillion: z.number().finite().nonnegative(), cachedInputPerMillion: z.number().finite().nonnegative(),
  outputPerMillion: z.number().finite().nonnegative(),
});
export type TokenRates = z.infer<typeof TokenRatesSchema>;
export const PriceQuoteSchema = z.strictObject({
  model: modelId, currency: CurrencySchema, low: TokenRatesSchema, high: TokenRatesSchema,
  updatedAt: timestamp,
  sourceUrl: z.enum(['https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', 'https://api-docs.deepseek.com/quick_start/pricing/']),
}).refine(value => Object.keys(value.low).every(key => value.low[key as keyof TokenRates] <= value.high[key as keyof TokenRates]), '价格范围无效');
export type PriceQuote = z.infer<typeof PriceQuoteSchema>;
export const PriceCatalogSchema = z.strictObject({ entries: z.array(PriceQuoteSchema).max(200), rule: z.string().max(4000) });
export type PriceCatalog = z.infer<typeof PriceCatalogSchema>;
export function ResourceSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data: data.nullable(), updatedAt: timestamp.nullable(), loading: z.boolean(), error: z.string().max(1000).nullable() });
}
export interface Resource<T> { data: T | null; updatedAt: string | null; loading: boolean; error: string | null }
export const AccountStateSchema = z.strictObject({
  configured: z.boolean(), models: ResourceSchema(z.array(ModelInfoSchema).max(500)),
  balance: ResourceSchema(BalanceInfoSchema), prices: ResourceSchema(PriceCatalogSchema),
});
export type AccountState = z.infer<typeof AccountStateSchema>;
export function emptyAccountState(): AccountState {
  const empty = () => ({ data: null, updatedAt: null, loading: false, error: null });
  return { configured: false, models: empty(), balance: empty(), prices: empty() };
}
