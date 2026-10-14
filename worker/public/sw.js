/* SCTracker service worker — PWA offline shell + runtime caching. */
const VERSION = 'fjsc-v2';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

// アプリシェル(オフラインでも骨格が出る最小セット)。データAPIは含めない。
const SHELL_URLS = [
  '/',
  '/monitor',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // データ系(/ui/* /api/* /img/*)は常にネットワーク優先(古いデータを掴まない)。
  // オフライン時のみキャッシュにフォールバック。
  if (url.pathname.startsWith('/ui/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (url.pathname.startsWith('/img/') && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 静的アセット/フォント: キャッシュ優先。
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
    return;
  }

  // ナビゲーション/HTML: ネットワーク優先、失敗時キャッシュ。
  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('/')))
  );
});
