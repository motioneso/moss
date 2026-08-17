# Relay: #1512 notes-path-recheck (security tier)

Branch/worktree: `1512-notes-path-recheck` (this worktree, already checked out — do not re-clone).
Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1.
Handoff (recovered, absent from origin/main — read via
`git show 729034040:docs/coordination/handoff-1512-notes-path-recheck.md`): security tier,
live-path proof NOT required (state that explicitly in wrap-up), adversarial Opus QA + Fable-5
sign-off before merge, issue #1513 depends on this one and is held behind it — don't touch it.

## Done

- Plan committed: `60083c5a3` — `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md`.
  Contains full seams-check citations, the new `recheckWithinRoot(resolvedRoot, targetPath)`
  guard signature for `path-guard.ts`, all 5 exact call-site insertions (write-tools.ts create
  overwrite/exclusive, edit read+write, delete; jobs.ts shared `ingestResolvedMarkdownFile` gains
  a `resolvedRoot` param), 8 deterministic TOCTOU test cases, kill gate, verification commands.
  **Read that plan file — it is the authoritative spec-to-code mapping, don't re-derive it.**
- Messaged the Coordinator (agent name `post1632-coordinator`, label "Coordinator" — re-resolve
  pane fresh via `herdr pane list`, do not reuse any pane id from this doc) with the plan path,
  asking for approval or a fork flag.

## Coordinator approval — RECEIVED

Coordinator (agent `post1632-coordinator`, session `a8124c40-2d1e-48c3-bf48-7bb3d63fe4e5`)
approved the plan as written: design sound, all 5 call-site insertions correctly placed, test
construction (spy on the fs call *before* the guard, never the guarded syscall) correct, kill
gate scope correct, live-path N/A correct. **Proceed straight to build — no need to re-ask.**

## Next step (do this first)

1. Approval is already in hand (see above) — skip straight to build.
2. Build via `superpowers:test-driven-development`, task by task, committing green with
   `Co-Authored-By: Claude`, `git add` by **explicit path only**. Follow the plan's task order:
   task 1 = guard function + write-tools.ts (3 tools, 4 call sites) + tests 1-5 + happy-path
   subset → **kill gate**: if any of tests 1-5 can't be made to fail against pre-fix code,
   stop and escalate to Coordinator before task 2. Task 2 = jobs.ts (new `resolvedRoot` param,
   1 call site inside `ingestResolvedMarkdownFile`, thread through both call sites) + tests 6-7.
3. Pre-push trio before pushing: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
4. `coordinated-wrap-up`: gate on isolated DB (`verify-gate` skill), push, open PR, state
   explicitly that live-path proof was not required (backend-only, handoff override), report to
   Coordinator. Do not merge/close/board — Coordinator's job.

## Not yet done / open

- No code written yet in `path-guard.ts`, `write-tools.ts`, or `jobs.ts` — only the plan exists.
- Coordinator's response to the plan-approval message had not arrived before this relay was sent.

Relay trigger: context-meter 70% warning fired. This is a clean handoff at the plan-approval gate,
zero code yet — that's expected here, not a shortfall to fix by cramming more into this session.
