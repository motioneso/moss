# 1754 build agent runner — relay 8

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Status: Task 19 is done and committed. Group C is code-complete. You are at the wrap-up gate.

Everything in this doc is already on disk in this worktree, on branch `1754-build-agent-runner`,
rebased onto `origin/main` as of commit `a579d81f9`. Working tree is clean. Do not re-plan, do not
re-build — go straight to re-running the gate (see "What's left" below).

### What got done this relay

- Found and fixed the real bug behind Task 19's failing test (the earlier relay had it timing out
  at 30 seconds with no clear cause). Root cause: the test's pg-boss client connected using
  `connectionStrings.app`. That role can insert and read pg-boss's job table but cannot update or
  delete rows, so `boss.work()` could never claim a job — the job just sat in the queue forever,
  silently, no error. Fixed by connecting the pg-boss client with `connectionStrings.worker`
  instead (which has full read/write on pg-boss's tables), while keeping the data queries
  (`module_builds` table) on `connectionStrings.app` — same split already used in
  `tests/integration/tasks-verticals.test.ts`. Test passes now, confirmed twice.
- Committed three things in order:
  1. `test(#1754): prove a build resumes from its persisted step after a restart` — the Task 19
     test itself plus the two files it depends on (`packages/jobs/src/pg-boss.ts`,
     `packages/jobs/src/module-build-jobs.ts`).
  2. `chore(#1754): apply prettier formatting across Group C files` — nine files, mostly from
     earlier tasks in this same branch, had drifted out of formatting. Ran `prettier --write` once
     to clear the pre-push formatting check.
  3. `fix(#1754): use type-only imports flagged by the lint gate` — two files needed
     `import type` instead of `import` for symbols that are only used as types
     (`sendJob` in `module-build-jobs.ts`, `validateExternalModuleManifest` in
     `install-draft.ts`).
- Ran the pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) clean, then
  `git fetch origin main && git rebase origin/main` — rebased cleanly onto `a579d81f9`, re-ran the
  trio again after the rebase, still clean.
- Started the full gate with `scripts/run-gate.sh start` (gate db
  `jarvis_gate_1754_build_agent_runner`, log
  `/tmp/jarv1s-gate/1754_build_agent_runner-20260821-154304.log`). **It came back red — 5 tests
  failed, in 2 files, both unrelated to anything this branch touched:**
  - `tests/unit/mcp-gateway-validation.test.ts` — 4 failures, all
    `ToolInputValidationError: Pattern matching failed and was rejected`.
  - `tests/unit/external-worker-runtime.test.ts` — 1 failure,
    `redacts learned credentials from bounded stderr`, `expected '[]' to contain '[REDACTED]'`.

### These failures match two already-documented pre-existing flakes — not this branch's fault

Both are in memory, already investigated by earlier work, not something to chase as a bug in this
task:

- `gateway-worker-pattern-timeout-flake` (memory) — a hardcoded 100ms timeout on a worker-thread
  pattern-validation path that real cold-start measured at 80-150ms on this machine, so it misses
  the deadline under load. Explicitly names `mcp-gateway-validation.test.ts` as a file it hits.
  Filed as GitHub issue #1673. Confirmed load-dependent: two isolated runs of a related test gave
  different failure counts.
- `module-worker-timeout-counts-host-latency` (memory) — a 30-second wall-clock timeout on
  external-module worker calls that counts time the host itself spends replying to the module, so
  it can trip under load with no code change. Plausibly the same family as the
  `external-worker-runtime.test.ts` failure, though that memory doesn't name this exact test — not
  fully confirmed, treat as a strong lead, not a certainty.

Neither memory says these are always-red — they say "known to flake under load," which is exactly
what a full local gate run looks like (many tests, high host load, on a shared dev box that also
has several other build lanes running right now per `herdr pane list`).

### What's left — do this next, in order

1. **Re-run the gate once more** with `scripts/run-gate.sh start` (a fresh run gets its own log
   and its own gate database automatically). If it comes back green, or if the same two files are
   the only failures again (a different failure count is fine — the flake is described as
   load-dependent, not deterministic), treat that as confirmation and move on to step 2. If a
   *different* file fails, or a Group C file fails, stop and actually debug that one — don't
   assume every red is this flake.
2. Once you're confident the gate is clean except for the two known-flaky files: push
   (`git push -u origin 1754-build-agent-runner`), open the PR with `gh pr create`, and in the PR
   body's gate-evidence line say plainly that the full gate showed 5 failures in
   `mcp-gateway-validation.test.ts` and `external-worker-runtime.test.ts`, that they match
   documented pre-existing flakes (issue #1673 for the first), and that no file this branch
   touched failed.
3. This PR has no UI surface of its own (the actual build-agent runner UI is tracked separately as
   #1755), so the live-path gate does not apply here — say that plainly in the PR body rather than
   silently skipping it.
4. Run `coordinated-wrap-up`'s reporting step: message the coordinator with the PR link, the gate
   result (including the flake caveat above), confirmation the branch is pushed and rebased, and
   that Group C is complete. Then request reap of this pane once the coordinator confirms.
5. Do not move the board, close the issue, or merge — that's the coordinator's job.

### Reminders (unchanged from earlier relays)

- Work only in this worktree/branch; `git add` by explicit path, never `-A` — this is a shared
  checkout, other sessions are active in `herdr pane list` right now.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% context-meter warning or if you see a compaction summary.
- Plain English in every message to the coordinator and in every spawn prompt — no jargon, no
  invented terms, exact names only for things Ben must act on (a command, a file, an error
  string). This is a standing rule from Ben, carried on every relay.
