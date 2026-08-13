const CACHE_NAME = "jarv1s-shell-v1";
const APP_SHELL_URLS = ["/", "/offline.html", "/manifest.webmanifest", "/icons/icon.svg"];

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
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});
