/* Build rewrites these two constants with a hash and an exact static-shell allowlist. */
const BUILD_VERSION = '__UC_BUILD_VERSION__';
const STATIC_ASSETS = /* __UC_STATIC_ASSETS__ */ [];
const CACHE_PREFIX = 'ultimate-calendar-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD_VERSION;
const allowed = new Set(STATIC_ASSETS);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (!STATIC_ASSETS.length) return;
    const cache = await caches.open(CACHE_NAME);
    for (const path of STATIC_ASSETS) {
      const response = await fetch(new Request(path, { cache: 'reload', credentials: 'omit' }));
      if (!response.ok || response.redirected) throw new Error('Static shell could not be cached');
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
      try {
        const response = await fetch(request);
        if (response.ok && !response.redirected) return response;
        throw Error('Shell navigation failed');
      } catch {
        const cached = await cache.match('/index.html');
        return cached || Response.error();
      }
    }
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    // Never add runtime responses: only build-time immutable assets belong in this cache.
    return fetch(request);
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
