# Plan: #1319 Phase 2 — fetch-time catalog verification (lane 1319-A)

- **Scope:** Phase 2 only, from the approved master plan
  `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md` (Tasks 3-4). Phase 1 (signing
  primitive + signed publish) is already merged to main as PR #1684 —
  `packages/module-registry/src/distribution/catalog-signing.ts` exists and exports everything
  Task 3 needs, including the real pinned production key (`MODULE_CATALOG_PUBLIC_KEYS`, keyId
  `moss-catalog-2026-a`). Do not touch that file's exports.
- **Branch:** `build/1319a-catalog-verify` from `origin/main` (currently `4ee77dbd2`).
- **Out of scope:** pipeline enforcement / 409 / override (Phase 3), ensure-at-boot test (Phase 3
  Task 6), web UI (Phase 3 Task 7), UAT/live-path (Phase 4). No DB migration.

## Verified against current tree this session (line numbers re-checked, not trusted from the

master plan's ledger — some had drifted)

- `packages/module-registry/src/distribution/registry-source.ts`: `REGISTRY_INDEX_MAX_BYTES` :20,
  `resolveRegistryIndexUrl` :22-31, `createRegistryFetch` :40-52, `fetchRegistryIndex` :60-76
  (returns `{index, errors}`, uses `response.text()` at :68 — must become `arrayBuffer()`).
- `apps/api/src/module-distribution-port.ts`: `REGISTRY_CACHE_TTL_MS` :35, `registryCache` :36,
  `fetchRegistryEntries` :39-50 (cache holds `entries` only today — becomes the full snapshot).
- `packages/settings/src/routes-module-registry.ts`: GET route :82-112, early-return construction
  :92-97, main construction :102-107. Both must carry the new envelope fields (ledger item still
  correct: two production call sites, not one).
- `packages/shared/src/platform-api-modules.ts`: `ModuleRegistryRowDto` now at :501-518 (master
  plan cited :415-432 — file grew ~86 lines since; **do not trust that plan's line numbers for this
  file**), `GetModuleRegistryResponse` :520-524, `getModuleRegistryRouteSchema` :585-605 (`required`
  array :595, `properties` :596-600). Row schema/DTO stay untouched (ledger #20 still applies — no
  per-row field).
- `packages/module-registry/src/distribution/catalog-signing.ts` (Phase 1, read-only for this
  lane): `verifyCatalogBytes(bytes, signatureDocument, keys)`, `resolveCatalogTrustedKeys(env)`,
  `MODULE_CATALOG_PUBLIC_KEYS`.

## What ships

### Task A — verify in `fetchRegistryIndex` (registry-source.ts)

Per master plan Task 3 verbatim (types, behavior, and test list already fully specified there —
not repeating the full spec here to keep this doc short; builder implements exactly as written):

- New exports: `REGISTRY_SIGNATURE_MAX_BYTES = 4096`, `CatalogVerification` type,
  `CatalogVerificationFailureReason` type, `FetchRegistryIndexResult` interface,
  `FetchRegistryIndexOptions` gains `trustedKeys?: readonly ModuleCatalogPublicKey[]` (default
  `resolveCatalogTrustedKeys(env)`).
- Switch index fetch to `arrayBuffer()`; digest = SHA-256 hex of those exact bytes.
- Fetch `.sig` via the same `createRegistryFetch` wrapper, capped at
  `REGISTRY_SIGNATURE_MAX_BYTES`; any signature-side failure folds to `"unverified"` with the
  matching `failureReason` — never throws.
- `"verified"` only when signature verifies over the exact index bytes AND the index validates.
- Tests: extend `tests/unit/module-distribution-pipeline.test.ts` (home of `makeFixture`/
  `fakeFetch`) — signed fixture → verified; no `.sig` route → unverified/signature-fetch-failed
  (index still parsed); tampered bytes under stale sig → unverified/signature-mismatch; unknown
  keyId → signature-unknown-key; oversize sig → signature-too-large; non-200 index → unavailable,
  digest null; the three pre-existing `fetchRegistryIndex` cases pass unmodified.
