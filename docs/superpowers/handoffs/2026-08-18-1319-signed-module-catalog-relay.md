# Relay: #1319 Signed Moss Module Catalog (relay #3)

- **Issue:** #1319, risk tier `security`. Approved by Ben 2026-08-17.
- **Branch/worktree:** `build-1319-signed-module-catalog` (this worktree). Clean tree, **zero
  commits, zero plan file, across all three relays.**
- **Coordinator — STILL UNRESOLVED, run `herdr pane list` FRESH before messaging.** Relay #2 never
  got to this step either. Last known state (2026-08-18, now stale): two panes held `Coordinator` —
  `3e71acd4-1b49-4a73-8c0d-9adf1e41c447` (`agent_status:"done"`) and
  `0af0d87c-2a93-4ced-9b55-56dbdfafd9fe` (`agent_status:"working"`, title "Boot coordinator take45
  brief"). **Do not message either id from memory — resolve fresh by label, confirm exactly one
  live `Coordinator`-labeled pane, only then message it** (0 or >1 matches = halt, don't guess).
- **Skill to resume under:** `coordinated-build`, step 1 (plan). Step ½ (spec-vs-branch
  verification) is DONE.

## What changed since relay #2

Nothing code-side. Relay #2 spent its budget re-verifying the spec (fetched and read the full
GitHub issue #1319 body, all 99 lines, via `gh api repos/motioneso/moss/issues/1319 --jq .body`)
and hit the context-meter 70% relay trigger immediately after, before drafting the plan. **Spec
confirmed with zero drift against the seam map below — this is the last spec/seam read this lane
needs.** Do not re-fetch the issue or re-read the two agentmemory decision memories; both are
already fully captured between this doc and the previous one's seam map (unchanged, reproduced
below). Go straight to drafting.

## Durable state — the seam map (unchanged from relay #2, do not re-derive)

Both memories (`mem_msy75bdj_94916a3aab69`, `mem_msy7avet_7aa9c3da101b` in agentmemory project
`jarv1s`) gave exact file:line insertion points for all 8 work items — reproduced here so this
relay is self-contained and nobody needs to re-recall:

1. **Ed25519 keyring module (new).** `packages/db/src/keyring.ts` is a shape-only rotation
   precedent, NOT reusable code — the asymmetric verify side only needs a public-key map (key id →
   public key), pinned in Moss, current+next overlap per spec's rotation decision.
2. **Publish-time sign+self-verify.** `publish-module-registry.ts:150-153`, insert between the
   existing self-check and `writeFileSync`. Generate catalog bytes once, sign those exact bytes,
   verify inside the publish job before upload; fail the build if the key is missing, signing
   fails, or self-verify fails. New GH Actions secret in `modules-registry.yml` (module-catalog
   release workflow only — never repo, release assets, image, logs, config). Also fix the
   prune-keep-list at line ~56 to retain the new `.sig` asset.
3. **Fetch-time verify + cache reshape.** `registry-source.ts` `fetchRegistryIndex()` (line 60):
   verify signature over raw catalog bytes before parsing/trusting. Cache reshape in
   `module-distribution-port.ts`'s `registryCache` (line ~39-50): bytes/digest, verification state,
   and parsed entries must travel together as one atomic snapshot — never pair state from one
   fetch with entries from another.
4. **DTO/schema/derive verification field.** `platform-api-modules.ts` `ModuleRegistryRowDto` +
   schema (lines 415-497): add `verified | unverified | unavailable` + SHA-256 digest of the exact
   fetched snapshot. `routes.ts` `ModuleDistributionDependencies.fetchRegistryEntries` (lines
   156-179).
5. **Admin-route 409/override contract.** `routes-module-registry.ts` download route (lines
   114-166), insert between the priorStates check (line 128) and `dist.download()` (line 133).
   Normal request on an unverified catalog → conflict response with safe reason + current digest,
   no staging. Override = second request carrying the exact digest accepted; admin-only, one
   attempt, never persisted; digest mismatch → reject, require fresh warning+confirmation. Override
   bypasses catalog-signature verification ONLY — fingerprint/host-pin/extraction/manifest/id-version
   /compatibility/staging/drift/enablement checks stay mandatory; a fingerprint mismatch is always
   rejected even under a valid override.
6. **`module-reconcile.ts` fail-closed, no override.** Phase-3 (lines 254-305), mirrors the existing
   warn-and-continue pattern at 300-304: non-interactive ensure-at-boot has no bypass channel —
   unverified catalog → bounded warning, skip the download, continue the rest of boot. Already
   installed local modules keep their existing enablement/drift rules regardless.
7. **UI verified/unverified/override-confirm surface.** `settings-module-registry-section.tsx`:
   banner parallel to the existing `registryUnavailable` banner (line 236-240); override
   confirmation dialog chained off the existing download-confirm flow (line 180-190) — must name
   the target module, state Moss did not authenticate the catalog, state installing may execute
   untrusted code after restart; no generic dismissible warning.
8. **UAT spec + e2e mock-registry extension.** New UAT spec + a row in
   `.claude/skills/coordinate/uat-trigger-map.tsv`. Extend `module-distribution.e2e.test.ts`'s mock
   registry (serves `/index.json` at line 124, listens line 178) to also serve/omit/corrupt a
   signature asset, covering: verified install succeeds; missing/malformed/unknown-key/wrong
   signature → unverified + blocked, no staging; override succeeds only on matching digest +
   fingerprint; catalog change between warning and retry invalidates the ack (fresh conflict, not
   install); artifact mismatch blocked even under override; safe-extraction/manifest/compat/host-pin
   /size-cap checks unchanged under override; direct-API and UI paths share the same policy incl.
   admin-authz-before-verification-details; refresh/cache never mixes snapshots; ensure-at-boot
   skips + warns + continues; publish-seam: deterministic bytes → verifiable sig, absent key fails
   build, altered bytes fail verify; rotation accepts current+next, rejects unknown/retired.
   Reuse the existing module-distribution pipeline/publisher/index-schema/e2e suites as prior art —
   no new test framework.

## Spec decisions that shape task boundaries (confirmed this relay, full issue body read)

- Trust object is the **catalog**, not per-module signatures — one signature authenticates every
  listed artifact's existing fingerprint. No individual module signing identity (out of scope).
- Detached signature metadata asset beside the catalog: format version, algorithm, key id, base64
  signature, covering exact UTF-8 published bytes.
- Product terms: **"recognized by Moss"** / **"verified catalog module"** — never imply the module
  is safe/sandboxed/audited; signing proves provenance + byte identity only.
- No new package/signing service — extend the existing publisher, registry fetcher, distribution
  pipeline, shared admin contracts, module-management UI at current seams.
- Rollout: publish signed catalog + signature before enforcement ships; old Moss versions keep
  working unmodified; enforcing versions verify immediately. **No DB migration, no unsigned
  transition mode** (confirms existing reminder below).
- Out of scope (do not build): per-module sigs, web-of-trust/certs/third-party registries, safety
  claims about module code, runtime behavior changes, any bypass on fingerprint/archive/manifest
  /compat/host/size, a permanent "allow unsigned" setting, retroactive disabling of installed
  modules on catalog trouble.

Full verbatim text if ever needed again: `gh api repos/motioneso/moss/issues/1319 --jq .body`
(cheap, 99 lines — but the bullets above are the complete decision set; re-fetching should not be
necessary to draft the plan).

## Next concrete step — successor's FIRST action, no more reading

1. Draft `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md` via `plan-build`,
   covering all 8 items above against the spec decisions above. Decisions/contracts only — no
   function bodies (signatures, DDL/schema shapes, manifest JSON, test cases stated as
   behavior-plus-why-it-fails, unpiped verification commands with expected exit codes). State the
   determinism boundary (this touches admin UI: banner + override dialog render from the record,
   never from a model). Name a kill gate + owner after phase 1. Run the plan-build review checklist
   before calling it ready.
2. Resolve the Coordinator pane fresh (`herdr pane list`, exactly one `Coordinator`-labeled live
   pane) and message it with the plan path via `herdr-pane-message`. **STOP and wait for approval
   before writing any code.**
3. On approval: build task-by-task via `superpowers:test-driven-development`, commit green per
   task (`Co-Authored-By: Claude` trailer, task-scoped `git add`), pre-push trio
   (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main && git rebase
   origin/main` before every push, `coordinated-wrap-up` at the end (gate on isolated DB per
   `verify-gate` skill, live-path proof since this touches admin UI).

## Reminders for whoever resumes

- No DB migration for #1319 (spec explicitly out-of-scope) — do NOT claim 0185 (reserved for #1586).
- Collision zone with #1586 (not urgent, #1586 hasn't started building): `apps/api/src/server.ts`
  ~L459/L485, `packages/settings/src/routes.ts` ~L994/L1000, `platform-api.ts` barrel.
- Relay trigger is the context-meter 70% warning for everyone — you have a fresh full budget now.
  **Draft the plan first, before any further reading.** Three relays in a row have now spent their
  entire budget on reading/re-verifying and hit the trigger before writing the plan file — that
  loop must break here. If it fires again before the plan is drafted, still relay, but flag in the
  next doc that this is now a pattern worth escalating to the coordinator directly rather than
  repeating silently.
