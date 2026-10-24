import { expect, it } from 'vitest';
import { PALETTE } from '../shared/palette';
import { workFill } from './work-fill';

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (value: number[]) => {
  const [r, g, b] = value.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

it('keeps --on-dark text on every palette color at AA and darkens only the colors that need it', () => {
  const percents = PALETTE.map(({ hex }) => {
    const percent = Number(/ (\d+)%/.exec(workFill(hex))![1]);
    const fill = rgb(hex).map(v => v * percent / 100 + 0x11 * (1 - percent / 100));
    expect((luminance(rgb('#f5f0e6')) + 0.05) / (luminance(fill) + 0.05)).toBeGreaterThanOrEqual(4.5);
    return percent;
  });
  expect(percents.filter(percent => percent === 82).length).toBeGreaterThanOrEqual(PALETTE.length - 2);
  expect(workFill('#23807a')).toBe('color-mix(in srgb, #23807a 82%, #111)');
});
