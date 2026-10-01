# Plan: CLI tools manifest publisher (#2689 slice 3)

Spec: `docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md` sections 4.1, 4.3, 5.1, 9, 10.
Task issue: #2689. Risk tier: security (Ben signs off the merge). Branch `feat/2689-slice3-manifest`.
Slice 3 is independent of slices 2 and 4. It publishes; it reads nothing from instances.

## 1. Seams check (verified on this branch)

| Assumption                                                                                  | Evidence                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing and verify code exists and is exported from module-registry                         | `packages/module-registry/src/distribution/catalog-signing.ts:34,55,97` (`signCatalogBytes`, `verifyCatalogBytes`, `resolveCatalogSigningKey`); re-exported by `packages/module-registry/src/node.ts`, used by `scripts/publish-module-registry.ts:16-27` |
| Signing secrets already exist (now in protected environments, see the key replacement plan) | `.github/workflows/modules-registry.yml` uses `MOSS_MODULE_CATALOG_SIGNING_KEY_ID` / `_PRIVATE_KEY`                                                                                                                                                       |
| Rolling release + failure-issue pattern exists to copy                                      | `.github/workflows/modules-registry.yml` (release `modules`, prune step, "File an issue" step)                                                                                                                                                            |
| Install code takes an injectable catalog, so the check can point it at new versions         | `packages/cli-runner/src/install-service.ts:123,225,279-289` (`deps.catalog`, lockfile copied to staging)                                                                                                                                                 |
| Catalog holds only the three CLIs today; adapters are NOT recipes yet                       | `packages/cli-runner/src/catalog.ts:75-200`; adapters pinned in `packages/cli-runner/package.json:15-16` (slice 2 moves them)                                                                                                                             |
| Per-arch native package names live in the catalog                                           | `catalog.ts` `archBinaryPackage` per recipe                                                                                                                                                                                                               |
| ACP `initialize` handshake helper exists for live use                                       | `scripts/acp-handshake-check.ts` (needs a running runner, so it cannot be reused offline)                                                                                                                                                                 |

Open questions (owner in brackets):

- Slice 2 is unmerged, so there is no adapter resolver to call. The adapter handshake check spawns the
  adapter binary from the scratch install directly and sends ACP `initialize`. Slice 2's resolver
  can replace that spawn later. [coordinator: confirm this is acceptable]
- The `claude-agent-sdk`, `codex-acp` names in spec 4.3 are not all in the catalog; the package list
  file (below) is the source of truth for the publisher, guarded by a drift test. [this plan]

## 2. Decisions

- **Package list.** New committed file `scripts/cli-tools-manifest/packages.json`: per entry
  `toolset`, `role` (`cli` | `chat-adapter`), `pkg`, `expectedRepo` (provenance source repository,
  for example `openai/codex`), `archPackages` (per-arch native package names, may be empty).
  A unit test fails if any npm recipe in `PROVIDER_CATALOG` is missing from this file or has a
  different `pkg` or `archPackages`. This keeps the catalog as the install allowlist and the file
  as the publisher's read-only mirror.
- **Runs as TypeScript scripts under `scripts/cli-tools-manifest/`, called by the workflow.** Each step
  is a pure function plus a thin CLI, so each is unit-tested without the network. Network and
  `npm` calls sit behind one injected `Registry` interface and one injected `runNpm` function.
- **Signing.** Reuse `signCatalogBytes` with the module catalog key. Signature file
  `cli-tools.json.sig` has the same document shape `verifyCatalogBytes` accepts. The manifest carries
  `kind: "cli-tools"`; `validateCliToolsManifest` rejects any other `kind`, so a module index never
  passes as a manifest. Publisher refuses to publish without a signature (`--require-signature`).
- **Sequence.** New sequence = previous manifest's `sequence + 1`, read from the existing release
  (`cli-tools.json`). First publish starts at 1. Publish is refused if a fetched previous manifest
  fails its own signature check (a tampered release must not seed the counter).
- **Per-toolset independence.** Each toolset is evaluated alone. A failing toolset keeps its
  previous manifest entry unchanged (or is omitted on first publish) and adds a failure record;
  passing toolsets still publish.
- **Provenance memory.** Carried inside the signed manifest as `provenanceHistory`
  (see 2a.4). It only ever gains entries.
