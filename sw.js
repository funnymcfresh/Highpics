/* HighPic Service Worker
   Lässt HighPic auch ohne Internet starten. Lege diese Datei in denselben Ordner wie index.html.
   Strategie: Beim Start wird zuerst das Netz gefragt (max. 3,5 s), damit Updates sofort ankommen.
   Ohne Netz kommt die zuletzt gespeicherte Version aus dem Cache. */
const CACHE = 'highpic-v1';
const SHELL = ['./', './index.html'];
const TIMEOUT_MS = 3500;

const isHtml = res => !!res && res.ok && (res.headers.get('content-type') || '').indexOf('text/html') !== -1;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = new Set(SHELL.map(u => new URL(u, self.location.href).href));
    // Also cache the page that registered this worker, whatever its file name is
    try {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      wins.forEach(w => {
        const u = new URL(w.url);
        u.hash = '';
        if (u.origin === self.location.origin) urls.add(u.href);
      });
    } catch (e) { /* clients API unavailable: shell URLs are enough */ }
    await Promise.all([...urls].map(async u => {
      try {
        const res = await fetch(u, { cache: 'reload' });
        if (isHtml(res)) await cache.put(u, res);
      } catch (e) { /* offline or missing file: skip */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.indexOf('highpic-') === 0 && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cachedPage(request) {
  const cache = await caches.open(CACHE);
  const hit = (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match(new URL('./index.html', self.location.href).href))
    || (await cache.match(new URL('./', self.location.href).href));
  if (hit) return hit;
  for (const key of await cache.keys()) {
    const res = await cache.match(key);
    if (isHtml(res)) return res;
  }
  return null;
}

function offlinePage() {
  const html = '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>HighPic</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0A0D13;color:#ECF0F7;font:16px -apple-system,system-ui,sans-serif;text-align:center;padding:24px">'
    + '<div><h1 style="font-size:22px">Gerade offline</h1><p style="color:#8F98AB">Öffne HighPic einmal mit Internet, danach startet die App auch ohne.</p></div></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  const network = fetch(req);
  // Keep the cached copy fresh whenever the network answers (also after a timeout)
  const saved = network.then(res => {
    if (!isHtml(res)) return;
    const copy = res.clone();
    return caches.open(CACHE).then(c => c.put(req.url, copy));
  }).catch(() => {});
  event.waitUntil(saved);

  event.respondWith((async () => {
    try {
      const res = await Promise.race([
        network,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS))
      ]);
      if (res && res.ok) return res;
      const cached = await cachedPage(req);
      return cached || res;
    } catch (e) {
      const cached = await cachedPage(req);
      if (cached) return cached;
      try { return await network; } catch (e2) { return offlinePage(); }
    }
  })());
});
