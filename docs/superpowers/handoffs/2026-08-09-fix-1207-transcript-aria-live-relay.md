# Relay handoff — fix-1207-transcript-aria-live

Second relay this run (hit the context-meter 70% warning twice). Resume `coordinated-build` step 4
(live-path proof), then `coordinated-wrap-up` step 4 (report to coordinator).

## State

- Worktree: `/home/ben/Jarv1s/.claude/worktrees/fix-1207-transcript-aria-live`, branch
  `fix-1207-transcript-aria-live`. Tree is clean, 3 commits ahead of what was on `main` at branch
  point, already pushed.
- **PR #1479 is OPEN**: https://github.com/motioneso/moss/pull/1479 (repo shows a migration
  notice to `motioneso/moss` on push — harmless, `gh`/origin both resolved fine, not investigated
  further, not a blocker).
- Coordinator: agent name `coordinator-wave1-r6`, session id
  `f6461c25-9951-432c-9535-6fb497a92751`, label "Coordinator". Already messaged with a full status
  update (PR link, gate result, live-path-pending) immediately before this relay — no need to
  repeat that message, only the final done-report in step 4 below.
- Coordinator's plan amendments (still governing, already satisfied by commits so far):
  1. Regression test lives in the *existing* `tests/unit/assistant-surface.test.tsx` harness — done.
  2. Live-path PR comment must show the `aria-live` attribute in **live rendered DOM**, not just a
     screenshot — **not yet done, this is the remaining work**.

## Done

- Code fix: `apps/web/src/chat/assistant-surface/surface.tsx:145` —
  `<div className="assistant-surface__thread" aria-live="polite">`.
- Regression test added to `tests/unit/assistant-surface.test.tsx` (new `it(...)` case, #1207),
  confirmed red before the fix / green after.
- Plan doc: `docs/superpowers/plans/2026-08-09-fix-1207-transcript-aria-live.md` (seams check,
  determinism boundary N/A, kill gate N/A, verification commands, live-path proof requirements).
- Pre-push trio (`format:check && lint && typecheck`) green, twice.
- Full isolated-DB gate (`scripts/run-gate.sh`) run 3x:
  1. Failed on `format:check` (plan doc prettier) — fixed, committed (`530978e13`).
  2. Failed on 4 unrelated integration suites (google-sync-calendar, job-search-store,
     news-personalization-routes, notes-write-tools) — teardown-time `TypeError`, DB-contention
     symptoms, none touching this diff.
  3. Ran with `--exclusive` — 1868/1871 passed, only failure was
     `tests/integration/profile-identity.test.ts` with the literal `error: tuple concurrently
     updated` in `sql-runner.ts` during `resetEmptyFoundationDatabase` — this is the exact
     documented sibling-worktree DDL-contention trap from `coordinated-wrap-up`. Did not retry a
     4th time (matches box-wide CLAUDE.md "two identical failures → stop and rethink" spirit —
     continuing to retry a contention-prone shared gate is the anti-pattern). Documented plainly
     in the PR body; pushed and deferred to CI as authoritative per skill guidance.
- Confirmed via `gh pr diff 1479 --name-only | .claude/skills/coordinate/resolve-uat-triggers.sh`
  that the diff triggers exactly these 4 **blocking** UAT specs (no scope drift from the plan):
  - `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`
  - `tests/uat/specs/1133-chat-attachments.uat.spec.ts`
  - `tests/uat/specs/moss-assistant-name.uat.spec.ts`
  - `tests/uat/specs/runtime-context.uat.spec.ts`

## Remaining (do this next, in order)

1. Read `.claude/skills/verify-gate/SKILL.md` (this is where I was headed when the relay trigger
   fired last time — grep for dev-preview / live-instance spin-up mechanics turned up only this
   file as a candidate. It has NOT been read yet). Cross-check against `dev-preview-recipe`
   memory (`memory_recall` query: "dev preview recipe ports") for which ports / how to bring up a
   live dev instance safely without touching prod.
2. Stand up a live dev instance (or confirm one is already usable) per whatever that skill/memory
   says. Record any PIDs you start — teardown requires killing by explicit PID, never by name
   pattern (prod's worker looks like a stray dev process in `ps`).
3. Run the 4 blocking UAT specs above against it: `pnpm test:uat -- "<spec>"` per spec, or however
   `verify-gate`/the UAT runner is invoked — capture real exit codes, don't pipe
   (`... > /tmp/1207-uat-<n>.log 2>&1; echo "EXIT=$?"`).
4. Capture **DOM-level proof** of `aria-live="polite"` on `.assistant-surface__thread` from the
   *live rendered page* — e.g. a browser devtools Elements-panel screenshot showing the attribute,
   or an `element.outerHTML` / `getAttribute("aria-live")` snippet pulled from the live page. A
   plain visual screenshot of the chat UI is explicitly insufficient per the coordinator's
   amendment (`aria-live` has no visual rendering) — do not substitute one.
5. Post `gh pr comment 1479` with the UAT run output (all four passing) and the DOM-level proof.
6. Report to the coordinator per `coordinated-wrap-up` step 4 format (terse, result-first):
   PR link, VF_EXIT/gate summary (already have this from the 3 runs above — no need to re-run the
   full gate again unless something changed), live-path proof status (posted / link), branch
   pushed+rebased state, deferred items (none), teardown state (dev instance PIDs stopped, seed
   rows deleted or none, worktree reapable).
7. Then STOP — do not touch the board, milestones, or merge. That's the coordinator's.

## Guardrails still in force

- Work only in this worktree/branch. `git add` by explicit path — never `-A`. Never touch
  `docs/coordination/` (coordinator-only), the project board, milestones, or merge. No secrets in
  any doc/payload/log/prompt. Never edit an applied migration.
- If a 3rd relay trigger fires (context-meter 70% again), repeat this exact relay procedure:
  message coordinator, update this doc (don't rewrite from scratch — amend the "Remaining"
  section), spawn a fresh successor in this same worktree, request reap.
