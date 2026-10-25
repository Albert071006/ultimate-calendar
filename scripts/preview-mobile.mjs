import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
await import('./build-mobile.mjs');
await mkdir('test-results', { recursive: true });
await build({ entryPoints:['scripts/mobile-preview.ts'],outfile:'test-results/mobile-preview.mjs',bundle:true,platform:'node',format:'esm',target:'node24',
  banner:{js:"import { createRequire as __ucCreateRequire } from 'node:module'; const require = __ucCreateRequire(import.meta.url);"} });
const child = spawn(process.execPath, ['test-results/mobile-preview.mjs'], { stdio:'inherit', windowsHide:true });
process.on('SIGINT',()=>child.kill('SIGINT')); process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('exit',code=>{process.exitCode=code??0;});
