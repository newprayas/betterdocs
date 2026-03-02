const CACHE_VERSION = 'v2';
const STATIC_CACHE = `meddy-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `meddy-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );

      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(event));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

function isStaticAsset(pathname) {
  if (pathname.startsWith('/_next/static/')) return true;
  return /\.(?:js|css|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2)$/i.test(pathname);
}

async function handleNavigationRequest(event) {
  try {
    const preloadResponse = await event.preloadResponse;
    if (preloadResponse) {
      return preloadResponse;
    }

    const networkResponse = await fetch(event.request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(event.request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_error) {
    const cachedPage = await caches.match(event.request);
    if (cachedPage) return cachedPage;

    const offlinePage = await caches.match('/offline.html');
    return offlinePage || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  return networkResponse || Response.error();
}
