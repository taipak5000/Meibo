/* 名簿 — Service Worker
   方式: stale-while-revalidate
   キャッシュがあれば即返し、裏でネットワークから最新を取ってキャッシュを更新する。
   キャッシュが無い初回だけネットワーク完了を待つ。 */
const CACHE_NAME = 'meibo-v1';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 同一オリジンのみ対象

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    const revalidate = (async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        // オフライン等はキャッシュへフォールバック。ページ遷移なら index.html を返す
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }
    })();
    if (cached) {
      event.waitUntil(revalidate); // 裏側の更新はレスポンスを待たせず継続させる
      return cached;
    }
    return revalidate; // キャッシュが無い初回はネットワークの完了を待つ
  })());
});
