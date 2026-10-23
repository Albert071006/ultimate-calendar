import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePricing } from './pricing';
const cny = readFileSync(new URL('./fixtures/pricing-cny.html', import.meta.url), 'utf8');
const usd = readFileSync(new URL('./fixtures/pricing-usd.html', import.meta.url), 'utf8');
const timestamp = '2026-10-23T12:00:00+08:00';
describe('official public pricing parser', () => {
  it('expands rowspan/colspan and reads the actual official CNY/USD table excerpts', () => {
    const cn = parsePricing(cny, 'CNY', timestamp), en = parsePricing(usd, 'USD', timestamp);
    expect(cn.entries.find(p => p.model === 'deepseek-flash')).toMatchObject({
      low: { inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4 },
      high: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8 },
    });
    expect(en.entries.find(p => p.model === 'deepseek-v4-pro')).toMatchObject({
      low: { inputPerMillion: 0.66, cachedInputPerMillion: 0.022, outputPerMillion: 1.98 },
      high: { inputPerMillion: 1.32, cachedInputPerMillion: 0.044, outputPerMillion: 3.96 },
    });
    expect(cn.rule).toContain('法定节假日'); expect(en.rule).toContain('Chinese public holidays');
    expect(cn.entries.find(p => p.model === 'deepseek-v4-flash-vision-exp')?.low).toEqual(cn.entries[0]!.low);
    expect(en.entries.find(p => p.model === 'deepseek-v4-flash')?.high).toEqual(en.entries[0]!.high);
  });
  it('uses model header positions and handles reordering, not fixed model names', () => {
    const result = parsePricing(usd.replaceAll('deepseek-v4-pro', 'deepseek-future'), 'USD', timestamp);
    expect(result.entries.find(p => p.model === 'deepseek-future')?.low.outputPerMillion).toBe(1.98);
  });
  it('does not invent alias prices once their documented billing paragraph is removed', () => {
    const html = cny.replace(/<p>\(1\)[\s\S]*?<\/p>/, '');
    expect(parsePricing(html, 'CNY', timestamp).entries.map(e => e.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });
  it.each([
    (html: string) => html.replaceAll('百万tokens', '千tokens'),
    (html: string) => html.replace('0.02元', '未知'),
    (html: string) => html.replace('0.02元', '-1元'),
    (html: string) => html.replace('0.02元', '100元'),
    (html: string) => html.replaceAll('高峰时段</td>', '任意时段</td>'),
    (html: string) => html.replace(/<p>\(2\)[\s\S]*?<\/p>/, ''),
    (html: string) => html.replace('rowspan="6"', 'rowspan="9999"'),
  ])('rejects changed units, incomplete tiers, impossible ranges, and unsupported structures', mutate => {
    expect(() => parsePricing(mutate(cny), 'CNY', timestamp)).toThrow();
  });
  it('does not parse a JSON/error page or the wrong currency as rates', () => {
    expect(() => parsePricing('{"error":"private"}', 'CNY', timestamp)).toThrow();
    expect(() => parsePricing(usd, 'CNY', timestamp)).toThrow();
  });
});
