// Register the app's service worker (web/public/sw.js) so a route is an
// installable PWA that loads — and, for the solo game, fully plays — offline
// after a first online visit. The worker precaches the app shell plus the lazy
// 3D-dice chunk and never caches the live game API. Registration is a
// progressive enhancement: failures are swallowed, and it is safe to call from
// every entry point (the browser dedupes the same scope).
export const registerServiceWorker = (): void => {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW is a progressive enhancement; ignore registration failures */
    })
  })
}
