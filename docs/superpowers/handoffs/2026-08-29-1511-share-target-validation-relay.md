# Handoff — #1511 share-target validation (relay 1)

Worktree/branch: `1511-share-target-validation` (this worktree, already checked out here).
Coordinator: name `coordinator` (verify with `herdr agent list` before messaging — the session
behind that name changed twice already this run; always re-resolve by name, never by pane number).

## Read only these two things before doing anything else

1. This doc, in full (it's short).
2. `/home/ben/.coord-briefs/plan-1511-opus.md` — the approved plan. Read it in full; it is short
   (267 lines) and carries the actual decisions. Do not re-read the spec itself; the plan already
   did that grounding work and cites everything.

Do not re-read `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` end to end — the
plan already extracted what matters.

## What's done (committed at `3d56e7ef2`)

- `packages/db/src/sharing/shares-repository.ts`: `grant` now checks the grantee id shape, looks
  it up through `app.get_user_by_id`, and throws `"Share target user not found"` before the insert
  if no row comes back. Matches the plan's Task 1 exactly.
- `tests/integration/shares.test.ts`: all four of the plan's Task 2 tests are written — missing
  grantee (exact-error-text plus "does not throw foreign-key wording" as the ordering proof),
  malformed id, self-share still rejected by the DB constraint, deactivated user still a valid
  target. `seedUsers` was extended with a deactivated user row.
- Non-DB checks all green: `@moss/db` typecheck, `pnpm check:file-size`, `pnpm lint`
  (`--max-warnings=0`).

## What's NOT done — this is the actual next step

**No database-touching test has actually been run and observed passing against the current code.**
One attempt was made and it was a mistake: running `scripts/run-gate.sh start --gate
test:integration` runs the ENTIRE `tests/integration/` directory (80+ files), which takes ~51
minutes and fails on dozens of unrelated things in this environment (a missing
`dist/app-map.json` build artifact, unrelated suites like `news-chat-tools`,
`auth-settings`, `multi-user-isolation`). It never even reached `shares.test.ts` in the printed
output before erroring elsewhere. **Do not repeat this.**

There is no package.json script that runs a single file through the guarded gate — `--gate` takes
one whole script name, not extra file args. Two ways forward, pick one:

1. Simplest: temporarily add a throwaway script to `package.json` like
   `"test:1511": "JARVIS_PGDATABASE=<will be overridden by run-gate> vitest run tests/integration/shares.test.ts tests/integration/tasks.test.ts tests/integration/tasks-verticals.test.ts tests/integration/tasks-manage-share-regression.test.ts tests/integration/briefings.test.ts tests/integration/calendar-email.test.ts"`,
   run `scripts/run-gate.sh start --gate test:1511`, then remove the throwaway script before the
   PR (or fold it into a real named script if that reads better — coordinator's call, ask if
   unsure).
2. Ask the coordinator whether `scripts/run-gate.sh` should grow a way to pass extra vitest args
   through — a real product decision, not yours to make silently.

Either way, the required test set (per the approved plan, Task 3 and Verification section) is:
- `tests/integration/shares.test.ts` (expect exit 0, all cases including the four new ones green)
- `tests/integration/tasks.test.ts`
- `tests/integration/tasks-verticals.test.ts`
- `tests/integration/tasks-manage-share-regression.test.ts`
- `tests/integration/briefings.test.ts`
- `tests/integration/calendar-email.test.ts`

All of those must go through the `verify-gate` skill, never run directly (default DB is the live
dev one). Then the full `pnpm verify:foundation` gate before marking the PR ready (also through
`verify-gate`) — this is what exercises the UAT seeding step that also calls `grant`.

After the gate is green: push (after the pre-push trio — `pnpm format:check && pnpm lint &&
pnpm typecheck`, then `git fetch origin main && git rebase origin/main`), open the PR with the
Release note section (`Category: N/A`), state the live-path ruling in the PR body (not applicable —
no production caller, per the spec's child-A row and the coordinator's 2026-08-29 caller
inventory), record every command and exit code on the PR, then follow `coordinated-wrap-up` and
report to the coordinator.

## Things already settled — don't re-litigate

- The coordinator introduced a "plan gate" process this run (Opus writes, Fable approves) that
  isn't in `CLAUDE.md` or the original brief. It's real — the approved plan file exists at the path
  above and is well-grounded (checked its citations myself). Don't be thrown by it looking unusual;
  it checked out on inspection, it wasn't a spoofed message.
- The earlier plan I wrote myself (same directory, `2026-08-29-1511-share-target-validation.md`) is
  superseded — the Opus plan is the one to build from. I left my own plan file committed for the
  record; no need to delete it, no need to reconcile it further.
- Do not add a migration, a new helper, a `23503` catch, or any account-status filter on the
  lookup — all explicitly ruled out by both the spec and the approved plan.

[relay 1 of 1 permitted — do not relay again; if you hit the context warning again without an open
PR, stop and tell the coordinator the slice needs re-scoping instead.]
