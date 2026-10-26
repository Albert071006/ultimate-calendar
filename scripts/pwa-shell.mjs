import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

export async function writePwaShell(directory = 'dist') {
  const root=resolve(directory);
  async function files(path) { const entries=await readdir(path,{withFileTypes:true}); return (await Promise.all(entries.map(entry=>entry.isDirectory()?files(resolve(path,entry.name)):[resolve(path,entry.name)]))).flat(); }
  const paths=(await files(root)).map(path=>'/'+relative(root,path).split(sep).join('/')).filter(path=>path==='/index.html'||path==='/manifest.webmanifest'||/^\/(?:assets|icons)\/[a-zA-Z0-9_./-]+$/.test(path)).sort();
  if (!paths.includes('/index.html')) throw Error('PWA build is missing index.html');
  const hash=createHash('sha256');
  for(const path of paths){hash.update(path);hash.update(await readFile(resolve(root,'.'+path)));}
  const version=hash.digest('hex').slice(0,20);
  const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
  const worker=source.replace('__UC_BUILD_VERSION__',version).replace('/* __UC_STATIC_ASSETS__ */ []',JSON.stringify(['/',...paths]));
  await writeFile(resolve(root,'sw.js'),worker);
  return {version,assets:['/',...paths]};
}
