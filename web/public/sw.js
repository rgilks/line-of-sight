// Minimal service worker: enough for installability and a fast app-shell, but
// deliberately NOT caching the live multiplayer API or map images (those must
// always hit the network — a stale board or fog would be wrong). Network-first
// for navigations, cache-first for the static app shell.
const SHELL = 'los-shell-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(SHELL))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
      await self.clients.claim()
    })()
  )
})

const isApi = (url) => url.pathname.startsWith('/api/')

self.addEventListener('fetch', (event) => {
  const {request} = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never intercept the live game API — always go to network.
  if (isApi(url)) return

  // App shell (navigations + static assets): try network, fall back to cache,
  // and keep the cache fresh for offline launch.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request)
        if (response.ok && (request.mode === 'navigate' || url.pathname.startsWith('/assets/'))) {
          const cache = await caches.open(SHELL)
          cache.put(request, response.clone())
        }
        return response
      } catch {
        const cached = await caches.match(request)
        if (cached) return cached
        if (request.mode === 'navigate') {
          const fallback = await caches.match('/')
          if (fallback) return fallback
        }
        throw new Error('offline and not cached')
      }
    })()
  )
})
