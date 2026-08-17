# Relay #2 — #1514 commitment upsert atomic

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §C1 (lines 143-157).
Issue: #1514 (`Part of #1137`). Branch/worktree: `1514-commitment-upsert-atomic` (this worktree).
Plan: `docs/superpowers/plans/2026-08-17-1514-commitment-upsert-atomic.md`.
Coordinator: named agent `coord-take29`, label `Coordinator` — **re-resolve fresh via
`herdr pane list`** (name + `agent_session.value` are authority, never a `w1:pXX` number from this
doc).

Prior relay doc (superseded, background only):
`docs/superpowers/handoffs/2026-08-17-1514-commitment-upsert-atomic-relay.md`.

## Done — everything except push + PR + report

- **Build**: commit `1477bf2df` — Task 1 (atomic `ON CONFLICT` upsert) + Task 2 (deterministic
  concurrency test) complete. RED/GREEN verified 3/3 each (see prior relay doc for detail — do not
  re-verify, already resolved).
- **Pre-push trio**: `format:check`/`lint`/`typecheck` all `EXIT=0`. Fixed one pre-existing
  prettier nit in the plan doc, committed `e69b8f14c`.
- **Rebase**: already up to date with `origin/main`, no-op.
- **Full gate (`verify:foundation`) ran RED, root-caused as unrelated pre-existing, NOT my diff**:
  - `git diff origin/main...HEAD --stat` confirms scope is exactly: 2 docs files +
    `packages/commitments/src/repository.ts` + `tests/integration/commitments.test.ts`.
  - `test:unit` failed with 10 failures across 3 files, none touching commitments:
    `mcp-gateway-validation.test.ts` (4 — matches the already-documented
    `gateway-worker-pattern-timeout-flake` memory, confirmed load-dependent, passes in isolation),
    `module-sdk-worker.test.ts` (5) + `external-worker-runtime.test.ts` (1) — **new root cause I
    traced**: both spawn a child process (`node --import tsx`) and poll stdout on a hardcoded
    ~1s/20ms budget; measured actual cold-start of that exact command in this worktree at
    1.26-1.46s across 3 runs, consistently over budget — deterministic, not load-dependent.
  - Because `verify:foundation` chains with `&&`, the `test:unit` failure aborted the gate before
    `db:migrate`/`test:integration` ever ran.
  - **Direct evidence gathered instead**: ran `db:migrate` + `vitest run
    tests/integration/commitments.test.ts` by hand against the isolated gate DB
    (`jarvis_gate_1514_commitment_upsert_atomic`) — `db:migrate` `EXIT=0`, commitments suite **7/7
    passed, EXIT=0**. Gate DB dropped after (`DROP DATABASE IF EXISTS
    jarvis_gate_1514_commitment_upsert_atomic;`) — no DB left behind, nothing to clean up.
- **Escalated to coordinator, approved**: coordinator (`coord-take29`) reviewed this exact
  writeup and said **go with option (a)**: push + open the PR now, document the pre-existing red
  in the PR body with the isolated-gate-DB evidence as the real proof, file a follow-up issue for
  the timing flake, link it from the PR body.
  - **Follow-up issue filed**: **#1667** — "test:unit: module-sdk-worker + external-worker-runtime
    tests fail on hardcoded ~1s polling budget vs slower sandboxed child-process cold start" — full
    root-cause trace and repro already in the issue body, nothing further to write there.
  - **Coordinator's explicit CI-waiver caveat** (carry this into the PR body and the report,
    don't drop it): if GitHub CI's own run reproduces this same red (rather than passing clean on
    its runners), **do NOT treat it as auto-waived** — flag it back to the coordinator. The CI
    waiver protocol needs proof-on-main-at-same-SHA plus coordinator/Ben sign-off before it can be
    waived at QA time.

## Next steps (in order) — small, mechanical, no more investigation needed

1. **Push**: `git push -u origin 1514-commitment-upsert-atomic`.
2. **Open PR** (`gh pr create --base main --head 1514-commitment-upsert-atomic`):
   - Title: `fix(#1514): atomic ON CONFLICT upsert for commitment candidates`.
   - Body must state, plainly:
     - Scope: atomic upsert in `CommitmentsRepository.upsertCandidate` (SELECT-then-branch race
       replaced with a single `insertInto(...).onConflict(...)`), deterministic concurrency
       regression test. No migration needed (`uq_candidate_owner_sig` pre-existed).
     - Live-path proof: **not applicable** — internal repository/worker fix, no UI surface, no
       model/chat turn (per plan's Determinism boundary section).
     - Gate status, told honestly: `verify:foundation` full run is RED, but the failure is in
       `test:unit` (`mcp-gateway-validation.test.ts`, `module-sdk-worker.test.ts`,
       `external-worker-runtime.test.ts`) — **pre-existing, unrelated to this diff**, confirmed
       via `git diff origin/main...HEAD --stat` scope check + root-caused (timing-budget-vs-
       sandbox-speed mismatch, see #1667). Because the gate chain is `&&`-joined, this aborts
       before `test:integration` runs.
     - Direct evidence in place of the blocked gate step: `db:migrate` EXIT=0 +
       `vitest run tests/integration/commitments.test.ts` → **7/7 passed, EXIT=0**, run against
       the isolated gate DB (dropped after).
     - Link **#1667** (the follow-up issue) explicitly.
     - State the **CI-waiver caveat** from the coordinator verbatim-ish: if CI reproduces this same
       red rather than passing clean, that is NOT auto-waived — needs coordinator/Ben sign-off with
       proof-on-main-at-same-SHA before QA can waive it.
3. **Report to coordinator** (label `Coordinator`, re-resolve pane fresh, use `herdr-pane-message`
   or `herdr agent prompt`): PR link, one-line restatement of the gate situation + #1667 + the
   CI-waiver caveat, confirm worktree is clean/reapable. Then **stop** — coordinator owns QA,
   merge, board, issue close.

## Constraints carried over (unchanged)

- File scope: `packages/commitments/src/repository.ts` and `tests/integration/commitments.test.ts`
  only (already done). Do not touch C2/C3/C4 (out of scope per #1514). Do NOT touch
  `module-sdk-worker.test.ts` / `external-worker-runtime.test.ts` / the gateway timeout — that's
  #1667's scope, not this lane's.
- `git add`/`git commit` by explicit path only, never `-A`/`.`/bare commit.
- Never touch `docs/coordination/`, board, milestones, or merge — coordinator's job.
- Relay again on the meter's 70% warning or a compaction summary — don't invent a higher personal
  threshold. This is relay #2; if you're reading this as relay #3, the remaining steps above are
  small enough that it should not take long to reach report + stop.
