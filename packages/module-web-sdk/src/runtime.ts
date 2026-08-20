// packages/module-web-sdk/src/runtime.ts
import type { ReactNode } from "react";

// #1388 Foundation: the browser-side React shim every external module's web bundle resolves
// "react" to (scripts/build-external-module.ts `alias`) and gets injected with for its JSX
// pragma (`inject`, satisfying esbuild's jsxFactory:"h"/jsxFragment:"Fragment") — the same
// recipe finance/job-search's own hand-rolled src/web/runtime.ts already used (FIN-02/#1147),
// generalized here so a @moss/ui-consuming module doesn't have to duplicate it, and widened
// to the full react namespace so components that need forwardRef/memo (lucide-react icons, used
// by @moss/ui's chip/select) resolve correctly. The bundle must never carry its own React copy
// (bundle-hygiene test): every export below delegates to the host instance captured on
// window.__JARVIS_MODULE_RUNTIME__ at module-eval time — safe because the host installs that
// global at boot, before any module bundle is dynamically imported.
//
// ReactNodeLike used to be `unknown` (a module never imports real React, so it had no type to
// borrow). #1418: a module that renders @moss/ui components needs its own JSX expressions to be
// assignable to @moss/ui's props, which are typed with real React's ReactNode — `unknown` can
// never satisfy that. Widened to a type-only alias for React's ReactNode instead: no runtime
// cost (erased at compile time, same as index.ts's own `import type { ReactNode } from "react"`)
// and no real React added to a module's bundle — only the type checker resolves "react" here,
// the actual JSX still goes through this file's h()/createElement() shim at runtime.
export type ReactNodeLike = ReactNode;

type Dispatch<S> = (next: S | ((prev: S) => S)) => void;

export type HostReact = {
  createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ReactNodeLike;
  Fragment: unknown;
  forwardRef: (render: (props: unknown, ref: unknown) => ReactNodeLike) => unknown;
  memo: (component: unknown) => unknown;
  createContext: (defaultValue: unknown) => unknown;
  useContext: <T>(context: unknown) => T;
  useId: () => string;
  useState: <S>(initial: S | (() => S)) => [S, Dispatch<S>];
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useMemo: <T>(factory: () => T, deps: readonly unknown[]) => T;
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) => T;
  useRef: <T>(initial: T) => { current: T };
  useSyncExternalStore: <T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T
  ) => T;
};

type ModuleRuntime = { contractVersion: number; react: HostReact };

function readRuntime(): ModuleRuntime {
  const runtime = (globalThis as { __JARVIS_MODULE_RUNTIME__?: ModuleRuntime })
    .__JARVIS_MODULE_RUNTIME__;
  if (!runtime || runtime.contractVersion !== 2) {
    throw new Error("module-web-sdk runtime shim requires the Moss module runtime v2");
  }
  return runtime;
}

// index.ts re-exports this module (`export * from "./runtime.js"`) so h/Fragment are reachable
// via the "@moss/module-web-sdk" barrel too — which means EVERY consumer of the package,
// including ones that only want an unrelated export like requestJson (news-client.ts,
// sports-client.ts), evaluates this module. Resolving the host runtime eagerly at module scope
// (the original shape here) threw for all of them outside a real module runtime. Every export
// below must defer readRuntime() to call/access time instead.
const FRAGMENT_PLACEHOLDER = Symbol("module-web-sdk-fragment-placeholder");

function resolveType(type: unknown): unknown {
  return type === FRAGMENT_PLACEHOLDER ? readRuntime().react.Fragment : type;
}

// jsxFactory/jsxFragment pragma targets (esbuild `inject`, build-external-module.ts) — a
// @moss/ui component's JSX has no explicit h/Fragment import of its own, unlike
// finance/job-search's hand-authored files.
export const h: HostReact["createElement"] = (type, props, ...children) =>
  readRuntime().react.createElement(resolveType(type), props, ...children);
// A stand-in identity, swapped for the real host Fragment marker inside h()/createElement() at
// call time — the real marker is usually a Symbol, which can't be wrapped in a Proxy, so this
// placeholder is the only way to keep the export itself free of an eager readRuntime() call.
export const Fragment: unknown = FRAGMENT_PLACEHOLDER;

// Named to match real react's own exports (esbuild `alias` target for the bare "react"
// specifier) — lucide-react, a runtime dependency of @moss/ui's chip/select icons, imports
// createElement/forwardRef directly rather than writing JSX.
export const createElement: HostReact["createElement"] = h;
export const forwardRef: HostReact["forwardRef"] = (render) =>
  readRuntime().react.forwardRef(render);
export const memo: HostReact["memo"] = (component) => readRuntime().react.memo(component);
export const createContext: HostReact["createContext"] = (defaultValue) =>
  readRuntime().react.createContext(defaultValue);
export const useContext: HostReact["useContext"] = (context) =>
  readRuntime().react.useContext(context);
export const useId: HostReact["useId"] = () => readRuntime().react.useId();
export const useState: HostReact["useState"] = (initial) => readRuntime().react.useState(initial);
export const useEffect: HostReact["useEffect"] = (effect, deps) =>
  readRuntime().react.useEffect(effect, deps);
export const useMemo: HostReact["useMemo"] = (factory, deps) =>
  readRuntime().react.useMemo(factory, deps);
export const useCallback: HostReact["useCallback"] = (fn, deps) =>
  readRuntime().react.useCallback(fn, deps);
export const useRef: HostReact["useRef"] = (initial) => readRuntime().react.useRef(initial);
export const useSyncExternalStore: HostReact["useSyncExternalStore"] = (
  subscribe,
  getSnapshot,
  getServerSnapshot
) => readRuntime().react.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

// Default export (bare "react" alias target) — a Proxy so property access defers to
// readRuntime() per-read instead of resolving the whole HostReact object at module-eval time.
const reactProxy: HostReact = new Proxy({} as HostReact, {
  get(_target, prop) {
    if (prop === "Fragment") return Fragment;
    return readRuntime().react[prop as keyof HostReact];
  }
});

export default reactProxy;
