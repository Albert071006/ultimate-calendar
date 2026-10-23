/** Belonging colors for courses and goals. The first 12 are ordered for mutual contrast; the last 4 are closer spares. */
export const PALETTE = [
  { name: '靛青', hex: '#3b5b9a' }, { name: '胭脂', hex: '#b4416a' }, { name: '松绿', hex: '#23807a' }, { name: '赭石', hex: '#b8611f' },
  { name: '藤紫', hex: '#7b4fa0' }, { name: '草绿', hex: '#5d8a2e' }, { name: '芥黄', hex: '#9a7a12' }, { name: '孔雀蓝', hex: '#2e6e8e' },
  { name: '檀褐', hex: '#7a5230' }, { name: '黛灰', hex: '#55606e' }, { name: '玫紫', hex: '#9b3f8c' }, { name: '苔绿', hex: '#6b7a2a' },
  { name: '湖蓝', hex: '#3f86b8' }, { name: '杏黄', hex: '#c08a2a' }, { name: '竹青', hex: '#3e8f5a' }, { name: '丁香', hex: '#8a6bb8' },
] as const;
export const PRIMARY_COLOR_COUNT = 12;
export type PaletteColor = typeof PALETTE[number]['hex'];
export const PALETTE_COLORS = PALETTE.map(color => color.hex) as [PaletteColor, ...PaletteColor[]];
export const colorName = (hex: string) => PALETTE.find(color => color.hex === hex)?.name ?? hex;
