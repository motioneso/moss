# Relay handoff — #1319 phase 3 (branch `build-1319b-catalog-enforce`)

Plain English in everything a human reads. Pass that rule to anything you spawn.

## Where this stands

Phases 1 and 2 of this issue are already done elsewhere: the published module list is signed
(merged), and Moss already checks that signature when it fetches the list and reports the answer
plus a fingerprint of the exact list it read (open pull request #1897, all checks green, waiting on
Ben to merge). This branch sits on top of that work and adds phase 3: actually refusing to install.

**The server side of phase 3 is built and committed** at `c6ac03960`. Verified, not guessed:

- `pnpm test:unit tests/unit/module-distribution-pipeline.test.ts` - exit 0, 21 of 21 pass
- `pnpm typecheck` - exit 0
- `pnpm lint` - exit 0
- `pnpm format:check` - exit 0

Nothing is pushed yet and there is no pull request for this branch yet.

## The plan to work from

`docs/superpowers/plans/2026-08-27-1319-phase3-catalog-enforcement.md` (committed). It splits the
work into phase A (server side) and phase B (the screen). The full requirement is the comment on
issue #1319 whose first line is exactly `SPEC` - read it by section, not front to back.

## What is already built (phase A code)

An install now always fetches the list itself and checks the signature result before anything is
downloaded, extracted or written. If the list cannot be confirmed, it fails with a new code
`index-unverified` carrying the SHA-256 of the exact list bytes. An admin can pass
`acceptedCatalogDigestSha256` to accept one exact list; that waives the signature check and nothing
else, and a fingerprint that no longer matches the freshly fetched list is refused with the NEW
fingerprint reported. The route maps that code to HTTP 409 and replies on its own branch, because
the shared error path cannot carry the fingerprint. Both the request field and the 409 response
fields are declared in the shared schema. The boot loop already warned and carried on; its warning
record now also carries the failure code.

Files touched: `packages/module-registry/src/distribution/pipeline.ts`,
`apps/api/src/module-distribution-port.ts`, `packages/settings/src/routes-external-module-types.ts`,
`packages/settings/src/routes-module-registry.ts`, `packages/shared/src/platform-api-modules.ts`,
`scripts/module-reconcile.ts`, `tests/unit/module-distribution-pipeline.test.ts`.

## Do this next, in order

1. **Write the remaining phase A tests.** They are listed as cases 7 to 15 in the plan's "Tests for
   phase A" section, with the reason each one would catch a broken implementation. Cases 7 to 9 go
   in `tests/integration/module-registry.test.ts`, cases 10 to 15 in
   `tests/integration/module-distribution.e2e.test.ts`. That second file already has a mock registry
   that signs what it serves (`catalogTestKeypair`, around line 47 and line 203) - reuse it, do not
   build a new one.
2. **Both suites touch a database.** Run them only through the `verify-gate` skill against a
   throwaway database. Never run `pnpm verify:foundation` unscoped - it hits the live dev database.
   If a run fails with a missing `dist/app-map.json`, run `pnpm build:app-map` once first.
3. **Open the pull request for the server side.** Pre-push checks first, each on its own with
   nothing piped: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`. Then push and open a non-draft pull request
   and record it with
   `node /home/ben/jarv1s-fleet/fleetctl.mjs set 1319 status=pr-open pr=<number>`.
   Note in the pull request body that it builds on the phase 2 work in #1897.
4. **Fill in the release note section** of the pull request template, then run
   `node scripts/append-release-note.mjs --pr <number>` on this branch and commit the change it
   makes to `docs/WHATS_NEW.md`.
5. **Then hand phase B off, do not start it.** The screen work plus the live check on a real
   instance is a whole session on its own and this lane has already relayed once. After the pull
   request is open, run:
   `node /home/ben/jarv1s-fleet/fleetctl.mjs set 1319 status=blocked blocked_reason="needs re-slice: the server side of phase 3 is in a pull request; the settings screen (unverified banner, per-row marker, deliberate confirmation for both install and update) plus the live check on the dev instance is a separate session's work, described in phase B of docs/superpowers/plans/2026-08-27-1319-phase3-catalog-enforcement.md"`
   and stop.

## Traps and constraints

- This branch is based on the phase 2 branch, not on plain `main`. Do not rebase it onto `main` in
  a way that drops those commits.
- Other sessions share this checkout. Use the `shared-checkout` skill before any commit, commit by
  explicit file path, and never `git add -A`.
- Do not add a container test for the unverified path. That stack runs in production mode where
  both the test registry address and the test key are refused outright, and weakening either would
  create exactly the bypass this issue exists to prevent. The `SPEC` comment says so explicitly.
- Security-sensitive area: never put signing-library or cryptography error detail into a message a
  normal user or an external log could see.
- Do not touch the project board, milestones, coordination files, or merge anything. Never use
  :1533 - that is production.
