/* Build binds the worker, document and exact static-shell resources to one version. */
const BUILD_VERSION = '__UC_BUILD_VERSION__';
const STATIC_ASSETS = /* __UC_STATIC_ASSETS__ */ [];
const STATIC_INTEGRITY = /* __UC_STATIC_INTEGRITY__ */ {};
const CACHE_PREFIX = 'ultimate-calendar-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD_VERSION;
const allowed = new Set(STATIC_ASSETS);

async function verifiedFetch(path, request) {
  const expected = STATIC_INTEGRITY[path];
  if (!allowed.has(path) || !expected) throw new Error('Unknown static resource');
  const response = await fetch(request, { credentials: 'omit', redirect: 'error' });
  if (!response.ok || response.redirected) throw new Error('Static shell could not be fetched');
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Static shell version changed during download');
  return response;
}

function recoveryPage() {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>终极日历</title><body style="margin:0;padding:48px 24px;background:#f5f0e6;color:#292620;font:17px system-ui;line-height:1.7"><main><h1 style="font-size:24px">日历页面需要重新载入</h1><p>当前页面文件暂时不完整，请联网后重新打开。</p><p><a href="/?recovery=shell" style="color:#a63b25">重新载入日历</a></p><p>不会清除配对、日历或待提交修改。</p><small>UC-SHELL-01</small></main></body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" } });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (!STATIC_ASSETS.length) return;
    const cache = await caches.open(CACHE_NAME);
    for (const path of STATIC_ASSETS) {
      const response = await verifiedFetch(path, new Request(new URL(path, self.location.origin), { cache: 'reload', credentials: 'omit' }));
      await cache.put(path, response);
    }
    // Existing tabs retain their worker until closed; do not silently swap a live application shell.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // No API, pairing, authorization, credentials, query strings or arbitrary navigations enter CacheStorage.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || /^\/(?:api|auth|pair|logout)(?:\/|$)/.test(url.pathname) || !allowed.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (request.mode === 'navigate') {
      // Keep the document and its fingerprinted assets on the same installed build.
      // Startup registers /sw.js again to check for updates without blocking this shell.
      const cached = await cache.match('/index.html');
      if (cached) return cached;
      try {
        return await verifiedFetch(url.pathname, request);
      } catch {
        return recoveryPage();
      }
    }
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    // Never add runtime responses: only build-time immutable assets belong in this cache.
    try { return await verifiedFetch(url.pathname, request); }
    catch { return Response.error(); }
  })());
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { /* Show a generic reminder for malformed data. */ }
    if (!payload || typeof payload !== 'object') payload = {};
    if (typeof payload.expiresAt === 'string' && Date.parse(payload.expiresAt) <= Date.now()) return;
    const details = payload.showDetails === true;
    const title = details && typeof payload.title === 'string' ? payload.title.slice(0, 200) : '终极日历';
    const body = details && typeof payload.body === 'string' ? payload.body.slice(0, 500) : '有一项安排需要查看';
    let path = '/';
    try { const url = new URL(payload.url, self.location.origin); if (typeof payload.url === 'string' && /^\/(?!\/)/.test(payload.url) && url.origin === self.location.origin && !/^\/(?:api|auth)(?:\/|$)/.test(url.pathname)) path = url.pathname + url.search; } catch { /* Retain the safe root URL. */ }
    await self.registration.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 160) : 'ultimate-calendar-reminder', data: { path } });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL('/', self.location.origin);
    try { const path=event.notification.data?.path; const value=new URL(path,self.location.origin); if(typeof path==='string' && /^\/(?!\/)/.test(path) && value.origin===self.location.origin && !/^\/(?:api|auth)(?:\/|$)/.test(value.pathname)) target=value; } catch { /* Retain safe same-origin root. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (new URL(client.url).origin === target.origin) { if ('navigate' in client) await client.navigate(target.href); await client.focus(); return; }
    await self.clients.openWindow(target.href);
  })());
});
