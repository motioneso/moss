/**
 * Registered in dev too (#743 / #2227), not just production: web push needs a live
 * service worker to receive `push`/`notificationclick` events, and there is no other way
 * to exercise it on a dev instance. The `?dev=1` query string is the service worker's own
 * signal (it has no other way to know) to skip app-shell caching, which would otherwise
 * fight Vite's dev-server asset serving.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  const scriptUrl = import.meta.env.PROD ? "/service-worker.js" : "/service-worker.js?dev=1";

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(scriptUrl);
  });
}
