// Hand-written types for allow-read-only.mjs. The hook is plain Node with no build step, and this
// repo enables neither allowJs nor checkJs, so the unit test cannot import it without this file.

export type ReadOnlyVerdict =
  | { readonly decision: "allow"; readonly rule: "read-only" }
  | { readonly decision: "none"; readonly rule: string };

export function decideReadOnly(command: string, cwd?: string): ReadOnlyVerdict;
