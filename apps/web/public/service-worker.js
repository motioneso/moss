const CACHE_NAME = "jarv1s-shell-v1";
const APP_SHELL_URLS = ["/", "/offline.html", "/manifest.webmanifest", "/icons/icon.svg"];
const IMAGE_RETRY_DELAYS_MS = [250, 1000];
// register-service-worker.ts registers this script as "/service-worker.js?dev=1" outside
// production so push notifications can be exercised on a dev instance — the query string
// is the only signal a service worker script has about how it was registered. Dev mode must
// never cache the app shell: that would fight Vite's own dev-server asset serving.
const IS_DEV = Boolean(self.location && /(?:\?|&)dev=1(?:&|$)/.test(self.location.search || ""));

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
  if (IS_DEV) {
    event.waitUntil(self.skipWaiting());
    return;
  }

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
  if (IS_DEV) {
    return;
  }

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

// #743 / #2227: web push delivery. The payload is the small JSON shape built by
// buildPushPayload (packages/notifications/src/push-payload.ts) — title, body and an
// optional href, nothing else (payload-boundary decision: no metadata, no secrets ever
// reach the browser's push service).
self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon.svg",
      data: { href: payload.href ?? null }
    })
  );
});

// #743 security finding 4: a click only ever opens a page on this app's own origin. The
// server already refuses foreign links, but the payload crosses a third-party push service,
// so the browser side checks again: anything that parses to another origin (an absolute
// URL, "//host", "/\\host", or a value that does not parse) opens the app's home page.
function resolveClickTarget(href) {
  const home = new URL("/", self.location.origin).href;
  if (typeof href !== "string" || href.length === 0) {
    return home;
  }
  let target;
  try {
    target = new URL(href, self.location.origin);
  } catch {
    return home;
  }
  return target.origin === self.location.origin ? target.href : home;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = resolveClickTarget(event.notification.data?.href);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url === targetUrl);
      if (existing) {
        return existing.focus();
      }

      const anyWindow = clients[0];
      if (anyWindow) {
        return anyWindow.focus().then(() => anyWindow.navigate(targetUrl));
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
