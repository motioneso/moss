// 2026-08-27: bump script bytes so existing clients reload the worker after CSP changes.
const CACHE_NAME = "jarv1s-shell-v1";
const APP_SHELL_URLS = ["/", "/offline.html", "/manifest.webmanifest", "/icons/icon.svg"];
const IMAGE_RETRY_DELAYS_MS = [250, 1000];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Uncached-fetch rejections (e.g. a transient CDN blip) must never reach respondWith() as a
// rejected promise, or the browser treats the whole SW-intercepted request as a hard failure
// instead of an ordinary failed subresource. Images get bounded retries so a transient blip
// recovers without a page reload; everything else resolves to Response.error() immediately.
async function fetchWithRecovery(request) {
  const delays = request.destination === "image" ? IMAGE_RETRY_DELAYS_MS : [];
  let attempt = 0;
  for (;;) {
    try {
      return await fetch(request);
    } catch {
      if (attempt >= delays.length) {
        return Response.error();
      }
      await wait(delays[attempt]);
      attempt += 1;
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        // Explicit Accept: text/html for clarity of intent; the server's SPA
        // fallback also serves "/" without one (see #1487).
        const shellResponse = await fetch("/", { headers: { Accept: "text/html" } });
        if (!shellResponse.ok) {
          throw new Error(`Failed to fetch app shell: ${shellResponse.status}`);
        }
        await cache.put("/", shellResponse);
        await cache.addAll(APP_SHELL_URLS.filter((url) => url !== "/"));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (request.method === "GET") {
    // The cache lookup itself can reject (storage full/corrupted, restricted private-browsing
    // mode) — that must fall through to the network like a cache miss, not reject respondWith().
    event.respondWith(
      caches
        .match(request)
        .then((cached) => cached ?? fetchWithRecovery(request))
        .catch(() => fetchWithRecovery(request))
    );
  }
});