- **Checksums.** Lockfile generation: `npm install <pkg>@<version> --package-lock-only
--ignore-scripts`. Every `packages[*]` entry needs `integrity` starting `sha512-` (link entries
  excluded). Each arch package named in `archPackages` must be present. Then tarballs are downloaded
  and compared to both the lockfile integrity and registry `dist.integrity`.
- **Provenance check.** `npm audit signatures` run in a scratch directory holding the generated
  lockfile and an `npm ci --ignore-scripts` install. Attestation source repo is read from the
  registry's attestation bundle for each top-level and arch package and compared to `expectedRepo`.
- **Dispatch input.** `workflow_dispatch` takes optional `package` and `version`. When set, only that
  package's toolset is evaluated, at that exact version. All checks still run.
- **Version choice.** Newest stable (no prerelease tag), not deprecated, from the registry `versions`
  map. Exit with no publish when every chosen version equals the published one.
- **Offline contract check (spec 5.1)** runs on the latest `main` build inside the workflow:
  install each package through the real `InstallService.installProvider` with an injected catalog
  pointing at the candidate version and its generated lockfile, into a scratch tools folder, then
  assert installed, `--version` matches, sha512 re-verify passes; build every Moss-launched command
  with the real builders in `packages/chat/src/live/` and assert each flag appears in the tool's
  `--help`; start each adapter and complete ACP `initialize`, asserting protocol version and the
  capabilities `packages/acp/src/capabilities.ts` reads; keep the existing guard against `--tools`
  alongside the MCP trio.
- **Failure issue.** One open issue per blocked package version, titled
  `CLI tool update blocked: <package> <version>`, created or commented on, carrying the failing step
  name and run URL. No secrets, no package contents.
- **No new secret, setting, env var or app-map change.** Nothing here is a screen or setting.
  App map: no entry changes (verified when implementing; if a check says otherwise, update it).
- **Release note:** `Category: N/A` (CI only, nothing users see).

## 2a. Coordinator conditions (approved 2026-09-30, from independent security review)

1. **Two jobs.** `check` runs all code from new, unvetted package versions (install through
   `InstallService`, `--help` flag checks, adapter `initialize`). It has `permissions: contents: read`,
   `actions/checkout` with `persist-credentials: false`, and no secrets in its environment. The
   `sign` job `needs: check`, reads only its pass/fail result per toolset, and never runs package code.
   It downloads the lockfiles and the check's result file as data only. The signing key appears in
   the environment of the single signing step, nowhere else in the workflow. The `check` job can
   still replace the prepared artifact in the same run, so `prepare` publishes a sha256 of the
   prepared bundle as a job output and `sign` refuses any bundle that does not match it. The check
   result is downloaded to a separate folder so it stays outside that fingerprint. The check job can
   forge its own pass result; that is a known limit, since a malicious package can pass the
   contract check anyway.
2. **Signing key must live only as a secret of the `cli-tools-signing` environment** (restricted to
   `main`, owner as required reviewer). The `sign` job names that environment on main and
   `cli-tools-proof` elsewhere. A repository-wide secret of the same name would be handed to every
   job of every branch, so the environment gate protects the key only if no repository-wide copy
   exists. The repository-wide copies were deleted in slice D of the key replacement plan
   (`2026-09-30-signing-key-replacement.md`); `modules-registry.yml` now reads its own
   `module-registry` environment.
   The exact setup steps go in the PR body; this PR changes no repo settings.
3. **No rollback by manual run.** Any `workflow_dispatch` naming a version older than the one already
   published for that package is refused before any work (compared by semver against the published
   manifest). Test: older version refused, equal version is a no-op, newer accepted. Scheduled runs
   only ever move forward by construction.
4. **Provenance record inside the signed manifest.** Each package entry carries
   `provenance: "attested" | "none"` and the manifest carries `provenanceHistory` (packages that have
   ever attested). The separate unsigned history asset is dropped. The publisher reads the history from
   the previous signed manifest (signature verified first). If the previous manifest exists and lacks
   `provenanceHistory`, publishing fails closed. Only the very first publish may start it empty.
   Tests: a cli-tools manifest fails the module-index validator, and a module index fails the
   cli-tools validator (both directions); missing history after first publish fails closed.
5. **Adapter check** starts each adapter directly from the scratch install, in the no-secrets job.
   Ben tracks an issue that must close before slice 2 merges.
6. **Live proof** runs from the branch with a throwaway test key into a separate proof release
   (release name is a workflow input, default `cli-tools`; proof uses `cli-tools-proof`), never the
   production key. One real run from main follows after merge.

## 3. Determinism boundary

