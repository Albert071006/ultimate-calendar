// Draws the app icon — a calendar page that grows a speech-bubble tail, with the AI spark — and renders it with
// Electron into assets/app-icon.svg, app-icon.png (256) and a multi-size app-icon.ico. Run: npm run icon
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rendering must not share the installed app's profile or depend on desktop DPI.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ultimate-calendar-icon-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const paper = '#fbf8f1', ink = '#1f1c18', red = '#b23824', gold = '#d29a26';
const spark = (cx, cy, r, k = 0.2) => { const a = r * k;
  return `M${cx} ${cy - r}Q${cx + a} ${cy - a} ${cx + r} ${cy}Q${cx + a} ${cy + a} ${cx} ${cy + r}Q${cx - a} ${cy + a} ${cx - r} ${cy}Q${cx - a} ${cy - a} ${cx} ${cy - r}Z`; };
const page = 'M48 46H208A18 18 0 0 1 226 64V190A18 18 0 0 1 208 208H108L56 244L66 208H48A18 18 0 0 1 30 190V64A18 18 0 0 1 48 46Z';

/** The icon on a 256 grid. Small sizes get a heavier outline and drop the second spark so they stay legible. */
export function iconSvg(size = 256) {
  const stroke = size >= 64 ? 9 : size >= 32 ? 14 : 20, ring = size >= 32 ? 18 : 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}">
  <path d="${page}" fill="${paper}"/>
  <path d="M48 46H208A18 18 0 0 1 226 64V96H30V64A18 18 0 0 1 48 46Z" fill="${red}"/>
  <path d="${page}" fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linejoin="round"/>
  <rect x="${81 - ring / 2}" y="22" width="${ring}" height="44" rx="${ring / 2}" fill="${ink}"/><rect x="${175 - ring / 2}" y="22" width="${ring}" height="44" rx="${ring / 2}" fill="${ink}"/>
  <path d="${spark(124, 152, size >= 32 ? 40 : 48)}" fill="${red}"/>
  ${size >= 48 ? `<path d="${spark(176, 124, 15)}" fill="${gold}"/>` : ''}
</svg>`;
}

/** Lays every size out side by side in one transparent page, captures it once and crops each icon out. */
async function render(sizes) {
  const gap = 8, width = sizes.reduce((sum, size) => sum + size + gap, 0), height = Math.max(...sizes);
  const window = new BrowserWindow({ show: false, width, height, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  let x = 0;
  const placed = sizes.map(size => { const at = x; x += size + gap; return { size, x: at }; });
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{position:absolute;top:0}</style>`
    + placed.map(({ size, x: left }) => iconSvg(size).replace('<svg ', `<svg style="left:${left}px" `)).join('');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const sheet = await window.webContents.capturePage({ x: 0, y: 0, width, height });
  window.destroy();
  const scale = sheet.getSize().width / width;
  return placed.map(({ size, x: left }) => ({ size, png: sheet.crop({ x: Math.round(left * scale), y: 0, width: Math.round(size * scale), height: Math.round(size * scale) }).resize({ width: size, height: size, quality: 'best' }).toPNG() }));
}

/** An ICO whose entries are PNGs (supported since Windows Vista), largest last as Explorer expects nothing in particular. */
function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header[at] = size >= 256 ? 0 : size; header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.png)]);
}

// A top-level await on whenReady() would hold back Electron's own ready event, so chain it instead.
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* keep running to write the files; quit explicitly below */ });
setTimeout(() => { console.error('Icon rendering timed out'); app.exit(1); }, 30_000).unref();
app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256], entries = await render(sizes);
  await mkdir('assets', { recursive: true });
  await writeFile('assets/app-icon.svg', iconSvg());
  await writeFile('assets/app-icon.png', entries.at(-1).png);
  await writeFile('assets/app-icon.ico', ico(entries));
  console.log(`Wrote assets/app-icon.{svg,png,ico} (${sizes.join(', ')} px)`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
