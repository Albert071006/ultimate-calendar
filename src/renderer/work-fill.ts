// Execution sessions fill with their belonging color darkened toward #111, so the light --on-dark text on
// them stays at WCAG AA (4.5:1). Most palette colors pass at 82%; lighter ones are darkened only as far as needed.
const onDark = [0xf5, 0xf0, 0xe6], shade = 0x11;
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const cache = new Map<string, string>();

/** The `--wf` value for a work block of this color, e.g. `color-mix(in srgb, #23807a 82%, #111)`. */
export function workFill(color: string): string {
  const known = cache.get(color);
  if (known) return known;
  const rgb = /^#[0-9a-f]{6}$/i.test(color) ? [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) : null;
  let percent = 82;
  if (rgb) {
    const text = luminance(onDark);
    while (percent > 40 && (text + 0.05) / (luminance(rgb.map(v => v * percent / 100 + shade * (1 - percent / 100))) + 0.05) < 4.5) percent--;
  }
  const value = `color-mix(in srgb, ${color} ${percent}%, #111)`;
  cache.set(color, value);
  return value;
}
