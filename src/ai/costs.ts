import { PriceQuoteSchema, type PriceQuote, type TokenRates } from '../shared/account';
import type { Settings, TokenUsage } from '../shared/contracts';

type Cost = Pick<TokenUsage, 'estimatedCost' | 'estimatedCostMax' | 'currency' | 'pricingSource' | 'pricingUpdatedAt'>;
const unknownCost: Cost = { estimatedCost: null, estimatedCostMax: null, currency: null, pricingSource: null, pricingUpdatedAt: null };

/** An estimate is a historical quote, never the account's actual bill or balance. */
export function estimateCost(settings: Settings, tokens: { input: number; cached: number; output: number }, quote?: PriceQuote | null): Cost {
  const calculate = (rates: TokenRates) => ((tokens.input - tokens.cached) * rates.inputPerMillion
    + tokens.cached * rates.cachedInputPerMillion + tokens.output * rates.outputPerMillion) / 1_000_000;
  if (settings.pricingMode === 'manual') {
    const prices = settings.tokenPrices;
    if (!prices || prices.model !== settings.model) return { ...unknownCost };
    const cost = calculate({ ...prices, cachedInputPerMillion: prices.cachedInputPerMillion ?? prices.inputPerMillion });
    return Number.isFinite(cost) ? { estimatedCost: cost, estimatedCostMax: cost, currency: prices.currency, pricingSource: 'manual', pricingUpdatedAt: prices.updatedAt } : { ...unknownCost };
  }
  if (settings.pricingMode !== 'auto') return { ...unknownCost };
  const parsed = PriceQuoteSchema.safeParse(quote);
  if (!parsed.success || parsed.data.model !== settings.model || parsed.data.currency !== settings.pricingCurrency) return { ...unknownCost };
  const low = calculate(parsed.data.low), high = calculate(parsed.data.high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return { ...unknownCost };
  return { estimatedCost: low, estimatedCostMax: high, currency: parsed.data.currency, pricingSource: 'official', pricingUpdatedAt: parsed.data.updatedAt };
}
