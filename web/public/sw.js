// Service worker for installability AND a fully offline solo game. It precaches
// the solo + controller app shell plus the lazy 3D-dice chunk (so the first
// OFFLINE attack can still load the roller) from a build-generated manifest, then
// serves network-first with a cache fallback. It deliberately never caches the
// live multiplayer API or map images — a stale board or fog would be wrong, and a
// cached SSE stream would be catastrophic.
const SHELL = 'los-shell-v3'

// Precache the offline shell from the build-generated list (hashed asset names,
// the lazy three.js dice chunk, /gltf/dice.*, and the /solo + /controller
// navigations). Best-effort and resilient: a missing entry or an offline install
// never rejects — runtime caching still fills the shell on first online use.
const precache = async () => {
  const cache = await caches.open(SHELL)
  try {
    const res = await fetch('/precache.json', {cache: 'no-cache'})
    if (!res.ok) return
    const urls = await res.json()
    await Promise.all(urls.map((u) => cache.add(new Request(u, {cache: 'reload'})).catch(() => {})))
  } catch {
    /* offline at install (or no manifest yet) — runtime caching covers it */
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache())
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
const isRuntimeStatic = (url) =>
  url.pathname.startsWith('/assets/') ||
  url.pathname.startsWith('/gltf/') ||
  url.pathname.startsWith('/icons/') ||
  url.pathname.startsWith('/token-portraits/') ||
  url.pathname === '/favicon.svg' ||
  url.pathname === '/favicon.ico' ||
  url.pathname === '/manifest.webmanifest'

const navigationFallback = async (url) => {
  const exact = await caches.match(new Request(`${url.origin}${url.pathname}`))
  if (exact) return exact
  if (url.pathname.startsWith('/solo')) return caches.match('/solo')
  if (url.pathname.startsWith('/controller')) return caches.match('/controller')
  return caches.match('/')
}

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
        if (response.ok && (request.mode === 'navigate' || isRuntimeStatic(url))) {
          const cache = await caches.open(SHELL)
          cache.put(request, response.clone())
        }
        return response
      } catch {
        const cached = await caches.match(request)
        if (cached) return cached
        if (request.mode === 'navigate') {
          const fallback = await navigationFallback(url)
          if (fallback) return fallback
        }
        throw new Error('offline and not cached')
      }
    })()
  )
})
