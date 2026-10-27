import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { writePwaShell } from './pwa-shell.mjs';

const directories=[];
afterEach(async()=>{for(const directory of directories.splice(0)){if(!resolve(directory).startsWith(resolve(tmpdir())+'\\')&&!resolve(directory).startsWith(resolve(tmpdir())+'/'))throw Error('Test cleanup escaped temporary directory');await rm(directory,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'ultimate-calendar-pwa-'));directories.push(root);for(const directory of ['assets','icons','api'])await mkdir(join(root,directory));await writeFile(join(root,'index.html'),'<html>synthetic shell</html>');await writeFile(join(root,'assets','app-synthetic.js'),'synthetic static code');await writeFile(join(root,'icons','icon-192.png'),'synthetic icon');await writeFile(join(root,'api','private.json'),'never cache');await writeFile(join(root,'manifest.webmanifest'),'{}');return root;}
function worker(source){const handlers=new Map();const cache={match:vi.fn(async()=>new Response('cached shell')),put:vi.fn()};const store={open:vi.fn(async()=>cache),keys:vi.fn(async()=>[]),delete:vi.fn()};const focus=vi.fn(),navigate=vi.fn();const clients={claim:vi.fn(),matchAll:vi.fn(async()=>[{url:'https://calendar.example.org/',focus,navigate}]),openWindow:vi.fn()};const showNotification=vi.fn();const fetcher=vi.fn(async()=>new Response('<html>synthetic shell</html>'));runInNewContext(source,{URL,Request,Response,Date,Set,Error,crypto:webcrypto,caches:store,fetch:fetcher,self:{location:{origin:'https://calendar.example.org'},addEventListener:(name,handler)=>handlers.set(name,handler),clients,registration:{showNotification}}});return{handlers,cache,store,fetcher,clients,showNotification,navigate};}
function lifecycle(w, name) { let work; w.handlers.get(name)({ waitUntil: value => { work = value; } }); return work; }
function serveFixture(w, root, changedPath) {
  w.fetcher.mockImplementation(async request => {
    const path = new URL(request.url).pathname;
    return new Response(path === changedPath ? 'another deployment returned HTTP 200' : await readFile(join(root, path === '/' ? 'index.html' : path.slice(1))));
  });
}
describe('PWA static application shell',()=>{
  it('hashes only static build resources, excludes API data, and changes version with the shell',async()=>{const root=await fixture();const first=await writePwaShell(root);expect(first.assets).toEqual(['/','/assets/app-synthetic.js','/icons/icon-192.png','/index.html','/manifest.webmanifest']);const content=await readFile(join(root,'sw.js'),'utf8');expect(content).not.toContain('never cache');expect(content).not.toContain('__UC_BUILD_VERSION__');await writeFile(join(root,'assets','app-synthetic.js'),'new synthetic code');expect((await writePwaShell(root)).version).not.toBe(first.version);});
  it('uses a different cache namespace when only the worker changes and hashes root as index.html', async () => {
    const root = await fixture(), source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    const first = await writePwaShell(root, source), second = await writePwaShell(root, source + '\n// synthetic worker revision\n');
    expect(second.version).not.toBe(first.version);
    expect(first.integrity['/']).toBe(first.integrity['/index.html']);
    expect(Object.keys(first.integrity).sort()).toEqual([...first.assets].sort());
    expect(Object.values(first.integrity).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  });
  it.each(['/index.html', '/assets/app-synthetic.js'])('rejects a mixed-version HTTP 200 response for %s before installation can complete', async changedPath => {
    const root = await fixture(); await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8')); serveFixture(w, root, changedPath);
    await expect(lifecycle(w, 'install')).rejects.toThrow('version changed');
    expect(w.cache.put.mock.calls.some(([path]) => path === changedPath)).toBe(false);
    expect(w.clients.claim).not.toHaveBeenCalled(); expect(w.store.delete).not.toHaveBeenCalled();
  });
  it('installs only content-verified build resources and opens that complete shell offline', async () => {
    const root = await fixture(), shell = await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8')), saved = new Map();
    serveFixture(w, root);
    w.cache.put.mockImplementation(async (path, response) => { saved.set(path, response.clone()); });
    w.cache.match.mockImplementation(async path => saved.get(path)?.clone());
    await lifecycle(w, 'install'); await lifecycle(w, 'activate');
    expect([...saved.keys()].sort()).toEqual([...shell.assets].sort());
    expect(w.fetcher.mock.calls.every(([, options]) => options.credentials === 'omit' && options.redirect === 'error')).toBe(true);
    w.fetcher.mockRejectedValue(new Error('Synthetic offline'));
    let response; w.handlers.get('fetch')({ request: { url: 'https://calendar.example.org/', method: 'GET', mode: 'navigate' }, respondWith: value => { response = value; } });
    expect(await (await response).text()).toBe('<html>synthetic shell</html>');
  });
  it('does not intercept API/auth responses, cross-origin requests, writes or query strings',async()=>{const root=await fixture();await writePwaShell(root);const w=worker(await readFile(join(root,'sw.js'),'utf8'));for(const [path,method] of [['/api/v1/session','GET'],['/auth','GET'],['/','POST'],['/index.html?account=secret','GET'],['https://elsewhere.example/assets/app-synthetic.js','GET']]){const respondWith=vi.fn();w.handlers.get('fetch')({request:new Request(new URL(path,'https://calendar.example.org'),{method}),respondWith});expect(respondWith).not.toHaveBeenCalled();}let response;w.handlers.get('fetch')({request:new Request('https://calendar.example.org/assets/app-synthetic.js'),respondWith:value=>{response=value;}});expect(await (await response).text()).toBe('cached shell');expect(w.cache.put).not.toHaveBeenCalled();});
  it('opens the installed navigation shell immediately even when the network never responds', async () => {
    const root = await fixture();
    await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8'));
    w.fetcher.mockImplementation(() => new Promise(() => {}));
    for (const path of ['/', '/index.html']) {
      let response;
      w.handlers.get('fetch')({
        request: { url: `https://calendar.example.org${path}`, method: 'GET', mode: 'navigate' },
        respondWith: value => { response = value; },
      });
      expect(await (await response).text()).toBe('cached shell');
    }
    expect(w.fetcher).not.toHaveBeenCalled();
    expect(w.cache.match).toHaveBeenCalledWith('/index.html');
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it('uses the network only when the installed navigation shell is missing and never caches that response', async () => {
    const root = await fixture();
    await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8'));
    w.cache.match.mockResolvedValue(undefined);
    let response;
    w.handlers.get('fetch')({
      request: { url: 'https://calendar.example.org/', method: 'GET', mode: 'navigate' },
      respondWith: value => { response = value; },
    });
    expect(await (await response).text()).toBe('<html>synthetic shell</html>');
    expect(w.fetcher).toHaveBeenCalledTimes(1);
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(['failure', 'redirect', 'offline', 'mixed-version'])('offers a safe recovery page instead of a %s response for a missing navigation shell', async failure => {
    const root = await fixture();
    await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8'));
    w.cache.match.mockResolvedValue(undefined);
    if (failure === 'offline') w.fetcher.mockRejectedValue(new Error('offline'));
    else if (failure === 'mixed-version') w.fetcher.mockResolvedValue(new Response('<html>wrong version</html>'));
    else w.fetcher.mockResolvedValue({ ok: failure !== 'failure', redirected: failure === 'redirect' });
    let response;
    w.handlers.get('fetch')({
      request: { url: 'https://calendar.example.org/', method: 'GET', mode: 'navigate' },
      respondWith: value => { response = value; },
    });
    const result = await response;
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store');
    const text = await result.text(); expect(text).toContain('/?recovery=shell'); expect(text).toContain('UC-SHELL-01'); expect(text).not.toContain('wrong version');
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it('rejects a runtime missing script response that does not match the build hash', async () => {
    const root = await fixture(); await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8'));
    w.cache.match.mockResolvedValue(undefined); w.fetcher.mockResolvedValue(new Response('unexpected script'));
    let response; w.handlers.get('fetch')({ request: new Request('https://calendar.example.org/assets/app-synthetic.js'), respondWith: value => { response = value; } });
    expect((await response).type).toBe('error'); expect(w.cache.put).not.toHaveBeenCalled();
  });
  it('activates the new build without retaining an old shell cache or deleting other application caches', async () => {
    const root = await fixture();
    const shell = await writePwaShell(root);
    const w = worker(await readFile(join(root, 'sw.js'), 'utf8'));
    const current = `ultimate-calendar-shell-${shell.version}`;
    w.store.keys.mockResolvedValue(['ultimate-calendar-shell-old', current, 'unrelated-application']);
    let work;
    w.handlers.get('activate')({ waitUntil: value => { work = value; } });
    await work;
    expect(w.store.delete).toHaveBeenCalledExactlyOnceWith('ultimate-calendar-shell-old');
    expect(w.clients.claim).toHaveBeenCalledOnce();
  });
  it('hides details by default and permits notification navigation only to the same origin',async()=>{const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');const w=worker(source);let work;w.handlers.get('push')({data:{json:()=>({title:'Private title',body:'Private text',url:'https://evil.example/'})},waitUntil:value=>{work=value;}});await work;expect(w.showNotification).toHaveBeenCalledWith('终极日历',expect.objectContaining({body:'有一项安排需要查看',data:{path:'/'}}));w.handlers.get('push')({data:{json:()=>({showDetails:true,title:'Allowed title',body:'Allowed details',url:'/index.html'})},waitUntil:value=>{work=value;}});await work;expect(w.showNotification).toHaveBeenLastCalledWith('Allowed title',expect.objectContaining({body:'Allowed details'}));w.handlers.get('notificationclick')({notification:{close:vi.fn(),data:{path:'//evil.example/steal'}},waitUntil:value=>{work=value;}});await work;expect(w.navigate).toHaveBeenCalledWith('https://calendar.example.org/');expect(w.clients.openWindow).not.toHaveBeenCalled();});
});
