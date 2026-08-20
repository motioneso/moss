// external-modules/finance/src/web/router.ts
// FIN-03 (#1148) Task 4: the job-search in-module router idiom, ported
// verbatim (external-modules/job-search/src/web/router.ts). The host exposes
// no react-router on the runtime global, so the Root owns a minimal pushState
// router under the fixed /m/finance base; the host's /m/:moduleId/* route
// keeps matching every internal path and re-renders on popstate.
import { h, useCallback, useSyncExternalStore, type ReactNodeLike } from "@moss/module-web-sdk";

export const MODULE_BASE = "/m/finance";

export function parseModulePath(pathname: string): string {
  if (pathname !== MODULE_BASE && !pathname.startsWith(`${MODULE_BASE}/`)) return "/";
  const rest = pathname.slice(MODULE_BASE.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function navigate(to: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", `${MODULE_BASE}${to === "/" ? "" : to}`);
  notify();
}

function subscribeToPath(onChange: () => void): () => void {
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
  return useSyncExternalStore(subscribeToPath, currentPath, currentPath);
}

export type ModuleLinkButtonVariant = "primary" | "secondary" | "quiet" | "accentSoft" | "danger";
export type ModuleLinkButtonSize = "sm" | "md" | "lg";

export function ModuleLink(props: {
  to: string;
  // Button-styled nav link: builds its own jds-btn class string, mirroring
  // @moss/ui's Button/ButtonLink, since neither can be this — Button never
  // renders <a>, and ButtonLink has no pushState routing of its own.
  variant?: ModuleLinkButtonVariant;
  size?: ModuleLinkButtonSize;
  "aria-current"?: string;
  children?: unknown;
  // Accepted at the call site for list rendering; host React extracts it at
  // createElement time, so the component body never sees it.
  key?: string;
}): ReactNodeLike {
  const { to, children, variant, size = "md", ...rest } = props;
  const onClick = useCallback(
    (event: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean }) => {
      // Let modifier-clicks open a real tab; plain clicks stay in-app.
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      navigate(to);
    },
    [to]
  );
  const className = variant
    ? ["jds-btn", `jds-btn--${variant}`, size !== "md" ? `jds-btn--${size}` : null]
        .filter(Boolean)
        .join(" ")
    : undefined;
  return h(
    "a",
    { href: `${MODULE_BASE}${to === "/" ? "" : to}`, onClick, className, ...rest },
    children
  );
}
