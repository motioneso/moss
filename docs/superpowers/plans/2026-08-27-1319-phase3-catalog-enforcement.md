# Build plan — #1319 phase 3: refuse to install from an unverified module catalog

**Issue:** #1319 (`task`, `security`). Part of #1470.
**Spec:** the comment on #1319 whose first line is `SPEC` (2026-08-27). Long-form background:
`docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`.
**Branch:** `build-1319b-catalog-enforce`, based on `build/1319a-catalog-verify` (phase 2, open
PR #1897). Phase 1 is merged (PR #1684).

## What is already true (seams check, all cited on this branch)

| Capability the plan assumes                                                    | Evidence                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch reports verification + a digest of the exact catalog bytes               | `packages/module-registry/src/distribution/registry-source.ts:81-88` (`FetchRegistryIndexResult`), `:136-206`                                |
| `trustedKeys` can be injected into a fetch                                     | `packages/module-registry/src/distribution/registry-source.ts:75-79`, `:188`                                                                 |
| Pipeline fetches the catalog itself and has seven failure codes                | `packages/module-registry/src/distribution/pipeline.ts:24-31`, `:60-68`                                                                      |
| Pipeline accepts a pre-fetched catalog (the input to delete)                   | `packages/module-registry/src/distribution/pipeline.ts:48`                                                                                   |
| No production caller passes that input                                         | `grep -rn "downloadAndStageModule(" --include=*.ts .` → only `apps/api/src/module-distribution-port.ts:62` and tests; neither passes `index` |
| Failure code maps to HTTP status                                               | `packages/settings/src/routes-module-registry.ts:29-38`                                                                                      |
| Download route throws through a generic handler that cannot carry extra fields | `packages/settings/src/routes-module-registry.ts:137-139`                                                                                    |
| Request body schema rejects undeclared fields                                  | `packages/shared/src/platform-api-modules.ts:626-633` (`additionalProperties: false`)                                                        |
| Boot-time install warns and continues                                          | `scripts/module-reconcile.ts:268-292`                                                                                                        |
| Signed-catalog test fixtures already exist                                     | `tests/unit/module-distribution-pipeline.test.ts:90-119`, `tests/integration/module-distribution.e2e.test.ts:47`, `:203`, `:224`             |

Open questions: none. Every premise in the spec was re-checked against this branch and still holds.

## Determinism boundary

No model output anywhere on this path. Every message the user sees about a blocked install is
rendered from the pipeline's failure code and the catalog digest on the response record. No module
injects a chat turn. No AI is involved in this feature at all.

## Scope split

- **Phase A (this session):** the refusal itself — pipeline, port, route, shared contract, and the
  three server-side test suites. No screen work.
- **Phase B (one relay successor):** the screen — `apps/web/src/api/client.ts`,
  `apps/web/src/settings/settings-module-registry-section.tsx`, the two browser-side test files,
  and the live check on the dev instance.

**Kill gate after phase A, owner Ben:** if the enforcement turns out to block the real published
catalog — that is, the live catalog stops verifying against the key that ships in Moss — stop and
do not build phase B. The spec re-checked this on 2026-08-27 and it verified, so this is a guard,
not an expectation.

## Phase A — the refusal

### A1. Pipeline (`packages/module-registry/src/distribution/pipeline.ts`)

Contract changes:

```ts
export type ModuleDownloadErrorCode =
  | "index-unavailable"
  | "index-unverified"        // new
  | "module-not-found"
  | "download-failed"
  | "integrity-mismatch"
  | "extract-failed"
  | "manifest-invalid"
  | "version-mismatch";

export class ModuleDownloadError extends Error {
  constructor(
    readonly code: ModuleDownloadErrorCode,
    message: string,
    /** Set only for "index-unverified", and only when the catalog was fetched. */
    readonly catalogDigestSha256?: string
  );
}

export interface DownloadAndStageOptions {
  readonly moduleId: string;
  readonly version?: string;
  readonly modulesDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  /** Admin's deliberate acceptance of one exact catalog, by its SHA-256 digest. */
  readonly acceptedCatalogDigestSha256?: string;
  /** Test-only key injection, forwarded to fetchRegistryIndex. */
  readonly trustedKeys?: readonly ModuleCatalogPublicKey[];
}
```

- The `index?` input is **deleted**.
- Order inside `downloadAndStageModule`: fetch → if no index, `index-unavailable` (unchanged) →
  **signature check** → resolve → size → download → everything else unchanged.
- The signature check: when `verification !== "verified"`, throw `index-unverified` carrying the
  fetched digest, unless `acceptedCatalogDigestSha256` equals that digest. A mismatched acceptance
  throws `index-unverified` carrying the **newly fetched** digest, never the one the caller sent.
- Message text is product language: no key ids, no signature bytes, no network output.
- Everything after the check stays mandatory. Acceptance covers the signature only.

### A2. Port (`apps/api/src/module-distribution-port.ts`)

`download` takes `acceptedCatalogDigestSha256?: string` and forwards it. The failure branch returns
`catalogDigestSha256` when the error carries one. The `ModuleDistributionDependencies` type in
`packages/settings/src/*` gains the same two optional fields.

### A3. Shared contract (`packages/shared/src/platform-api-modules.ts`)

- `DownloadExternalModuleRequest` gains `readonly acceptedCatalogDigestSha256?: string`.
- The route schema's body gains the same property: `type: "string"`, `pattern: "^[0-9a-f]{64}$"`.
  Without this the field is rejected with a 400 before the route runs.
- A new 409 response schema — `message` required, `code` and `catalogDigestSha256` optional — used
  for the 409 slot only. The two existing 409s send a message alone and still serialise.

### A4. Route (`packages/settings/src/routes-module-registry.ts`)

- `DOWNLOAD_ERROR_STATUS["index-unverified"] = 409`.
- Pass `request.body?.acceptedCatalogDigestSha256` into the download call.
- Before the generic throw, an explicit branch: on `index-unverified`, reply 409 with message,
  code, and digest. Admin authorization already ran first (`loadLocalState`) and stays first.

### A5. Boot path (`scripts/module-reconcile.ts`)

The warn-and-continue behaviour already exists and needs no change (`:268-305`), so an unverified
catalog skips the module and boot completes on its own.

One small addition, and the reason for it: the spec's boot test asserts the failure **code** rather
than the wording, but today's warning record carries only `{ moduleId, phase, message }`
(`:54`, `:212-216`). So `code?: string` is added to that record and filled in from the download
error. It changes no behaviour, makes the boot test assert something stable instead of English
prose, and gives operators the code in the boot log.

### Tests for phase A

`tests/unit/module-distribution-pipeline.test.ts` — reuses the existing signed fixture:

1. Unverified catalog, no acceptance → fails with `index-unverified`, carries the digest, and the
   modules directory is untouched. _Fails if the check runs after any download or write, or if the
   digest is dropped._
2. Correct acceptance digest → installs normally. _Fails if acceptance is ignored._
3. Correct acceptance, but the artifact bytes do not match the catalog → still rejected with
   `integrity-mismatch`. _Fails if acceptance widens past the signature check._
4. Acceptance from an older catalog, catalog has changed → blocked again, error carries the **new**
   digest. _Fails if the error echoes the caller's digest._
5. Catalog could not be fetched at all, with an acceptance → `index-unavailable`, nothing installed.
   _Fails if acceptance is treated as a general bypass._
6. Verified catalog, no acceptance → installs, as today. _Fails if enforcement over-blocks._

`tests/integration/module-registry.test.ts`:

7. The 409 body really carries `code` and `catalogDigestSha256` over the wire. _Fails if the
   response schema strips them._
8. The other two 409s (distribution disabled, purge pending) still serialise their message.
9. A non-admin posting a download with an acceptance digest is refused by the admin check and the
   body contains no digest. _Fails if the acceptance path is reachable without admin._

`tests/integration/module-distribution.e2e.test.ts` — through the real HTTP route:

10. Verified install still succeeds.
11. Missing signature, tampered bytes, and unknown key each give 409 with **no files staged** —
    assert the modules directory.
12. Exact digest installs.
13. Catalog changes between the 409 and the retry → fresh 409 with the new digest.
14. Artifact bytes that do not match stay blocked even with a correct digest.
15. Boot-time install from an unverified catalog: module skipped, a warning recorded with a
    non-null failure code in its structured payload (assert the code, never the wording), and the
    rest of boot completes.

Commands, each run alone, nothing piped, expecting `EXIT=0`:

```bash
pnpm test:unit tests/unit/module-distribution-pipeline.test.ts > /tmp/1319-unit.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1319-tc.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1319-lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/1319-fmt.log 2>&1; echo "EXIT=$?"
```

The two integration suites touch a database and run only through the `verify-gate` skill against a
throwaway `jarvis_gate_*` database — never `pnpm verify:foundation` unscoped, which hits the live
dev database.

## Phase B — the screen (for the relay successor)

Files and behaviour are fully specified in the `SPEC` comment on #1319, step 4 and its test list.
Summary of the decisions so it is not re-litigated:

- `readErrorBody` and `ApiError` carry the digest; `downloadRegistryModule` takes an optional
  accepted digest and sends it only when set.
- A banner beside the existing "registry is unreachable" one, plus an "Unverified" marker per row,
  both derived from the single verification field on the response — no per-row API field.
- Installing and updating both go through `onInstall`, so one change gates both. When the catalog
  is unverified the confirmation is the deliberate, danger-styled one, naming the module and
  whether this is an install or an update to a specific version.
- Nothing about an acceptance is stored anywhere.
- Browser tests: `tests/unit/settings-instance-modules-pane-render.test.tsx` and
  `tests/e2e/settings-modules.spec.ts`. Confirm the browser-test command from the root
  `package.json` at the time — do not guess a variant.
- Phase 4 live check: the existing container test `tests/uat/specs/module-install.uat.spec.ts`
  proves a verified install still works. Do **not** add a container test for the unverified path —
  that stack runs in production mode, where the test registry URL and the test key are both
  refused, and weakening either would create the very bypass this issue exists to prevent. The
  unverified and acceptance cases are proved by the route tests plus a live run on the dev
  instance against a local fixture registry.

## Release note

User-facing. The pull request fills in the release-note section, then
`node scripts/append-release-note.mjs --pr <number>` runs on the branch and its change to
`docs/WHATS_NEW.md` is committed here.
