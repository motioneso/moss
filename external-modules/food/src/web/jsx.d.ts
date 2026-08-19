// external-modules/food/src/web/jsx.d.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): self-contained JSX namespace for
// the classic jsxFactory transform. Vendored verbatim from
// external-modules/finance/src/web/jsx.d.ts — @types/react is not resolvable
// from this package (external modules are outside the pnpm workspace), so
// intrinsic props are loosely typed; correctness is covered by unit tests and
// UAT.
declare namespace JSX {
  type Element = unknown;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicElements {
    [tagName: string]: Record<string, unknown>;
  }
}
