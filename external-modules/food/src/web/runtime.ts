// external-modules/food/src/web/runtime.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): typed accessors over the frozen
// host runtime global. Vendored verbatim from
// external-modules/finance/src/web/runtime.ts (itself ported from
// job-search) rather than imported — modules may depend only on
// @moss/module-sdk, @moss/module-web-sdk, @moss/host-fetch (never each
// other's internals), and the bundle must never carry its own React
// (bundle-hygiene test). Everything here delegates to the host instance,
// captured at module scope: the host installs the global at app boot before
// any bundle import, so a missing global means a broken host and the
// loader's dynamic import fails closed to Missing.
export type ReactNodeLike = unknown;

type Dispatch<S> = (next: S | ((prev: S) => S)) => void;

export type HostReact = {
  createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ReactNodeLike;
  Fragment: unknown;
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
    throw new Error("food web root requires the Moss module runtime v2");
  }
  return runtime;
}

export const react: HostReact = readRuntime().react;

// jsxFactory/jsxFragment targets — every .tsx file imports { h, Fragment }.
export const h: HostReact["createElement"] = (type, props, ...children) =>
  react.createElement(type, props, ...children);
export const Fragment: unknown = react.Fragment;

export const useState = react.useState;
export const useEffect = react.useEffect;
export const useMemo = react.useMemo;
export const useCallback = react.useCallback;
export const useRef = react.useRef;
export const useSyncExternalStore = react.useSyncExternalStore;
