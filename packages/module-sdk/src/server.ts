// #1120: server-only subpath. `sessionRateLimitKey` / `mcpSessionRateLimitKey` (rate-limit-key.ts)
// import `node:crypto`, so they must never be reachable from the top-level barrel (index.ts) — a
// value re-export from the barrel pulls node:crypto into any Vite-bundled consumer (apps/web),
// which is exactly what happened in #1110 for a different symbol. Fastify route handlers import
// these from `@moss/module-sdk/server` instead of the bare `@moss/module-sdk` specifier.
export { sessionRateLimitKey, mcpSessionRateLimitKey } from "./rate-limit-key.js";
