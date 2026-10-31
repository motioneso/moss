// Self-contained JSX namespace. @types/react is not resolvable from external modules, so
// intrinsic props are loosely typed; unit tests cover correctness.
declare namespace JSX {
  type Element = unknown;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicElements {
    [tagName: string]: Record<string, unknown>;
  }
}
