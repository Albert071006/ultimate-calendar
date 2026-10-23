import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../shared/contracts';
import type { PriceQuote } from '../shared/account';
import { estimateCost } from './costs';

const quote: PriceQuote = { model: 'deepseek-flash', currency: 'CNY', low: { inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4 }, high: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8 }, updatedAt: '2026-10-23T09:00:00+08:00', sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' };
const tokens = { input: 1000, cached: 800, output: 50 };
describe('historical model-bound cost estimates', () => {
  it('uses cache-hit pricing separately and retains both time-of-day bounds', () => {
    const cost = estimateCost(SettingsSchema.parse({}), tokens, quote);
    expect(cost.estimatedCost).toBeCloseTo(0.000416);
    expect(cost.estimatedCostMax).toBeCloseTo(0.000832);
    expect(cost).toMatchObject({ currency: 'CNY', pricingSource: 'official', pricingUpdatedAt: quote.updatedAt });
  });
  it('never substitutes another model or currency, or treats missing prices as zero', () => {
    for (const settings of [{ model: 'unknown-model' }, { pricingCurrency: 'USD' }, { pricingMode: 'off' }]) {
      expect(estimateCost(SettingsSchema.parse(settings), tokens, quote)).toMatchObject({ estimatedCost: null, estimatedCostMax: null, currency: null });
    }
    expect(estimateCost(SettingsSchema.parse({}), tokens)).toMatchObject({ estimatedCost: null });
    expect(estimateCost(SettingsSchema.parse({}), tokens, { ...quote, high: { ...quote.high, outputPerMillion: 0 } })).toMatchObject({ estimatedCost: null });
  });
  it('requires an explicit manual override bound to the selected model', () => {
    const settings = SettingsSchema.parse({ pricingMode: 'manual', tokenPrices: { model: 'deepseek-flash', inputPerMillion: 2, outputPerMillion: 8, currency: 'USD', updatedAt: quote.updatedAt } });
    expect(estimateCost(settings, tokens, quote)).toMatchObject({ estimatedCost: 0.0024, estimatedCostMax: 0.0024, currency: 'USD', pricingSource: 'manual' });
    expect(estimateCost({ ...settings, model: 'deepseek-v4-pro' }, tokens, quote).estimatedCost).toBeNull();
    delete settings.tokenPrices!.model;
    expect(estimateCost(settings, tokens, quote).estimatedCost).toBeNull();
  });
});
