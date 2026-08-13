# Build Handoff — 1495-assistant-surface-ordering

**GitHub issue:** #1495. **Spec + plan already approved and on `main`:**
`docs/superpowers/specs/2026-08-12-1495-assistant-surface-ordering.md` and
`docs/superpowers/plans/2026-08-12-1495-assistant-surface-ordering.md` (Fable, authored per
`plan-build`, per her own offer — the plan-authorship rule is satisfied, this lane skips the
draft-plan-and-wait-for-review step other lanes tonight require).
**Risk tier:** `security` — this is the ordering half of #1284's leakage rule (module content
landing in the user's main drawer thread is a privacy hole). Gets adversarial Opus QA +
**Ben's explicit merge sign-off**.
**Scope (read the plan for full detail, this is the summary):**
1. Write-side: when an `AssistantSurface` handle is module-bound (`moduleId` set) and
   `currentSurface` is still undefined, `seedContext`/`submitTurn` must reject loudly (throw an
   error naming the contract: "claim a surface via setSurfaceKey before seeding/submitting") —
   not silently no-op. Drawer-bound handles (no `moduleId`) are unchanged.
2. Read-side (scope grew one notch per Fable's ruling): `subscribeRecords` falling back to the
   DRAWER subscription when a module-bound handle is unclaimed (`handle.ts:101-104`) is in scope
   too — same leakage, opposite direction (module code receiving the user's main-thread records).
   Design: reads no-op empty with `console.error`, not a throw (reads can't throw across a
   subscription boundary the same way writes can) — writes reject loudly, reads no-op empty.
3. **Fact correction to the issue text:** the pinning test #1495 cites does NOT exist on `main` —
   it only exists on held PR #1493's branch. Write your own tests from scratch; there is nothing
   to flip.
4. Blast radius: only `apps/web/src/today/today-page.tsx` calls seed/submit outside the handle
   today (job-search's caller is gone with that cancellation) — verify its ordering before/after
   your change.
**Single phase, frontend-only. No live-path gate** — no user-visible change, rationale is in the
plan; don't add a live-path proof step that the plan itself says isn't needed.
**Worktree:** `.claude/worktrees/1495-assistant-surface-ordering` **Branch:** `1495-assistant-surface-ordering` (off `origin/main` @ `198928da4`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan author/reviewer for questions:** pane labelled `spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the plan doc in full (it's single-phase — no need to section it off).
3. Build per `coordinated-build`, TDD, commit per step.
4. Report done to the Coordinator per `coordinated-wrap-up`.

## Exit criteria

- Test proving a module-bound handle with an unclaimed surface throws on seed/submit, naming the
  contract in the error.
- Test proving the read-side no-ops empty (not a throw) with a `console.error`, for the same
  unclaimed-module-bound case.
- `apps/web/src/today/today-page.tsx`'s ordering verified against the new throw — either it
  already claims a surface first (note that in the PR) or it needed a small fix (note what/why).
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None identified against tonight's other lanes — distinct files (`AssistantSurface`
  handle/subscription code) from every other lane's scope.