- Verify: `pnpm test:unit tests/unit/module-distribution-pipeline.test.ts` → exit 0;
  `pnpm typecheck` → exit 0.

### Task B — snapshot cache + envelope + route wiring

Per master plan Task 4 verbatim, against the line numbers verified above instead of the master
plan's (stale) citations:

- `apps/api/src/module-distribution-port.ts`: new `RegistryEntriesSnapshot` interface (`entries`,
  `catalogVerification`, `catalogDigestSha256`); `fetchRegistryEntries` returns
  `Promise<RegistryEntriesSnapshot>`. Cache slot holds one snapshot, written atomically from one
  `fetchRegistryIndex` result. `"unavailable"` results are never cached (today's behavior,
  preserved); `"unverified"` and `"verified"` are cached for the existing 10 minutes.
  `ModuleDistributionDependencies.fetchRegistryEntries` (`packages/settings/src/routes.ts`) type
  updates to match.
- `packages/settings/src/routes-module-registry.ts`: both GET constructions (:92-97, :102-107) and
  the three post-mutation refetch call sites (download, remove, purge-cancel) consume the
  snapshot. Invariant: on `enabled: true` responses,
  `registryUnavailable === (catalogVerification === "unavailable")`. The `enabled: false` early
  return keeps `registryUnavailable: false` and sends `catalogVerification: "unavailable"`,
  `catalogDigestSha256: null`. No row-shape change — `deriveRows`, `ModuleRegistryDeriveInput`,
  `module-registry-rows.ts`, `ModuleRegistryRowDto`, and the row schema are untouched.
- `packages/shared/src/platform-api-modules.ts`: `GetModuleRegistryResponse` +=
  `catalogVerification: "verified" | "unverified" | "unavailable"` and
  `catalogDigestSha256: string | null`; `getModuleRegistryRouteSchema`'s 200 response schema gets
  both properties added to `properties` and `required` (fast-json-stringify strips undeclared
  fields — both matter).
- Existing fixture call sites to extend with the two new envelope fields (grep-confirm each still
  exists before editing — master plan's line numbers for these are unverified this session):
  `tests/e2e/settings-modules.spec.ts`, `tests/unit/settings-instance-modules-pane-render.test.tsx`
  (3 `satisfies GetModuleRegistryResponse` fixtures), `tests/unit/instance-modules-dedup.test.tsx`
  (stale `.tsx`, not typechecked, update anyway), `tests/integration/module-distribution.e2e.test.ts`
  (`registryUnavailable` assertion).
- New/extended tests in `tests/integration/module-registry.test.ts`: `enabled:false` response
  carries `catalogVerification: "unavailable"`, null digest, `registryUnavailable: false`; enabled
  path asserts the invariant above and that the HTTP body actually contains the new fields
  (schema-strip check); **non-admin GET** → rejected by `assertAdminUser`, body contains neither
  `catalogVerification` nor `catalogDigestSha256`, and `fetchRegistryEntries` was never invoked
  (spy) — authorization runs before verification is computed; cache behavior — a fetch failure
  after a cached snapshot keeps serving the cached snapshot until TTL, never replaces it with an
  unavailable one; entries and verification in any response always come from one snapshot.
- Verify: `pnpm test:integration tests/integration/module-registry.test.ts` → exit 0;
  `pnpm typecheck` → exit 0.

### Phase-2 e2e (this lane's finish line)

The module-distribution e2e mock registry starts serving a test-key-signed index (D6 harness
change lands here, before Phase 3 enforcement exists, so this proves the verified listing
end-to-end and Phase 3 inherits a green baseline):
`pnpm test:integration tests/integration/module-distribution.e2e.test.ts` → exit 0.

## Full gate

Only via the `verify-gate` skill (isolated DB) at wrap-up, per CLAUDE.md — never run
`pnpm verify:foundation` unscoped.

## Review checklist

- [x] Spec approved (#1319 body) and task issue open (#1319)
- [x] Scope is exactly master-plan Tasks 3-4, no enforcement/override/UI
- [x] Line-number citations re-verified against the current tree this session (not inherited)
- [x] No function bodies pasted — signatures/schema deltas/test cases only
- [x] Every verification command unpiped, with expected exit code
