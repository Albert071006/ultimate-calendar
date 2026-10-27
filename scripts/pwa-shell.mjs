import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

export async function writePwaShell(directory = 'dist', workerSource) {
  const root=resolve(directory);
  async function files(path) { const entries=await readdir(path,{withFileTypes:true}); return (await Promise.all(entries.map(entry=>entry.isDirectory()?files(resolve(path,entry.name)):[resolve(path,entry.name)]))).flat(); }
  const paths=(await files(root)).map(path=>'/'+relative(root,path).split(sep).join('/')).filter(path=>path==='/index.html'||path==='/manifest.webmanifest'||/^\/(?:assets|icons)\/[a-zA-Z0-9_./-]+$/.test(path)).sort();
  if (!paths.includes('/index.html')) throw Error('PWA build is missing index.html');
  const source=workerSource ?? await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
  // A changed worker must never install into an active older worker's cache namespace.
  const hash=createHash('sha256').update(source), integrity={};
  for(const path of paths){const content=await readFile(resolve(root,'.'+path));hash.update(path);hash.update(content);integrity[path]=createHash('sha256').update(content).digest('hex');}
  integrity['/']=integrity['/index.html'];
  const version=hash.digest('hex').slice(0,20);
  const worker=source.replace('__UC_BUILD_VERSION__',version).replace('/* __UC_STATIC_ASSETS__ */ []',JSON.stringify(['/',...paths])).replace('/* __UC_STATIC_INTEGRITY__ */ {}',JSON.stringify(integrity));
  await writeFile(resolve(root,'sw.js'),worker);
  return {version,assets:['/',...paths],integrity};
}
