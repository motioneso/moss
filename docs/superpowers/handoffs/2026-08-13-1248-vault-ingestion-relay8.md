# #1248 vault-ingestion — relay8 continuation

PR #1606, branch `1248-vault-ingestion`, this worktree. QA verdict (RED, 4 blocking findings):
https://github.com/motioneso/moss/pull/1606#issuecomment-5284804690

Coordinator label: **Coordinator** — resolve fresh via `herdr pane list` (label + `agent_session.value`),
never a `…-N` number from this doc.

## Done (all 4 findings' code-level work complete)

1. Rebased onto `origin/main` clean, zero conflicts (contrary to expectation) — `pnpm --filter
   @moss/module-registry typecheck` passed on the touched file.
2. `normalizeRoot`/`isPathIngestable` fixed in `packages/memory/src/vault-ingest-registry.ts` —
   collapses `..`/`.` via `path.posix.normalize`, rejects escapes. Fixed a broader unpatched
   variant too (candidate path wasn't normalized, only the root was). Unit test added, 10/10 green.
   Commit `59603a762`.
3. Integration-level non-allowlisted-path test added to
   `tests/integration/vault-ingest-jobs.test.ts` (exercises the real `runVaultIngestSweep`, not
   just the predicate). Commit `b27199a42`.

## Resolved false blocker — read before re-investigating

`pnpm --filter @moss/memory typecheck` (and `@moss/people`, confirmed on an unmodified tree) fails
with TS6059 rootDir errors. **This is a pre-existing, repo-wide false-negative of per-package
`--filter typecheck`, not a real break** — confirmed via `pnpm typecheck` at repo root: fully
green (EXIT=0), including `@moss/web typecheck` and `check:external-modules`. Full writeup saved
to agentmemory + `~/.claude/.../memory/pnpm-filter-typecheck-tsrootdir-false-red.md`. **Never
diagnose typecheck via `--filter <pkg>` alone in this repo — always cross-check root `pnpm
typecheck`.**

## In flight when I relayed

Gate run started in background just before the 70% checkpoint:
```
GATEDB=jarvis_gate_1248vault  (already created)
export JARVIS_PGDATABASE=jarvis_gate_1248vault
pnpm verify:foundation > /tmp/gate-1248vault.log 2>&1
```
**Check `/tmp/gate-1248vault.log` first** — grep for `### FINAL rc=`. If it's not there yet or the
pane/process is gone (background jobs don't survive a relay), just re-run it fresh per the
`verify-gate` skill (DROP+CREATE `jarvis_gate_1248vault` again, don't reuse — a reused gate DB
carries stale migration state).

## What's left, in order

1. Confirm/rerun the gate green (see above).
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (root-level, not filtered) +
   `git fetch origin main && git rebase origin/main` (should be a no-op rebase, already current).
3. Push.
4. Run the 2 blocking UAT specs on a **live dev instance** (not headless):
   - `tests/uat/specs/1217-uat-vault-ownership.uat.spec.ts`
   - `tests/uat/specs/module-install.uat.spec.ts`
   Post run output + screenshots as a PR #1606 comment (`coordinated-wrap-up` skill § "Live-path
   proof" format).
5. Message the Coordinator (label "Coordinator", re-resolve fresh): new HEAD sha + proof-comment
   link, ready for re-QA. **Never merge/board/close yourself.**

Also at your discretion (non-blocking): the QA verdict comment has 8 non-blocking notes, not yet
read/actioned.

## Explicitly NOT your job

- `chat-drawer-surface.test.tsx` CI flake, tracked as #1607 — someone else's, escalated to Fable
  via the Coordinator already. Don't re-investigate.

## Worktree / branch

- This directory, branch `1248-vault-ingestion`. `node_modules` already installed — do not
  `pnpm install`.
