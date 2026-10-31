// external-modules/meals/src/web/router.ts
//
// The host exposes no router on the runtime global, so the page owns a small pushState router
// under /m/meals. The host's /m/:moduleId/* route matches every inner path.
import { useSyncExternalStore } from "@moss/module-web-sdk";

export const MODULE_BASE = "/m/meals";

export function parseModulePath(pathname: string): string {
  if (pathname !== MODULE_BASE && !pathname.startsWith(`${MODULE_BASE}/`)) return "/";
  const rest = pathname.slice(MODULE_BASE.length).replace(/\/+$/, "");
  return rest === "" ? "/" : rest;
}

const listeners = new Set<() => void>();

export function navigate(to: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", `${MODULE_BASE}${to === "/" ? "" : to}`);
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (typeof window !== "undefined") window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("popstate", onChange);
  };
}

function currentPath(): string {
  return typeof window === "undefined" ? "/" : parseModulePath(window.location.pathname);
}

export function useModulePath(): string {
  return useSyncExternalStore(subscribe, currentPath, currentPath);
}
