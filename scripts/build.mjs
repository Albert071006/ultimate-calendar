import { build as viteBuild } from 'vite';
import { build as bundle } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await viteBuild();
for (const entry of ['main', 'preload']) {
  const path = `src/electron/${entry}.ts`;
  await bundle({ entryPoints: [path], outfile: `dist-electron/${entry}.cjs`, platform: 'node',
    format: 'cjs', target: 'node24', bundle: true, external: ['electron', 'electron-updater'], sourcemap: false });
}

await mkdir('dist-electron/pdf-assets', { recursive: true });
await bundle({ entryPoints: ['src/capture/documents/pdf-preload.ts'], outfile: 'dist-electron/pdf-preload.cjs', platform: 'node', format: 'cjs', target: 'node24', bundle: true, external: ['electron'] });
await bundle({ entryPoints: ['src/capture/documents/document-worker.ts'], outfile: 'dist-electron/document-worker.cjs', platform: 'node', format: 'cjs', target: 'node24', bundle: true });
await bundle({ entryPoints: ['src/capture/documents/pdf-renderer.ts'], outfile: 'dist-electron/pdf-renderer.js', platform: 'browser', format: 'esm', target: 'chrome144', bundle: true });
await cp('src/capture/documents/pdf.html', 'dist-electron/pdf.html');
await cp('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist-electron/pdf-assets/pdf.worker.mjs');
for (const resource of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(`node_modules/pdfjs-dist/${resource}`, `dist-electron/pdf-assets/${resource}`, { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'dist-electron/pdf-assets/LICENSE');
