// Cross-origin-isolation service worker for GitHub Pages, which cannot set response headers.
// It re-serves every same-scope response with the COOP/COEP headers SharedArrayBuffer requires;
// the page registers it and reloads once (see main.ts), after which crossOriginIsolated === true
// and the ecsia worker pool can share component columns by reference. Without service-worker
// support the page still runs — single-threaded, with the threading badge saying why.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Resource-Policy', 'same-origin')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }),
  )
})
