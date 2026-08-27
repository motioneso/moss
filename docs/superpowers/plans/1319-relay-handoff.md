# Relay handoff — #1319 phase 3 (branch `build-1319b-catalog-enforce`)

Plain English in everything a human reads. Pass that rule to anything you spawn.

## Phase A is finished. Do not redo it.

The server side of phase 3 is built, tested and open as **pull request #2034**, stacked on the
phase 2 pull request #1897 (base branch `build/1319a-catalog-verify`, not main). If you are a
fresh session in this worktree, there is nothing left to build here.

Verified, not guessed:

- `pnpm test:unit tests/unit/module-distribution-pipeline.test.ts` — exit 0, 21 of 21 pass
- `pnpm test:integration tests/integration/module-registry.test.ts tests/integration/module-distribution.e2e.test.ts`
  — exit 0, 36 of 36 pass (run against a throwaway database through the `verify-gate` skill)
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` — all exit 0
- Negative check: with the refusal removed from the install path, 5 of the new end-to-end cases
  go red. They prove the rule rather than passing by accident.
- The real published module list and its signature were fetched and checked against the key that
  ships in the app: verified. So this change does not break a real install. Evidence is posted as
  a comment on pull request #2034.
- Release note: the change is not user-visible on its own, so Category is N/A and
  `docs/WHATS_NEW.md` is untouched (the script confirms there is nothing to append).

## What is left: phase B, the screen

Phase B is a separate session's work and is described in
`docs/superpowers/plans/2026-08-27-1319-phase3-catalog-enforcement.md`. In short: the warning
banner when the list cannot be confirmed, the marker on each row, a deliberate confirmation for
both install and update, and the check on a live dev instance. The live-path proof belongs with
that work, because that is where the screen it proves lives.

## Traps that still apply

- This branch is based on the phase 2 branch, not on plain `main`. Do not rebase it onto `main`
  in a way that drops those commits, and do not retarget the pull request by hand — once #1897
  merges, GitHub retargets it.
- Other sessions share this checkout. Use the `shared-checkout` skill before any commit, commit
  by explicit file path, and never `git add -A`.
- Do not add a container test for the refused path. That stack runs in production mode where both
  the test registry address and the test key are refused outright, and weakening either one would
  create exactly the hole this issue exists to close. The `SPEC` comment on issue #1319 says so.
- Security-sensitive area: never put signing-library or cryptography detail into a message a
  normal user or an external log could see. There is a test asserting the refusal wording stays
  plain.
- Do not touch the project board, milestones, coordination files, or merge anything. Never use
  :1533 — that is production.
