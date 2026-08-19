# Relay 2 — groupC nullable-object/array tool-output schema (#1337)

**Plan:** `docs/superpowers/plans/2026-08-16-groupC-nullable-object-output-schema.md` (already
approved by coordinator, and already fully executed — see below).
**Issue:** #1337
**Worktree/branch:** this worktree, `groupC-nullable-object-output-schema`, off `origin/main`
**Coordinator:** name `coordinator-take25` — resolve pane fresh by label `Coordinator` via
`herdr pane list`, never a baked pane number.
**Relay trigger:** context-meter 70% warning, mid-`coordinated-wrap-up`, gate investigation
in progress but not finished.

## What's done — implementation is COMPLETE, only the gate/PR step remains

- Coordinator approval for the plan **confirmed received** (explicit "APPROVED" message from
  coordinator, this session).
- **Task 1+2 built via TDD, committed:** `ec8f8f423` — `getNullableCompoundBranch` helper +
  insertion point in `packages/ai/src/gateway/output-validation.ts`, 7 new tests in
  `tests/unit/ai-output-validation.test.ts`. Watched RED (4 tests failed for the expected
  pass-through-bug reason) then GREEN (15/15 pass) before committing — full TDD cycle done
  correctly, don't redo it.
- **Pre-push trio run and green:** `pnpm format:check` / `pnpm lint` / `pnpm typecheck` all
  exit 0 (run separately, not just inside the gate). `git fetch origin main && git rebase
  origin/main` — already up to date, no conflicts.
- **Formatting fix committed:** `923dcbf4a` — the plan doc itself (predecessor's commit,
  not my task files) had a prettier violation (`*emphasis*` vs `_emphasis_` style) that failed
  `pnpm verify:foundation`'s `format:check` step. Fixed with `prettier --write`, committed
  separately from the code change. Content-only whitespace/emphasis-style diff, verified before
  committing.
- Working tree is clean (`git status --porcelain` empty) as of both commits above.
- **`scripts/run-gate.sh` run twice:**
  - Run 1 (before the formatting fix): failed at `format:check` on the plan doc — now fixed, see
    above.
  - Run 2 (after the formatting fix, log
    `/tmp/jarv1s-gate/groupc_nullable_object_output_schema-20260816-225714.log`): **rc=1, but ALL
    12 failures are in files completely unrelated to this change** —
    `tests/unit/external-module-invocation-budget.test.ts`,
    `tests/unit/external-worker-runtime.test.ts`, `tests/unit/mcp-gateway-validation.test.ts`,
    `tests/unit/module-sdk-worker.test.ts`. None touch `output-validation.ts` or
    `ai-output-validation.test.ts`. Failure shapes are all timing/host-load flavored: worker
    stall-timeout kills, deadline-math off by ~9-18ms, a `performance.now() < 250ms` budget
    assertion that measured 302ms, child-worker-process "produced no protocol message" (spawn
    under load), a stderr-redaction test race. **This strongly resembles host CPU contention**,
    not a regression from this change — `herdr pane list` at the time showed 3+ other concurrent
    agent lanes running builds/gates on this same box (Group A, Group B, PR1522 relay, plus the
    coordinator itself), matching CLAUDE.md's known `multi-agent-pg-contention` /
    "stagger concurrent runs" trap category.
  - **Re-ran the 4 unrelated failing test files in isolation** (not the full gate) as a sanity
    check: `pnpm exec vitest run tests/unit/external-module-invocation-budget.test.ts
    tests/unit/external-worker-runtime.test.ts tests/unit/mcp-gateway-validation.test.ts
    tests/unit/module-sdk-worker.test.ts` — still 8/56 failed (2 of the 4 files), log
    `/tmp/vf-unrelated-retest.log`. Isolation from the *full gate* doesn't isolate from *host
    contention* (other lanes were still running concurrently) — so this does NOT yet prove
    "flaky/contention" vs "a real pre-existing red on `origin/main`, unrelated to #1337". **Not
    yet distinguished — this is the open question for the successor.**

## What's left (in order)

1. **Determine whether the 8-12 gate failures are pre-existing on `origin/main` or caused by
   host contention from concurrent lanes** — do NOT assume either without checking:
   - Quick check: `git stash` (or a clean second checkout) is unnecessary — instead check
     whether `origin/main` itself is red on these same files, e.g. via CI status on recent
     main-branch commits (`gh run list --branch main --limit 5`), or ask the coordinator whether
     any other lane has already hit/reported these same 4 files failing.
     Given 4+ concurrent lanes were active at gate time, the fast, low-risk path is: **wait
     until fleet load drops (check `herdr pane list` for how many lanes are still
     `agent_status: working`), then re-run `scripts/run-gate.sh start` once more.** If it goes
     green with no code changes in between, that confirms contention — record it and move on. If
     it fails again on the *same* 4 files with the *same* failure shapes, escalate to the
     coordinator with the specific file list before spending more cycles — this may be a
     pre-existing red the coordinator already knows about (check for an existing GitHub issue
     first: `gh issue list --search "external-module-invocation-budget OR module-sdk-worker"`).
   - **Do not touch any of those 4 files** — they are out of scope for #1337 regardless of the
     outcome; the only decision is whether the gate is "green enough to proceed" or needs a
     coordinator escalation.
2. Once the gate is confirmed green (or the contention/pre-existing-red explanation is confirmed
   and reported to the coordinator, per that skill's guidance: "push and let CI be the gate, and
   tell the coordinator" when it's contention, not this lane's bug) — proceed with
   `coordinated-wrap-up` step 3 onward:
   - Push: `git push -u origin groupC-nullable-object-output-schema`.
   - Open PR (`gh pr create --base main --head groupC-nullable-object-output-schema`), title
     like `feat(ai): support nullable object/array anyOf in tool-output schema (#1337)`, body
     with scope, spec link, VF_EXIT evidence (or the contention explanation + CI as the real
     gate), and the "Deferred" non-goal (see below).
   - **Live-path proof is N/A** — pure internal validation function, no UI, no user-facing
     surface (plan's Determinism Boundary section says so explicitly). State that plainly in the
     PR body.
   - **Sensitive-tier statement required in the wrap-up report:** explicitly say the invariant
     verified is that module manifest schema handling stays consistent for every module
     declaring a nullable object output, not just job-search — behavior for other `anyOf` shapes
     is provably unchanged (new branch only fires for the exact 2-branch object/array-or-null
     pattern).
   - Report PR + evidence to coordinator via `herdr-pane-message` (resolve `Coordinator` label
     fresh, do not use a baked pane number), terse and result-first. Then stop — coordinator
     owns QA/merge/board.
   - Mention as a follow-up-issue suggestion (don't file it yourself): whether silent
     pass-through for *other* unrecognized `anyOf` shapes should become an explicit rejection —
     recorded in the plan's "Deferred" section, not built in this lane.
3. Message the coordinator that you relayed and request reap of this pane (session id printed by
   `herdr pane list` at relay time — resolve fresh, don't bake a number).

## In-flight decisions (already made, don't re-litigate)

- Implementation design (`getNullableCompoundBranch` as a separate helper, not an extension of
  `getScalarTypes`) — already built exactly per the plan, don't redesign.
- Bare `{type:"object"}` + null, and "should other anyOf shapes become explicit-reject" are both
  explicitly OUT of scope for this lane (see plan's Non-goal / Deferred sections).
- The formatting fix to the plan doc (`923dcbf4a`) is complete and correct — don't redo it or
  question its content-only nature (diff already verified: emphasis-style + one line-wrap only).
