# Plan: Signed Moss Module Catalog (#1319)

- **Issue:** #1319 (`task`, `security`, RFA) — the issue body is the authoritative spec, approved by
  Ben 2026-08-17. Spec doc under `docs/superpowers/specs/` is supplementary.
- **Provenance:** fresh, non-incremental plan replacing the four-times-patched prior draft, per
  Ben's 2026-08-18 ruling. Authored by Fable 5 (`fable-1319-plan`); review pass by
  `build-1319-relay3` (Sonnet), then Coordinator-ordered Opus review. Revised once to close the
  round-6 (Opus) blocking findings — ledger #20–24. Per Ben: this revision is final; no further
  adversarial round follows it.
- **No DB migration.** Do not claim migration 0185 (reserved for #1586). No schema change anywhere.
- **Branch:** `build-1319-signed-module-catalog` (shared checkout — every git action via the
  `shared-checkout` skill; never `git add -A`).

## What this builds

Ed25519-sign the published module catalog (`index.json`) with a detached `index.json.sig` asset;
verify at fetch time against a keyring pinned in the Moss binary; surface tri-state
`catalogVerification` (`"verified" | "unverified" | "unavailable"`) plus a `catalogDigestSha256`
snapshot identity on the admin registry listing; block catalog-driven downloads — first install
and version update alike — from an unverified catalog with a 409 carrying the current digest;
allow a digest-bound, admin-only, one-attempt, non-persisted override that bypasses **only** the
catalog-signature check. Ensure-at-boot has no override. Already-installed modules keep running —
this governs recognition and new downloads, never retroactive disabling. No new dependency: `node:crypto` has Ed25519
(`generateKeyPairSync("ed25519")`, `sign(null, …)`, `verify(null, …)`); grep confirms zero existing
Ed25519/tweetnacl/libsodium usage in the tree.

Product language: **"recognized by Moss"** / **"verified catalog module"** / **"unverified"**.
Never "safe", "sandboxed", or "audited".

## Rulings ledger — facts from review rounds 1–6, all re-verified against the current tree

Every item below is folded into the tasks; listed so no reviewer re-derives them.

1. `GetModuleRegistryResponse` is constructed at exactly **two** production sites:
   `packages/settings/src/routes-module-registry.ts:92-96` (the `enabled:false` early return — the
   round-5 missed call site) and `:102-106`. Both must carry the new envelope fields.
2. `apps/web/src/api/client.ts` — `ApiError` (:177-185) has no body field and `readErrorBody`
   (:1374-1396) returns only `{message, code}`; the 409's `digestSha256` is discarded before
   `onError` runs. Both must be extended or the override flow is dead.
3. The real web download function is `downloadRegistryModule(id, version?)`
   (`apps/web/src/api/client.ts:432-440`), sole caller
   `apps/web/src/settings/settings-module-registry-section.tsx:142`. There is no
   `downloadExternalModule`.
4. Cross-snapshot risk: index bytes, digest, verification state, and parsed entries must come from
   **one** fetch. `fetchRegistryIndex` performs the single index fetch
   (`packages/module-registry/src/distribution/registry-source.ts:60-76`); the pipeline's only
   index acquisition is its internal call (`pipeline.ts:64-71`). No second fetch anywhere.
5. Verification commands for the e2e file use `pnpm test:integration <file>`
   (`scripts/test-integration.ts` auto-isolates a `jarvis_test_<pid>_<random>` DB); never
   `pnpm vitest run` directly. Unit files use `pnpm test:unit <file>`.
6. A failed index fetch today logs a warning and returns `null` **without writing the 10-minute
   cache** (`apps/api/src/module-distribution-port.ts:44-47`). Preserved: an `"unavailable"` result
   is never cached; an `"unverified"` snapshot (bytes were fetched) **is** cached like a verified
   one — the digest-bound override needs a stable listing digest.
7. `registry-source.ts:68` uses `response.text()`; digest and signature verification need the exact
   raw bytes → switch to `arrayBuffer()`.
8. The `.sig` fetch goes through `createRegistryFetch` (`registry-source.ts:40-52`) — plain fetch
   only under the `JARVIS_MODULE_REGISTRY_URL` test override, which `resolveRegistryIndexUrl`
   (:22-31) refuses in production; otherwise host-pinned via `createHostPinnedFetch`.
9. `.github/workflows/modules-registry.yml:56` — the prune step's jq keep-list must add
   `"index.json.sig"` or every publish run deletes the signature it just uploaded.
10. `gh release upload --clobber` (yml:50-51) has no cross-asset atomicity. Accepted: during the
    seconds between the two asset updates an enforcing Moss reads a mismatched pair and reports
    `unverified` — fail closed, self-heals on next fetch. Documented, not engineered around.
11. No local `installedVersion` identifier exists in `module-registry-rows.ts`; the installed test
    is the expression `(discovery?.version ?? null) === null` (see row literal :105-117). Round 6
    superseded the field this fact fed: no per-row blocked flag exists anymore (ledger #20), so no
    such expression is added anywhere.
12. `additionalProperties: false` + fast-json-stringify silently strips undeclared fields on
    **both** response and request bodies — every new field must be added to the JSON schema and its
    `required` list where appropriate (`packages/shared/src/platform-api-modules.ts`).
13. vitest never collects `packages/*/src/**`; new tests live under `tests/unit/` /
    `tests/integration/`. Package-level `pnpm --filter` test/build commands are false greens.
14. Round-4 fixture enumeration (all re-verified): `tests/unit/module-registry-rows.test.ts:44-45`
    (derive helper) and `:192` (direct construction), `tests/e2e/settings-modules.spec.ts:25`,
    `tests/unit/settings-instance-modules-pane-render.test.tsx:119,244,298` (three
    `satisfies GetModuleRegistryResponse` fixtures), plus stale-but-harmless
    `tests/unit/instance-modules-dedup.test.tsx:27-42` (`.tsx`, not typechecked — update anyway).
15. `catalogUnverifiedErrorSchema` must have `required: ["error"]` only — the download route throws
    two sibling `HttpError(409, …)`s (routes-module-registry.ts:125-127, :128-130) that serialize
    through the same 409 schema with no `code`/`digestSha256`.
16. Route response invariant, single rule: **on `enabled: true` responses,
    `registryUnavailable === (catalogVerification === "unavailable")`**. The `enabled: false` early
    return keeps its current `registryUnavailable: false` and sends
    `catalogVerification: "unavailable"`, `catalogDigestSha256: null` — the rule is scoped to
    enabled responses; the UI never reads registry state when disabled
    (settings-module-registry-section.tsx:216-219 guard).
17. Module-reconcile needs **no code change**: `scripts/module-reconcile.ts:300-304` already
    catches any ensure-download error, logs a bounded warning, and continues boot. Enforcement in
    the pipeline gives ensure-at-boot fail-closed behavior for free. Test only.
18. `DownloadAndStageOptions.index?` (`pipeline.ts:50-51`) has **zero** production callers (port
    :53-59 and reconcile :271-277 both omit it) — cut it; the internal fetch is the sole snapshot
    source by construction.
19. New this pass — call sites the prior plan never enumerated: the four existing
    `downloadAndStageModule` tests (`tests/unit/module-distribution-pipeline.test.ts`, `it(` at
    :131,149,167,192; the calls at :134,157,183,195)
    and the module-distribution e2e mock registry serve **no `.sig`**; once enforcement lands they
    all red as `catalog-unverified` unless given a signed-fixture path. This forces the test-key
    seam (Decision D6). The three existing `fetchRegistryIndex` tests (:110,119,125) stay green
    because the new result type is a strict superset (`index`, `errors` preserved) and a `.sig`
    fetch failure folds to `"unverified"` without throwing (their `fakeFetch` 404s unknown URLs).
20. Round 6 (Opus review of this plan) — **update path**: `settings-module-registry-section.tsx`
    routes Install AND Update through the same `onInstall` → `downloadMutation` (:180-190 — the
    `"update-available"` branch changes only the confirm copy; the mutation call is identical), so
    enforcement 409s version updates exactly like first installs. Any blocked-flag formula
    conditioned on "not installed" (the prior draft's `installBlockedByCatalogVerification`)
    leaves updates blocked with no override path, making spec stories 3/5 and acceptance outcome 3
    unreachable for updates. Resolution: **no per-row flag at all** — the UI gates every download
    action from the envelope's `catalogVerification` (Task 7), which is structurally immune to
    per-lifecycle-state omissions. Spec story 10 ("installed modules stay usable") governs runtime
    and enablement of already-installed code; it never exempts new downloads.
21. Round 6 — **UAT reality**: `tests/uat/specs/module-install.uat.spec.ts:51-56` installs the
    finance module through the real UI against the REAL GitHub catalog.
    `JARVIS_MODULE_REGISTRY_URL` appears nowhere under `tests/uat/` (grep exit 1, re-verified this
    session), and the UAT stack runs `NODE_ENV=production` (`tests/uat/provisioner.ts:205`), where
    that override is hard-refused (`registry-source.ts:25-27`). Two consequences: (a) Phase 3 must
    not merge before the live catalog is signed with Ben's pinned key, or this spec reds — now a
    D9 merge gate; (b) the containerized UAT harness **cannot** serve a mock unverified catalog
    without weakening a deliberate production refusal — the unverified/override live proof moves
    to a non-production live dev instance (Task 8). `JARVIS_E2E_MODULE_FETCH_BASE`
    (provisioner.ts:249-256) is the artifact-fetch seam, not a registry-index seam.
22. Round 6 — **trust-boundary self-refusal**: `resolveCatalogTrustedKeys` must refuse the test
    key in production ITSELF (throw when `NODE_ENV === "production"` and the key is set), not
    borrow `resolveRegistryIndexUrl`'s refusal — the `trustedKeys` injection options on
    `FetchRegistryIndexOptions`/`DownloadAndStageOptions` make key resolution reachable without
    the URL resolver ever running. Tested explicitly (Task 1) and grep-asserted to have no
    production producers (Task 5).
23. Round 6 — spec story 18's "admin authorization before verification details are returned" had
    no test. Authorization does run first — `assertAdminUser` inside `loadLocalState`
    (`routes-module-registry.ts:44,54`), called before any registry fetch on both routes (:88,
    :123) — but Tasks 4/5 now add explicit non-admin tests proving no `catalogVerification`,
    `catalogDigestSha256`, or 409 digest ever reaches an unauthorized caller.
24. Round 6, medium (folded in): `--require-signature` with an absent key gets a unit test
    (story 13, Task 2). Phase 1's dispatch proof stays manual — it exercises real GH Actions
    secrets, which no automated test can. Phase 3's Playwright spec is route-mocked and proves
    rendering only; the 409/override contract is proven at the integration route seam (Tasks 5/8)
    and the live-path gate, and the plan now says so explicitly.

## Seams map (current tree, verified this session)

- `packages/module-registry/src/distribution/registry-source.ts` — `REGISTRY_INDEX_URL` :9,
  `REGISTRY_ALLOWED_HOSTS` :14-18, `REGISTRY_INDEX_MAX_BYTES` (1 MiB) :20,
  `resolveRegistryIndexUrl` :22-31, `createRegistryFetch(env, fetchFn?)` :40-52,
  `fetchRegistryIndex` :60-76 (returns `{index, errors}`, never throws),
  `downloadArtifactBuffer` :89-119 (streaming size abort + sha256 check).
- `packages/module-registry/src/distribution/pipeline.ts` — `ModuleDownloadErrorCode` :24-31
  (7 codes), `ModuleDownloadError(code, message)` :33-41, `DownloadAndStageOptions` :43-52,
  `downloadAndStageModule` :61-142 (index fetch :64-71, artifact resolve :72, size guard :80-85,
  URL join :88, download+integrity :89-103, extract/manifest/version/packageHash :104-141).
- `apps/api/src/module-distribution-port.ts` — `REGISTRY_CACHE_TTL_MS` (10 min) :35, cache :36,
  `fetchRegistryEntries` :39-50, `download` :51-71, `removeModuleFiles` :72-79.
- `packages/settings/src/routes-module-registry.ts` — `DOWNLOAD_ERROR_STATUS` :30-38 (`?? 502`
  :135), `deriveRows` :60-80, GET :82-112 (early return :92-96, main :102-106,
  `registryUnavailable: entries === null` :104), download route :114-166 (pipeline call :133,
  HttpError mapping :134-136, post-download refetch :157-158), remove :168-230, purge-cancel
  :232-270. Admin authorization runs before any 404/409 branch.
- `packages/settings/src/module-registry-rows.ts` — `ModuleRegistryDeriveInput` :35-46,
  `deriveModuleRegistryRows` row literal :105-117.
- `packages/shared/src/platform-api-modules.ts` — `ModuleRegistryRowDto` :415-432,
  `GetModuleRegistryResponse` :434-438, `DownloadExternalModuleRequest` :440-442, row schema
  :467-497, GET route schema :499-519, download route schema :528-544 (body :530-534,
  `409: errorResponseSchema` :541). `errorResponseSchema` in
  `packages/shared/src/schema-fragments.ts`.
- `packages/module-sdk/src/route-errors.ts` — `HttpError` :12-20; `handleRouteError` :88-90 sends
  only `{error: message}` for HttpError → a digest can never ride the generic path; the 409
  special-case reply in Task 5 is structurally required.
- `apps/web/src/api/client.ts` — `ApiError` :177-185, `getModuleRegistry` :425-429,
  `downloadRegistryModule` :432-440, `requestJson` error path :1360-1363, `readErrorBody`
  :1374-1396.
- `apps/web/src/settings/settings-module-registry-section.tsx` — `downloadMutation` :140-148,
  `onInstall` :180-190, purge-confirm precedent (`danger: true`) :203-214, disabled guard
  :216-219, `registryUnavailable` banner :236-240, refresh :250-256.
- `scripts/publish-module-registry.ts` — `buildRegistryArtifacts` :111-155 (index literal
  :143-147, self-schema check :148-152, `writeFileSync(… "index.json" …)` :153), CLI entry
  :158-187.
- `.github/workflows/modules-registry.yml` — build step :43-44, upload
  `gh release upload modules dist/registry/* --clobber` :50-51 (dir glob picks up `.sig`
  automatically), prune jq keep-list :56.
- `scripts/module-reconcile.ts` — ensure loop :250-299, pipeline call :271-277, catch-warn-continue
  :300-304.
- Existing tests at the seams: `tests/unit/module-distribution-pipeline.test.ts` (fixture builder
  :38-76, `fakeFetch` :79-86, `fetchRegistryIndex` cases :107-128, `downloadAndStageModule` cases
  :130+), `tests/integration/module-distribution.e2e.test.ts` (`registryUnavailable` assertion
  :244), `tests/unit/publish-module-registry.test.ts`, `tests/unit/module-registry-rows.test.ts`,
  `tests/unit/module-registry.test.ts`, `tests/e2e/settings-modules.spec.ts:25`,
  `tests/unit/settings-instance-modules-pane-render.test.tsx:119,244,298`,
  `tests/unit/instance-modules-dedup.test.tsx:27-42`.

## Design decisions

- **D1 — Trust object is the catalog.** One detached `index.json.sig` beside `index.json`,
  containing `{formatVersion: 1, algorithm: "ed25519", keyId, signatureBase64}` over the exact
  published UTF-8 bytes. The catalog's existing per-artifact sha256+size then authenticate every
  artifact. No per-module signatures.
- **D2 — Keyring pinned in code.** A frozen `MODULE_CATALOG_PUBLIC_KEYS` array in
  `packages/module-registry` (ships in the image). Unknown `keyId` → unverified, never fetched or
  guessed. Rotation = ship next public key in a release, start signing with it later, retire old
  key a release after that. Compromise response: same mechanism, old key removed deliberately.
- **D3 — Verification semantics.** `"unavailable"` = index bytes could not be fetched (network,
  non-200, oversize) **or** fetched bytes fail JSON/schema validation (no usable entries either
  way; `index: null`). `"unverified"` = valid index whose signature is absent, oversize, malformed,
  unknown-key, or mismatched. `"verified"` = signature verifies over the exact bytes AND the index
  validates. Entries are parsed and listed (visibly marked) when unverified — authenticity gates
  _trust and downloads_, not display. `digestSha256` = SHA-256 hex of the exact fetched index
  bytes, non-null whenever bytes were fetched (unverified included), null when nothing was fetched.
- **D4 — Enforcement point is the pipeline.** `downloadAndStageModule` refuses
  (`"catalog-unverified"`, HTTP 409) unless its own internal fetch yields `"verified"`, or the
  caller passed `overrideCatalogDigestSha256` exactly equal to the fresh fetch's digest while state
  is `"unverified"`. `"unavailable"` is never overridable (no snapshot to bind). The override
  bypasses only this check — artifact sha256/size, host pinning, safe extraction, manifest
  validation, id/version cross-check, compatibility, staging, drift, enablement all still run.
  Because both admin route and boot reconcile call the same pipeline, direct API = UI policy and
  ensure-at-boot fails closed with no bypass parameter exposed to it. Enforcement and the override
  apply to **every** catalog-driven download — first install and version update both flow through
  the same pipeline call and the same UI mutation (`onInstall` → `downloadMutation`,
  settings-module-registry-section.tsx:180-190; ledger #20). Spec story 10's "installed modules
  stay usable" is about runtime/enablement of code already on disk, never an exemption for
  downloading a new version.
- **D5 — Override is stateless.** Digest travels request→response→confirm→request; nothing
  persisted, no preference, one attempt per confirmation. A digest mismatch at download time
  returns a fresh 409 with the new digest, forcing a new warning.
- **D6 — Test-key seam, production-refused by itself.** `resolveCatalogTrustedKeys(env)` returns
  the pinned keyring; when the registry-URL test override is active (`JARVIS_MODULE_REGISTRY_URL`
  set), it additionally honors `MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY` (PEM, keyId `"test"`).
  Independent of that coupling, the function **throws** when `env.NODE_ENV === "production"` and
  the test key is set — its own refusal, same posture as `resolveRegistryIndexUrl`
  (registry-source.ts:23-26), never borrowed from it: the `trustedKeys` injection options make
  key resolution reachable without the URL resolver ever running (ledger #22). Unit tests inject
  `trustedKeys` directly (same injection style as `fetchFn`); the integration e2e harness and the
  non-production live dev instance (Task 8) use the env pair. The `NODE_ENV=production` UAT
  container can use neither — see ledger #21. Without this seam every existing download-path test
  and any mock-backed live proof of the verified path is impossible (ledger #19).
- **D7 — Signing env contract (publish side, CI-only).** `MOSS_MODULE_CATALOG_SIGNING_KEY_ID` +
  `MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY` (PKCS#8 PEM) from GitHub Actions secrets. Both-or-
  neither; a half-set pair throws. The CLI signs when the pair is present; the workflow passes
  `--require-signature` so CI fails when the pair is absent or self-verification fails. Local
  unsigned runs stay possible for development. Self-verification checks the fresh signature
  against `MODULE_CATALOG_PUBLIC_KEYS` — publishing with a key the shipping binary doesn't trust
  fails the build (also proves rotation overlap ordering).
- **D8 — The production keypair is provisioned by Ben out-of-band.** No agent generates or prints
  the private key (transcript/log exposure violates "secrets never escape"). The public key lands
  in code via Ben; see Open Questions.
- **D9 — Rollout ordering, now a hard merge gate.** Phase 1 (publish signing) ships and produces
  a signed catalog on the live release **before** Phase 3 (enforcement) merges. Not just courtesy
  to older versions: `module-install.uat.spec.ts` runs against the real GitHub catalog
  (ledger #21), so merging enforcement first reds UAT. Phase 3's PR is **blocked from merging**
  until (a) Ben's production public key is pinned in `MODULE_CATALOG_PUBLIC_KEYS` and (b) a live
  release publish has produced an `index.json.sig` that verifies against it (the kill-gate
  proof). Older Moss versions ignore the `.sig`; enforcing versions verify immediately. No
  unsigned transition mode.

## Determinism boundary

No model involvement anywhere in this feature — zero prompts, zero model-authored values. All UI
feedback (verification banner, row markers, 409 conflict toast, override confirmation) renders
from response fields (`catalogVerification`, `catalogDigestSha256`, error `code`/`digestSha256`).
Logs carry the failure-reason taxonomy and digests only — never key material, never raw crypto
library errors, never module content.

---

## Phase 1 — signing primitive + signed publishing

### Task 1: catalog signing module

New file `packages/module-registry/src/distribution/catalog-signing.ts`, exported from the
package's node barrel (`publish-module-registry.ts` imports from
`../packages/module-registry/src/node.js` — :16-24; builder confirms the barrel file path when
adding the export).

```ts
export const CATALOG_SIGNATURE_FORMAT_VERSION = 1;

export interface ModuleCatalogSignature {
  readonly formatVersion: 1;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signatureBase64: string;
}

export interface ModuleCatalogPublicKey {
  readonly keyId: string;
  readonly publicKeyPem: string; // SPKI PEM
}

export const MODULE_CATALOG_PUBLIC_KEYS: readonly ModuleCatalogPublicKey[]; // frozen; keyId "moss-catalog-2026-a"

export function signCatalogBytes(
  bytes: Uint8Array,
  privateKeyPem: string,
  keyId: string
): ModuleCatalogSignature;

export type CatalogSignatureFailure = "malformed" | "unknown-key" | "signature-mismatch";

export function verifyCatalogBytes(
  bytes: Uint8Array,
  signatureDocument: unknown,
  keys: readonly ModuleCatalogPublicKey[]
): { verified: true; keyId: string } | { verified: false; reason: CatalogSignatureFailure };

export function resolveCatalogSigningKey(
  env: NodeJS.ProcessEnv
): { keyId: string; privateKeyPem: string } | null; // both-or-neither; half-set throws

export function resolveCatalogTrustedKeys(
  env: NodeJS.ProcessEnv
): readonly ModuleCatalogPublicKey[]; // D6
```

`verifyCatalogBytes` treats any structurally wrong document (bad JSON shape, wrong formatVersion,
wrong algorithm, non-base64) as `"malformed"`; it never throws on untrusted input.

Tests — `tests/unit/catalog-signing.test.ts` (new; ledger #13 placement):

- sign→verify round-trip over fixed bytes verifies with the matching key — fails if sign/verify
  disagree on encoding or byte coverage.
- one flipped byte in the catalog → `"signature-mismatch"` — fails if verification isn't over the
  exact bytes.
- unknown keyId → `"unknown-key"`; a two-key keyring accepts either key (rotation overlap) — fails
  if lookup is hardwired to a single key.
- each malformed-document shape (non-object, wrong version, wrong algorithm, garbage base64) →
  `"malformed"` without throwing — fails if untrusted input can throw.
- `resolveCatalogSigningKey`: null on empty env; value on full pair; throws on each half-set pair.
- `resolveCatalogTrustedKeys`: pinned-only without the URL override; pinned+test key only with the
  override active and the test key set — fails if the test seam leaks into the production path.
- `resolveCatalogTrustedKeys` with `NODE_ENV=production` and the test key set — with the URL
  override set and without it — **throws** (ledger #22) — fails if the production refusal is
  borrowed from `resolveRegistryIndexUrl` instead of being the function's own.

Verify: `pnpm test:unit tests/unit/catalog-signing.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"` →
`EXIT=0`. Also `pnpm typecheck > /tmp/tc1.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

### Task 2: sign at publish + workflow wiring

`scripts/publish-module-registry.ts`:

- `buildRegistryArtifacts` signs after the `:153` write when a signing key is present: capture the
  exact string written (`JSON.stringify(index, null, 2) + "\n"`), sign its UTF-8 bytes,
  self-verify against `MODULE_CATALOG_PUBLIC_KEYS` (D7 — throws on failure), write
  `index.json.sig` (JSON of `ModuleCatalogSignature`).
- `BuildRegistryArtifactsOptions` gains `readonly signingKey: { keyId: string; privateKeyPem: string } | null`.
- CLI resolves the key via `resolveCatalogSigningKey(process.env)` and gains
  `--require-signature`: exit 1 when set and the key pair is absent. The requirement check is
  factored as an exported function (builder names it) so a unit test drives it without spawning a
  process (ledger #24).

`.github/workflows/modules-registry.yml`:

- Build step (:43-44): add `env:` with the two `MOSS_MODULE_CATALOG_SIGNING_*` secrets and append
  `--require-signature`.
- Prune jq keep-list (:56): add `"index.json.sig"` (ledger #9).
- Upload (:50-51): unchanged — the dir glob covers the `.sig`. Non-atomicity accepted per ledger
  #10; record it in a workflow comment.

Tests — extend `tests/unit/publish-module-registry.test.ts`:

- with a signing key (ephemeral, generated in-test): `index.json.sig` exists, parses as
  `ModuleCatalogSignature`, and `verifyCatalogBytes` over the **written** `index.json` bytes
  verifies — fails if signing covers re-serialized rather than written bytes.
- without a key: no `.sig`, build succeeds (local dev path).
- the exported require-signature check with an absent key pair → throws (story 13; ledger #24) —
  fails if `--require-signature` parses but never enforces.
- byte appended to `index.json` after publish → verification fails (byte-exactness through the
  file round-trip).
- signing key whose keyId is absent from the pinned keyring → `buildRegistryArtifacts` throws —
  fails if D7's the-binary-will-trust-it guarantee is unenforced. (This test needs the pinned
  keyring to be non-empty; until Ben's real key lands, gate it on a temporary well-known dev entry
  or inject the keyring — builder picks the injection route if the frozen array blocks it, and
  says so in the PR.)

Verify: `pnpm test:unit tests/unit/publish-module-registry.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`.

Phase-1 e2e: a `workflow_dispatch` run of `modules-registry.yml` with the GH secrets set →
release assets contain `index.json` + `index.json.sig`, and a local
`verifyCatalogBytes(downloadedBytes, downloadedSig, MODULE_CATALOG_PUBLIC_KEYS)` spot-check
verifies; a second dispatch with the secrets unset fails the build step (proof recorded on the PR).

### KILL GATE (after Phase 1, before Phase 2 is built)

**Observation that ends the line:** CI cannot produce a signature that verifies against the pinned
public key. The known fatal risk is PEM newline mangling of the multi-line private-key secret in
GitHub Actions. If the dispatch proof cannot go green with real secrets, stop and redesign the key
transport (e.g. base64-wrapped PEM) before any fetch-side work begins.
**Owner:** the build agent flags the result on the PR; the **Coordinator** makes the go/no-go
call. Phase 1 ships alone and is evaluated first (D9 rollout ordering also requires this).

---

## Phase 2 — fetch-time verification + listing surface

### Task 3: verify in `fetchRegistryIndex`

`packages/module-registry/src/distribution/registry-source.ts`:

```ts
export const REGISTRY_SIGNATURE_MAX_BYTES = 4 * 1024;

export type CatalogVerification = "verified" | "unverified" | "unavailable";

export type CatalogVerificationFailureReason =
  | "index-fetch-failed"
  | "index-too-large"
  | "index-invalid"
  | "signature-fetch-failed"
  | "signature-too-large"
  | "signature-malformed"
  | "signature-unknown-key"
  | "signature-mismatch";

export interface FetchRegistryIndexResult {
  readonly index: ModuleRegistryIndex | null;
  readonly verification: CatalogVerification;
  readonly digestSha256: string | null;
  readonly failureReason: CatalogVerificationFailureReason | null;
  readonly errors: string[];
}

export interface FetchRegistryIndexOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  readonly trustedKeys?: readonly ModuleCatalogPublicKey[]; // default resolveCatalogTrustedKeys(env)
}
```

Behavior (one function, one snapshot — ledger #4):

- Read the index response via `arrayBuffer()` (ledger #7); digest those exact bytes; parse and
  validate from the same bytes. Fetch/size failure → `"unavailable"`, digest null. Fetched bytes
  failing JSON/schema validation → `"unavailable"` / `"index-invalid"` with the digest of the
  fetched bytes but `index: null` (D3).
- Fetch `resolveRegistryIndexUrl(env) + ".sig"` through the **same** `createRegistryFetch` wrapper
  (ledger #8), capped at `REGISTRY_SIGNATURE_MAX_BYTES`. Any signature-side failure — non-200,
  oversize, thrown fetchFn, malformed, unknown key, mismatch — folds to `"unverified"` with the
  matching `failureReason`; **never throws** (keeps the three existing tests green, ledger #19).
- `"verified"` only when the signature verifies over the exact index bytes AND the index validates.
- `errors` strings stay product-level (taxonomy + safe detail; no raw crypto/library output).

Tests — extend `tests/unit/module-distribution-pipeline.test.ts` (home of `makeFixture`/
`fakeFetch`); fixture builder gains an ephemeral in-test Ed25519 keypair and a `fakeFetch` variant
serving `/index.json.sig`:

- signed fixture + its key in `trustedKeys` → `"verified"`, digest = sha256 of the served bytes —
  fails if verification or digest use re-serialized bytes.
- no `.sig` route (existing `fakeFetch`) → `"unverified"` / `"signature-fetch-failed"`, index
  still parsed — fails if a missing sig throws or hides entries.
- tampered index bytes under a stale sig → `"unverified"` / `"signature-mismatch"`.
- unknown keyId → `"signature-unknown-key"`; oversize sig body → `"signature-too-large"`.
- non-200 index → `"unavailable"`, digest null (existing case extended with the new fields).
- the three pre-existing `fetchRegistryIndex` cases (:108-127) pass unmodified (superset
  guarantee) — fails if the return shape or throw behavior changed incompatibly.

Verify: `pnpm test:unit tests/unit/module-distribution-pipeline.test.ts > /tmp/t3.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`.

### Task 4: snapshot cache + envelope + rows

`apps/api/src/module-distribution-port.ts`:

```ts
export interface RegistryEntriesSnapshot {
  readonly entries: readonly ModuleRegistryEntry[] | null;
  readonly catalogVerification: CatalogVerification;
  readonly catalogDigestSha256: string | null;
}
// fetchRegistryEntries(options): Promise<RegistryEntriesSnapshot>
```

The cache slot holds one `RegistryEntriesSnapshot`, written atomically from one
`fetchRegistryIndex` result. `"unavailable"` results are returned to the caller but **never
cached** (ledger #6 — a live cached snapshot keeps serving until TTL); `"unverified"` and
`"verified"` snapshots are cached for the existing 10 minutes.
`ModuleDistributionDependencies.fetchRegistryEntries` (`packages/settings/src/routes.ts:162`)
updates to the snapshot type.

`packages/settings/src/routes-module-registry.ts`:

- Both GET constructions (ledger #1) and the three post-mutation refetch sites (:157-158,
  :221-222, :261-262) consume the snapshot. Envelope values per ledger #16.
- **No row-shape change** (ledger #20): `deriveRows`, `ModuleRegistryDeriveInput`,
  `module-registry-rows.ts`, `ModuleRegistryRowDto`, and the row schema are all untouched. The
  prior draft's per-row `installBlockedByCatalogVerification` is dropped — a per-lifecycle-state
  formula is exactly how the update path got missed; download gating derives from the envelope in
  the UI (Task 7), one rule for every download action.

`packages/shared/src/platform-api-modules.ts` (ledger #12 — schema properties **and** `required`):

- `GetModuleRegistryResponse` += `catalogVerification: "verified" | "unverified" | "unavailable"`
  and `catalogDigestSha256: string | null`; GET 200 schema += both, in `required`.

Existing call-site updates (ledger #14, now envelope-only): the `GetModuleRegistryResponse`
fixtures — `tests/e2e/settings-modules.spec.ts:25`,
`tests/unit/settings-instance-modules-pane-render.test.tsx:119,244,298`, and the stale-but-harmless
dedup fixture — plus `tests/integration/module-distribution.e2e.test.ts:244`'s envelope assertions
extended with the new fields. `tests/unit/module-registry-rows.test.ts` no longer changes (row
shape untouched).

Tests:

- extend `tests/integration/module-registry.test.ts` (route level): the `enabled:false` response
  carries `catalogVerification: "unavailable"`, null digest, `registryUnavailable: false` — fails
  exactly on the round-5 missed call site; the enabled path asserts the ledger-#16 identity; the
  HTTP response body actually contains the new fields — fails if the schema strips them (ledger
  #12).
- **non-admin GET** (ledger #23, spec story 18): GET `/api/admin/module-registry` as a non-admin
  actor → rejected by `assertAdminUser` (routes-module-registry.ts:54; builder confirms the exact
  status it throws — 403 expected — at task start) and the body contains neither
  `catalogVerification` nor `catalogDigestSha256`; additionally assert the registry fetch was
  never invoked (spy on `fetchRegistryEntries`) — fails if verification details are computed or
  returned before authorization.
- port cache behavior (same integration file): a fetch failure after a cached snapshot keeps
  serving the cached snapshot until TTL and never replaces it with an unavailable one; entries and
  verification in any response always originate from the same snapshot — fails on cross-snapshot
  mixing or unavailable-caching.

Verify:
`pnpm test:integration tests/integration/module-registry.test.ts > /tmp/t4b.log 2>&1; echo "EXIT=$?"` → `EXIT=0`;
`pnpm typecheck > /tmp/tc4.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

Phase-2 e2e: the module-distribution e2e mock registry starts serving a test-key-signed index
(D6 harness change lands **here**, before enforcement, so Phase 2 proves the verified listing
end-to-end and Phase 3 inherits a green baseline):
`pnpm test:integration tests/integration/module-distribution.e2e.test.ts > /tmp/p2.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`.

---

## Phase 3 — enforcement, override, UI

### Task 5: pipeline enforcement + 409 contract

`packages/module-registry/src/distribution/pipeline.ts`:

- `ModuleDownloadErrorCode` += `"catalog-unverified"`.
- `ModuleCatalogSignature`-independent error carrier: `ModuleDownloadError` gains
  `readonly digestSha256?: string` (set only for `"catalog-unverified"` on an unverified — not
  unavailable — snapshot).
- `DownloadAndStageOptions`: **remove** `index?` (ledger #18); add
  `readonly overrideCatalogDigestSha256?: string` and `readonly trustedKeys?` passthrough.
- Enforcement per D4/D5, using only the internal fetch's single snapshot. Message text in product
  language, no crypto detail.

`apps/api/src/module-distribution-port.ts` — `download` gains
`overrideCatalogDigestSha256?: string`, passed through; the `{ok:false}` mapping carries
`digestSha256` when present.

`packages/settings/src/routes-module-registry.ts` download route:

- `DOWNLOAD_ERROR_STATUS` += `"catalog-unverified": 409`.
- Special-case **before** the generic throw (:134-136): when
  `result.code === "catalog-unverified"`, reply 409 with
  `{error, code: "catalog-unverified", digestSha256}` directly — the generic `handleRouteError`
  path cannot carry the digest (route-errors.ts:88-90).
- Request body: accept `overrideCatalogDigestSha256` and pass it to `dist.download`.

`packages/shared/src/platform-api-modules.ts`:

- `DownloadExternalModuleRequest` += `overrideCatalogDigestSha256?: string`; body schema
  (:530-534) += the property — request-side strip trap (ledger #12).
- 409 response schema → new `catalogUnverifiedErrorSchema`: properties
  `error`/`code`/`digestSha256`, `required: ["error"]` only (ledger #15 — serializes all three
  409 shapes the route produces).

Tests — extend `tests/unit/module-distribution-pipeline.test.ts` (signed fixture from Task 3):

- unverified catalog, no override → throws `catalog-unverified` carrying the snapshot digest;
  modules dir untouched — fails if enforcement runs after staging or drops the digest.
- correct override digest → stages normally; artifact sha256 mismatch under the same correct
  override → rejected with the existing integrity code — fails if the override widens beyond the
  signature check (spec stories 6–7).
- stale override digest (catalog bytes changed between calls) → `catalog-unverified` again with
  the **new** digest (D5).
- unavailable catalog (index 404) + any override → existing fetch-failure code, no install —
  fails if override applies to unavailable.
- verified catalog → stages without override (the four pre-existing cases, green via the signed
  fixture — ledger #19).

Extend `tests/integration/module-registry.test.ts`: the 409 HTTP body contains `code` and
`digestSha256` (schema-strip check); the two sibling 409s (distribution disabled, purge pending)
still serialize `{error}` through the same schema; **non-admin download** (ledger #23, spec story
18): POST `…/download` with an `overrideCatalogDigestSha256` body as a non-admin actor → rejected
by `assertAdminUser` (same status as Task 4's non-admin GET) with no `digestSha256` in the body —
fails if the override path or the 409 detail is reachable without authorization. Review
grep-asserts: `trustedKeys` is passed by no production caller — tests only (ledger #22; fails
structurally if the injection seam leaks into production wiring); `overrideCatalogDigestSha256`
producer sweep is Task 6's.

Verify: `pnpm test:unit tests/unit/module-distribution-pipeline.test.ts > /tmp/t5a.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`;
`pnpm test:integration tests/integration/module-registry.test.ts > /tmp/t5b.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`.

### Task 6: ensure-at-boot — test only (ledger #17)

First action: pick the assertion home between `tests/unit/module-reconcile-plan.test.ts` and
`tests/integration/module-reconcile-target-guard.test.ts` (whichever already drives the ensure
loop with an injected pipeline — round-4 carryover, stated here as the task's first step, not a
false-green risk). Test: ensure-download from an unverified catalog → the module is skipped, a
warn line's parsed JSON payload has a non-null error code/`failureReason` (never assert message
prose — round-4 medium-5), reconciliation runs to completion — fails if enforcement aborts boot or
the skip is silent. No production code change. Review grep-assert: `overrideCatalogDigestSha256`
has exactly two producers in the tree — the admin route body and the web client.

Verify: `pnpm test:unit <chosen-file> > /tmp/t6.log 2>&1; echo "EXIT=$?"` → `EXIT=0` (or the
`pnpm test:integration` form if the integration candidate is chosen).

### Task 7: web client + settings UI

`apps/web/src/api/client.ts` (ledger #2, #3):

- `readErrorBody` returns `{message, code?, digestSha256?}`; `ApiError` gains
  `readonly digestSha256?: string`; `requestJson` threads it through (:1360-1363).
- `downloadRegistryModule(id: string, version?: string, overrideCatalogDigestSha256?: string)` —
  the body includes the override field only when set.

`apps/web/src/settings/settings-module-registry-section.tsx`:

- Mutation input type += `overrideCatalogDigestSha256?`; `mutationFn` passes it (:140-148).
- Unverified banner (sibling of the :236-240 unavailable banner, shown when
  `data.catalogVerification === "unverified"`): the catalog is not verified — listed modules are
  not recognized by Moss.
- Row marker derived in the UI (ledger #20 — no per-row DTO field): when
  `data.catalogVerification === "unverified"`, every row carrying catalog data
  (`latestVersion !== null`) shows an "Unverified" marker.
- Download gating covers **both** Install and Update (ledger #20): `onInstall` (:180-190) is the
  single entry point for both actions; when `data.catalogVerification === "unverified"` it opens
  the override confirmation instead of the plain confirm — for not-installed and update-available
  rows alike. When `"unavailable"` no gating is needed: rows have no catalog entry, so no
  Install/Update action renders (current behavior, unchanged).
- Override confirmation: `confirm(…, {danger: true})` (purge precedent :203-214; no `requireText`
  — prior ruling), naming the module and the action (install vs update to the target version),
  stating **Moss did not authenticate this catalog** and **installing it may execute untrusted
  code after restart**; on accept, mutate with
  `overrideCatalogDigestSha256: data.catalogDigestSha256`. Not a generic dismissible warning.
- `onError`: when `error.code === "catalog-unverified"`, toast that the catalog changed and needs
  reviewing again (rendered from `error` fields only — determinism boundary) and invalidate the
  registry query so the fresh digest renders; otherwise the existing `readError` toast (:146-147).
- Nothing about the acceptance is stored anywhere (D5).

Tests — extend `tests/unit/settings-instance-modules-pane-render.test.tsx` (+ the dedup fixture,
ledger #14): an unverified fixture renders the banner and per-row markers; a verified fixture
renders neither — fails if the marker keys off the wrong field. An unverified fixture containing
BOTH a not-installed row and an update-available row asserts each download action routes to the
override confirmation copy, never the plain confirm — fails exactly on the ledger-#20 regression
(update path ungated). The 409-digest client passthrough is proven at the integration seam and
the live-path gate, not a unit fetch-mock.

Verify: `pnpm test:unit tests/unit/settings-instance-modules-pane-render.test.tsx > /tmp/t7.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`; root `pnpm typecheck > /tmp/tc7.log 2>&1; echo "EXIT=$?"` → `EXIT=0` (covers the
client.ts changes; `.tsx` tests are not typechecked — known caveat).

Phase-3 e2e: extend `tests/e2e/settings-modules.spec.ts` — unverified catalog renders banner +
gated Install AND gated Update actions; the override path reaches the confirmation copy; a mocked
409 yields the changed-digest toast. Builder confirms the repo's real e2e runner command from root
`package.json` at task start (never a `--filter` variant) and records it with the run. Scope
honesty (ledger #24): this spec is route-mocked — it proves rendering and flow wiring; the
server-side 409/override contract is proven at the integration route seam (Tasks 5/8) and the
live-path gate.

---

## Phase 4 — end-to-end + UAT + live proof

### Task 8: harness + UAT + live-path gate

- `tests/integration/module-distribution.e2e.test.ts`: with the Phase-2 signed-by-default mock,
  add route-level cases mirroring Task 5's matrix through the real HTTP route: verified install
  succeeds; missing/tampered/unknown-key signature → 409 and **no files staged** (assert the
  modules dir); exact-digest override installs; catalog changed between 409 and retry → fresh 409;
  artifact fingerprint mismatch stays blocked under a correct override. This seam — not the UAT
  container — is where the unverified/override matrix is exercised automatically (ledger #21).
- **Verified-path UAT is the existing spec, unchanged**:
  `tests/uat/specs/module-install.uat.spec.ts:51-56` installs the finance module through the real
  UI against the real — by then signed — GitHub catalog. Once the D9 merge gate is satisfied it
  passes via genuine verification with zero harness changes, and its run is recorded as the live
  verified-path proof (acceptance outcome 1) in the Phase-3 merge-gate evidence.
- **No mock-catalog UAT spec** — a decision, not an omission (ledger #21): the UAT stack runs
  `NODE_ENV=production` (provisioner.ts:205), where `JARVIS_MODULE_REGISTRY_URL` and the D6 test
  key are both hard-refused. Weakening either refusal to make a container test possible would
  create exactly the production bypass the spec scopes out. Acceptance outcomes 2–4
  (unverified blocked / deliberate exact-snapshot override / changed snapshot needs new consent)
  are proven automatically at the integration seam above and live at the live-path gate below.
- **Live-path gate** (process gate): on a live **dev** instance whose `NODE_ENV` is not
  `production` (builder verifies this at Task 8 start — Open Question 2; if the host-dev instance
  also runs production, stop and `needs-ben` rather than weaken a refusal), point
  `JARVIS_MODULE_REGISTRY_URL` at a local fixture registry serving signed, unsigned, and mutated
  catalogs, set `MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY`, and exercise through the real UI: verified
  install; unverified banner + blocked install AND blocked update; deliberate override of the
  exact snapshot; changed snapshot → fresh warning. Proof (screenshots + digests) recorded on the
  PR. Until then the honest status is code-complete, unverified.

Verify: `pnpm test:integration tests/integration/module-distribution.e2e.test.ts > /tmp/t8.log 2>&1; echo "EXIT=$?"`
→ `EXIT=0`; `tests/uat/specs/module-install.uat.spec.ts` via the repo's UAT runner (builder cites
the exact command from the UAT harness docs at task start) → pass, after the D9 gate; full gate
`pnpm verify:foundation` only via the `verify-gate` skill with an isolated DB → `EXIT=0`.

## Open questions (owners named — these are questions, not steps)

1. **Production public key value.** Ben generates the Ed25519 keypair offline, provides the SPKI
   public PEM + keyId for `MODULE_CATALOG_PUBLIC_KEYS`, and sets the two GitHub Actions secrets
   (base64-wrapping the private PEM if the kill-gate probe shows newline mangling). Owner: **Ben**
   — AWAITING-BEN entry + `needs-ben` ping when Phase 1 reaches the secret-dependent dispatch
   proof. Until then Phase-1 tests run on ephemeral in-test keys.
2. **Host-dev instance `NODE_ENV`.** The unverified-path live proof (Task 8) needs a live
   instance where the test seams are legal (`NODE_ENV !== "production"`). The UAT container is
   ruled out as fact (ledger #21: provisioner.ts:205); the host-dev instance is expected to
   qualify but was not verified this session. Owner: build agent — first action of Task 8; if the
   host-dev instance also runs production, `needs-ben` (never weaken the refusal).
3. **Task 6 assertion home.** Between the two named candidate files. Owner: build agent — first
   action of Task 6.

## Steelman of the rejected fork

Per-module artifact signatures were rejected. Their real advantage: a module's trust would survive
a catalog-key compromise, and third-party publishers could someday sign independently. But they
require a per-publisher identity/certificate scheme the spec explicitly scopes out, add a
verification point per artifact, and the catalog already binds every artifact by sha256+sizeBytes
— so signing the catalog authenticates all artifacts transitively with one key and one check. The
residual risk (a compromised catalog key signs a malicious catalog) is exactly what the pinned
keyring + rotation/compromise mechanism (D2) addresses. This fork was adjudicated in the approved
spec (Implementation Decisions, first bullet) — recorded here, not re-litigated.

## Review checklist (plan-build)

- [x] Spec approved (#1319 body, Ben 2026-08-17) and task issue open (#1319)
- [x] Every assumed capability cited `file:line`, or listed as an open question with an owner
- [x] No function bodies — signatures, schema deltas, workflow deltas, test cases only
- [x] Determinism boundary stated (no model involvement at all)
- [x] Each phase names its e2e test
- [x] Every verification command unpiped, with expected exit code
- [x] Kill gate named (post-Phase-1 CI signing proof; Coordinator owns the call)
- [x] Rejected fork steelmanned; adjudicated in the approved spec
