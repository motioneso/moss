# Relay — 1525-cli-runner-tombstone-fifo

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-C (lines
157-188 only — do not read the whole file).
**Plan:** `docs/superpowers/plans/2026-08-17-1525-cli-runner-tombstone-fifo.md` (approved by
coordinator).
**Issue:** #1525. **Worktree/branch:** this worktree, `1525-cli-runner-tombstone-fifo`.
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` each time (label is
routing only; session id is authority — do not trust any id baked into this doc, it goes stale).

## Done (committed, tree clean, rebased on origin/main)

- `0088688a8` — plan doc.
- `2a06e2290` — implementation + test:
  - `packages/cli-runner/src/engine-host.ts`: added `tombstoneOrder` per-session FIFO
    (`Map<string, string[]>`) + `MAX_SYNTHETIC_TOMBSTONES = 128` + `boundSyntheticTombstones()`
    helper called from `cancelSubmit`'s tombstone-creation branch; `tombstoneOrder.delete(key)`
    added at all three ledger-clearing sites (launch success, kill-with-engine,
    kill-without-engine).
  - `tests/unit/cli-runner-server.test.ts`: new test `"bounds synthetic tombstones to a 128 FIFO
    and never evicts a real submitted attempt"` — confirmed RED before the fix, GREEN after.
    25/25 tests pass in the file.
- Pre-push trio green: `pnpm format:check && pnpm lint && pnpm typecheck` all exit 0.
- `git fetch origin main && git rebase origin/main` — already up to date, no-op.
- Coordinator already approved this plan (session that approved: agent named
  `coordinator-take25`, msg exchanged before this relay — no need to re-approve).

## In flight — pick this up first

- Full isolated gate started via `scripts/run-gate.sh start`:
  - `db=jarvis_gate_1525_cli_runner_tombstone_fifo`
  - `LOG=/tmp/jarv1s-gate/1525_cli_runner_tombstone_fifo-20260817-110409.log`
  - Runs detached — survives this relay. **Poll with `scripts/run-gate.sh wait`** (blocks up to
    540s, call again if it returns 3/"still running"; give Bash a 600000ms timeout). Read the
    verdict with `scripts/run-gate.sh status` — exit 0 green, 1 gate failed, 2 died, 3 running.
    Never `pgrep`/`ps` for liveness (matches wrapper shells, always look alive).

## Next steps (in order)

1. `scripts/run-gate.sh wait` → `scripts/run-gate.sh status`. If red, debug via
   `superpowers:systematic-debugging` before proceeding — do not report done on red.
2. Push: `git push -u origin 1525-cli-runner-tombstone-fifo`.
3. Open PR: `gh pr create --base main --head 1525-cli-runner-tombstone-fifo --title
   "fix(#1525): bound cancel-only submit tombstones to a 128 FIFO" --body "..."` — body states
   scope (spec §1140-C), links the spec, states VF_EXIT from the gate, and states explicitly: **no
   live-path proof required — backend-only bounded-queue fix in
   `packages/cli-runner/src/engine-host.ts`, no user-facing UI surface** (per handoff doc, already
   confirmed with coordinator).
4. Report to coordinator via `herdr-pane-message` (resolve pane fresh by label `Coordinator`,
   confirm exactly one match): PR link, VF_EXIT=0, live-path n/a (backend-only, stated in PR body),
   branch pushed + rebased sha, gate DB `jarvis_gate_1525_cli_runner_tombstone_fifo` (teardown:
   `run-gate.sh` cleans its own DB unless `--keep-db` was passed — it wasn't), worktree reapable
   after coordinator reaps this lane. Then STOP — do not touch the board, do not close the issue,
   do not merge.

## Collision notes (unchanged from original handoff)

File-disjoint from every other lane in this wave. #1526 depends on this issue — do not start it;
coordinator spawns it after merge.

## Run-specific bans (unchanged)

Work only in this worktree/branch; `git add` by explicit path only; never touch
`docs/coordination/`, the board, milestones, or merge.
