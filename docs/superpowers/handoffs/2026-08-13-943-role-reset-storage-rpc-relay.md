# Relay — #943 role-reset-storage-rpc (relay 2)

**Issue:** #943 (spec = issue body, no separate spec doc). **Risk tier:** security.
**Branch/worktree:** `943-role-reset-storage-rpc`, same path (this worktree). Tree clean, HEAD is
the fix commit below.
**Coordinator:** label `Coordinator`, session id `caef4e32-df22-4310-a42d-866771a0ba6c` —
re-resolve fresh via `herdr pane list` (label + session id), don't trust a `…-N` pane number from
this doc.

## Done

- Plan approved by Fable **with one required correction** (seams-check caller inventory was false —
  claimed no caller continues in-transaction after `query()`; actually two: a live caller at
  `worker-rpc-host.ts:314` safe today only because it returns immediately, and an unwired future
  caller `data-export.ts:190` `readExternalModuleExportRows` that loops multiple tables in one
  shared transaction). Correction applied and committed: `c635956e9`.
- TDD-built both tasks, each its own commit:
  - `d1f1452f2` — new regression test in `tests/integration/module-storage-rpc.test.ts`
    (`"binds the runtime role during the call and resets it after"`). Confirmed **red** against the
    unfixed file first (isolated gate DB `jarvis_gate_943`).
  - `e466401bd` — the fix itself: `RESET ROLE` added inside `module-storage-rpc.ts`'s existing
    `finally` block, own try/catch, same pattern as the pre-existing `statement_timeout` reset.
    Confirmed **green**: all 10 tests in the file pass (isolated gate DB `jarvis_gate_943`).
- Gate DB `jarvis_gate_943` still exists (created, used twice, **not yet dropped** — successor's job
  per `verify-gate`: `DROP DATABASE IF EXISTS jarvis_gate_943;` when done with it, or reuse+redrop
  at wrap-up).
- Relayed per coordinated-build step 3 (context-meter 70% warning, zero compaction seen yet at
  relay time) — message sent to coordinator confirming the two commits and TDD proof.

## Not done — successor picks up here

1. **Pre-push trio**: `pnpm format:check && pnpm lint && pnpm typecheck`. NOT yet run to
   completion — prior attempt botched background/redirect scripting (see note below) and was
   killed; no red/green result exists. Use the `verify-gate` skill's safe backgrounding pattern
   (fully parenthesize the whole group, redirect the group not the last command, sentinel echo
   inside the redirect, poll via `Monitor`'s `until grep -q sentinel; do sleep 2; done` — do not
   improvise ad hoc `&`/`disown`).
2. `git fetch origin main && git rebase origin/main` — branch was 1 commit behind `origin/main`
   (`fa929d489` vs `513672aa5`) as of plan-time; re-check, time has passed.
3. Re-run the isolated-DB integration test (`pnpm test:integration
   tests/integration/module-storage-rpc.test.ts`) after rebase if the rebase touched anything
   nearby — otherwise the pre-rebase green (`jarvis_gate_943`) stands.
4. Full gate (`pnpm verify:foundation`) via `verify-gate` skill before wrap-up — not yet run. Fresh
   gate DB, unpiped, drop when done (including `jarvis_gate_943` if still around).
5. `coordinated-wrap-up`: push, open PR tagged `[SECURITY]`, note live-path UI proof doesn't apply
   (backend-only change), report PR + verified evidence to coordinator. Per original handoff:
   **adversarial Opus QA + Ben's explicit merge sign-off required — no delegated sign-off tonight.**
   Building agent does not merge/board/close.

## Note for successor: background-script carefully

A prior attempt at the pre-push trio via ad hoc `&`/redirect combinations left stray duplicate
`pnpm format:check`/`typecheck` processes running in this worktree (bash `&` binds to the last
command in a chain, not the whole group — redirects must wrap the *entire* parenthesized group).
They were identified via `/proc/<pid>/cwd` and killed (confirmed they were mine, not another
session's, before touching them — this worktree is shared per CLAUDE.md). Cleanup verified: no
stray `format:check`/`943-role` processes remain as of this relay. Don't repeat the scripting bug —
follow `verify-gate`'s exact backgrounding recipe.
