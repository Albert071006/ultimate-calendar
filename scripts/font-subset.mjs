// Builds the bundled serif subset from a developer-supplied Noto Serif SC (SIL OFL 1.1) font file.
// Usage: node scripts/font-subset.mjs <path-to-NotoSerifSC> (or set PLANNER_SERIF_SOURCE).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2] ?? process.env.PLANNER_SERIF_SOURCE;
if (!source) { console.error('请提供 Noto Serif SC 字体文件路径：node scripts/font-subset.mjs <字体文件>'); process.exit(1); }
const output = join(root, 'src', 'renderer', 'theme', 'fonts', 'NotoSerifSC-SemiBold-subset.woff2');
const LIMIT = 5 * 1024 * 1024;

/** GB2312 symbols (rows 1–9) and level 1 and 2 hanzi (rows 16–87), plus printable ASCII. */
function characters() {
  const decoder = new TextDecoder('gbk', { fatal: true });
  const chars = new Set();
  for (let code = 0x20; code < 0x7f; code++) chars.add(String.fromCharCode(code));
  const rows = [...Array.from({ length: 9 }, (_, i) => 0xa1 + i), ...Array.from({ length: 72 }, (_, i) => 0xb0 + i)];
  for (const lead of rows) for (let trail = 0xa1; trail <= 0xfe; trail++) {
    try { chars.add(decoder.decode(new Uint8Array([lead, trail]))); } catch { /* unassigned position */ }
  }
  return [...chars].join('');
}

const text = characters();
const font = await subsetFont(await readFile(source), text, { targetFormat: 'woff2', variationAxes: { wght: 600 } });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, font);
console.log(`已生成 ${output.slice(root.length + 1)}：${text.length} 个字符，${(font.length / 1024 / 1024).toFixed(2)} MB`);
if (font.length > LIMIT) { console.error('字体子集超过 5MB，请先与用户确认后再使用。'); process.exit(2); }
