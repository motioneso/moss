// apps/api/src/e2e-fetch-override.ts
//
// TEST-ONLY API-side copy of the worker e2e fixture seam
// (`resolveE2eFetchOverride`/`createE2eFixtureFetch` in
// apps/worker/src/external-module-job-handler.ts). Same contract: active only when
// JARVIS_RUNTIME_MODE is "e2e" with JARVIS_E2E_MODULE_FETCH_BASE set, throws the
// worker's message when the base is set without e2e mode, keeps pathname + search,
// passes init through, and enforces the briefing sources' manifest hosts BEFORE
// rewriting the origin onto the fixture base.
//
// A copy, not a shared move: the worker file is outside every current task record,
// so moving it would reopen worker files. It imports only `@moss/db` and
// `@moss/module-registry`, both already API dependencies, so no package moves.
// The entry block spreads the result (`...resolveApiE2eFetchOverride()`) so a stray
// `fetchFn: undefined` can never slip past a `??` downstream undetected.
//
// One deliberate divergence from the worker: hosts outside the briefing list PASS
// THROUGH to global fetch instead of throwing. The API entry's fetchFn fans out
// through shared registry plumbing (S6 forbids touching it) to every built-in
// client, so throwing would 500 unrelated modules (verified live: weather).
// Pass-through keeps every non-seam request byte-identical to prod; the dataset
// runtime's own host pinning still constrains clients that pin, and only briefing
// hosts are ever rewritten.
import { resolveMossEnv } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";

const E2E_MODE_ERROR =
  'JARVIS_E2E_MODULE_FETCH_BASE is set but JARVIS_RUNTIME_MODE is not "e2e". ' +
  "This variable enables a host-fetch bypass and must never be set outside the UAT harness.";

/** Manifest-declared fetch hosts of the News and Sports briefing sources. */
export function briefingFixtureHosts(): readonly string[] {
  const hosts = new Set<string>();
  for (const manifest of getBuiltInModuleManifests()) {
    if (manifest.id !== "sports" && manifest.id !== "news") continue;
    for (const source of manifest.externalSources ?? []) {
      for (const host of source.fetchHosts) hosts.add(host);
    }
  }
  return [...hosts].sort();
}

/**
 * Host-scoped fixture fetch: answers requests to `allowedHosts` from `base`;
 * anything else passes through to global fetch unchanged (see above).
 */
export function createApiE2eFixtureFetch(
  base: string,
  allowedHosts: readonly string[] = briefingFixtureHosts()
): typeof fetch {
  const baseUrl = new URL(base);
  const allowed = new Set(allowedHosts);
  return (async (input, init) => {
    const requestedUrl = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    if (!allowed.has(requestedUrl.hostname)) {
      return fetch(input, init);
    }
    const rewritten = new URL(`${requestedUrl.pathname}${requestedUrl.search}`, baseUrl);
    return fetch(rewritten, init);
  }) as typeof fetch;
}

export function resolveApiE2eFetchOverride(env: NodeJS.ProcessEnv = process.env): {
  readonly fetchFn?: typeof fetch;
} {
  const e2eMode = resolveMossEnv(env, "JARVIS_RUNTIME_MODE") === "e2e";
  const fixtureBase = resolveMossEnv(env, "JARVIS_E2E_MODULE_FETCH_BASE");

  if (fixtureBase && !e2eMode) {
    throw new Error(E2E_MODE_ERROR);
  }

  if (!e2eMode || !fixtureBase) {
    return {};
  }

  return { fetchFn: createApiE2eFixtureFetch(fixtureBase) };
}
