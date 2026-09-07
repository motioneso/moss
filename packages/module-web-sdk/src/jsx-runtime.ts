// packages/module-web-sdk/src/jsx-runtime.ts
import type { ReactNode } from "react";

import { Fragment, h } from "./runtime.js";

// esbuild `alias` target for the "react/jsx-runtime" specifier
// (scripts/build-external-module.ts) — the automatic JSX runtime a COMPILED dependency uses.
// The web build forces the classic transform for sources it compiles itself (tsconfigRaw), but
// that cannot rewrite an already-compiled file: react-markdown's lib/index.js imports
// "react/jsx-runtime" directly, and without this entry the bare-"react" prefix alias maps it to
// the nonsense path "runtime.ts/jsx-runtime" and the module build fails. Like runtime.ts, every
// export below delegates to the host instance captured on window.__JARVIS_MODULE_RUNTIME__ at
// call time — the bundle never carries its own React copy.
export type ReactNodeLike = ReactNode;

export function jsx(
  type: unknown,
  config: Record<string, unknown> | null,
  maybeKey?: unknown
): ReactNodeLike {
  const { children, ...rest } = config ?? {};
  const props =
    maybeKey === undefined ? rest : { ...rest, key: maybeKey as string | number | null };
  const kids =
    Array.isArray(children) || children === undefined
      ? ((children ?? []) as readonly unknown[])
      : [children];
  return h(type, props, ...kids);
}

export const jsxs = jsx;

export { Fragment };
