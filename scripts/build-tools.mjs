import { build } from 'esbuild';
for (const name of ['remote', 'bridge', 'migration']) {
  await build({ entryPoints: [`src/${name}/cli.ts`], outfile: `dist-tools/${name}.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
}