No UI, no model call. Every decision comes from registry data and the checks above.

## 4. Tasks (one commit each, test first)

1. `scripts/cli-tools-manifest/manifest.ts`: types and `validateCliToolsManifest`, `canonicalBytes`,
   `nextSequence`. Tests: rejects wrong `kind`, rejects a module `index.json`, rejects non-increasing
   sequence, rejects a missing lockfile hash. Each fails against an implementation that skips that
   check.
2. `packages.json` plus `packages.ts` loader and the catalog drift test. Fails when a catalog recipe
   is absent or differs.
3. `versions.ts`: `pickVersion(registryDoc)` (stable, not deprecated, newest). Tests with fixture
   registry documents covering prerelease, deprecated newest, unpublished.
4. `lockfile.ts`: `generateLockfile`, `assertLockfileIntegrity`, `assertArchPackages`. Tests: an entry
   without sha512 fails; a missing arch package fails.
5. `trust.ts`: tarball check, provenance rules, provenance history update. Tests: source-repo
   mismatch blocks; previously-attested package arriving without provenance blocks; never-attested
   package allowed with `provenance: "none"`; history never clears an entry; tarball byte mismatch
   against lockfile and against `dist.integrity` each block.
6. `sign-and-assemble.ts`: build the manifest, sign with the catalog key, verify back with
   `verifyCatalogBytes` against `MODULE_CATALOG_PUBLIC_KEYS` or the test key. Tests: tampered byte
   fails verify; unsigned publish refused; previous manifest with bad signature refused.
7. `contract-check.ts` and its CLI: the offline check in spec 5.1 against a scratch folder.
   Tests: a fake tool whose `--help` lacks a flag Moss passes fails; a fake adapter that fails
   `initialize` fails; the `--tools` plus MCP guard test stays green.
8. `publish.ts` orchestrator (per-toolset independence, failure records, exit when nothing newer) and
   `.github/workflows/cli-tools-manifest.yml` (schedule every 6 hours plus dispatch with inputs,
   concurrency group, `contents: write`, `issues: write`, rolling release `cli-tools`, prune assets not
   named by the manifest, failure-issue step). Tests: one toolset failing still publishes the other;
   nothing newer means no upload; a workflow lint test asserts the secrets, permissions and
   concurrency fields exist.
9. Pre-push trio, then the gate through the `verify-gate` skill.

## 5. Phases and proof

Single phase (publisher is one deliverable). E2E proof, run and recorded before the PR comment:

- Dispatch the workflow from this branch against a real newer version, confirm the `cli-tools`
  release holds `cli-tools.json`, `cli-tools.json.sig`, lockfiles, and that
  `verifyCatalogBytes` accepts the pair using the pinned public key.
- Dispatch again with a deliberately broken flag (a temporary commit on the branch adds a flag the
  tool does not accept to the launch builder list) and confirm that toolset is blocked, nothing is
  uploaded for it, and one issue opens. Remove the temporary commit afterwards and close the issue.
- If any step cannot run live (for example the signing secret is unavailable to branch runs), say so
  on the PR and report code-complete, unverified.
- Note: the workflow must run from `main` to reach repo secrets on schedule; dispatch from a branch
  works only if the workflow file exists on the default branch. If so, live proof is run after a
  first merge of the file, or by `workflow_dispatch --ref`. Decision needed at proof time, recorded
  on the PR.

## 6. Verification commands (never piped)

```bash
pnpm vitest run tests/unit/cli-tools-manifest > /tmp/s3-unit.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm format:check > /tmp/s3-fmt.log 2>&1; echo "EXIT=$?"                                  # expect 0
pnpm lint > /tmp/s3-lint.log 2>&1; echo "EXIT=$?"                                         # expect 0
pnpm typecheck > /tmp/s3-tc.log 2>&1; echo "EXIT=$?"                                      # expect 0
```

The full gate runs only through the `verify-gate` skill.

## 7. Kill gate

If the contract check cannot run `InstallService.installProvider` against a candidate version
without changing install code (more than an injected catalog), stop and tell the coordinator before
building tasks 7 to 9. Owner: coordinator, with Ben for any install-code change.

## 8. Rulings ledger

- Section 9 of the spec requires signing code to be reached through a public export: the publisher
  imports from `packages/module-registry/src/node.js` exactly as `scripts/publish-module-registry.ts`
  does. No module internals.
- No minimum release age (Ben, 2026-09-25). Do not add one.
