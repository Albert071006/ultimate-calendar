import { build } from 'vite';
import { writePwaShell } from './pwa-shell.mjs';
await build();
const shell=await writePwaShell();
process.stdout.write(`手机静态壳已构建：${shell.version}，${shell.assets.length} 个静态资源（不含用户资料）\n`);
