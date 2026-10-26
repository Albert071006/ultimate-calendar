import { build } from 'esbuild';
await build({ entryPoints:['src/server/cli.ts'], outfile:'dist-server/cli.mjs', bundle:true, platform:'node', format:'esm', target:'node24', sourcemap:false,
  banner:{js:"import { createRequire as __ucCreateRequire } from 'node:module'; const require = __ucCreateRequire(import.meta.url);"} });
process.stdout.write('资料服务已构建至 dist-server/cli.mjs（未启动、未部署）\n');
