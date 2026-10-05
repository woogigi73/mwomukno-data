/* 뭐 먹노? 오프라인·빠른 실행용 서비스 워커. 같은 사이트 파일만 다룬다. */
const SHELL = 'mm-shell-v3';
const DATA = 'mm-data-v1';
const SHELL_FILES = ['./', 'index.html', 'app.css?v=3', 'fx.js?v=3', 'app.js?v=3', 'manifest.webmanifest', 'icons/icon-192.png', 'privacy.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimData(cache) {
  const keys = await cache.keys();
  const regions = keys.filter((r) => r.url.includes('/v1/r/'));
  for (const old of regions.slice(0, Math.max(0, regions.length - 40))) await cache.delete(old);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/v1/r/')) {
    // 지역 파일: 주소에 버전이 붙어 있어 저장본을 먼저 쓴다.
    e.respondWith(caches.open(DATA).then(async (c) => {
      if (req.cache !== 'reload') {
        const hit = await c.match(req);
        if (hit) return hit;
      }
      const res = await fetch(req);
      if (res.ok) { await c.put(req, res.clone()); trimData(c); }
      return res;
    }));
    return;
  }
  // 나머지(화면 파일, 목록): 인터넷 먼저, 안 되면 저장본
  const bucket = url.pathname.endsWith('manifest.json') ? DATA : SHELL;
  e.respondWith(fetch(req).then(async (res) => {
    if (res.ok) { const c = await caches.open(bucket); c.put(req, res.clone()); }
    return res;
  }).catch(async () => (await caches.match(req)) || (await caches.match('index.html')) || Response.error()));
});
