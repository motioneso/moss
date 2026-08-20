// #1110 regression fix: split out of index.ts so @moss/shared can import MossError /
// MossErrorClass via the ./errors subpath instead of the bare barrel specifier. The barrel's
// module-web-browser-safety walker (tests/unit/module-web-browser-safety.test.ts) resolves bare
// `@moss/*` specifiers to the package's whole `exports["."]` entry, so any type-only
// `export type {...} from "@moss/module-sdk"` reachable from a module's `./web` bundle drags in
// the barrel's logger.js/route-errors.js re-exports (fastify) too — sessionRateLimitKey /
// mcpSessionRateLimitKey (node:crypto) moved off the barrel entirely in #1120, but the barrel
// still isn't a browser-safe entry point on its own merits (fastify types, etc).
// A subpath specifier like `@moss/module-sdk/errors` isn't resolvable by that walker and stays
// invisible to it, matching the existing ai-capabilities.ts leaf pattern. This leaf must stay free
// of node:* and backend-only imports.
export type MossErrorClass = "prerequisite" | "transient" | "validation" | "permission" | "bug";

export interface MossError {
  readonly code: string;
  readonly class: MossErrorClass;
  readonly remediationRef?: string;
}
