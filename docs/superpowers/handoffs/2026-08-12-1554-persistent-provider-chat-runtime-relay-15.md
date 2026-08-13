# Continuation: #1554 persistent-provider-chat-runtime (relay #15)

Branch/worktree: 1554-persistent-provider-chat-runtime. PR #1593:
https://github.com/motioneso/moss/pull/1593 — **open, not merged**. All 8 plan tasks
(`docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`) built and committed.

## State at handoff (context flush, no code changes needed)

Previous relay (#14, `docs/superpowers/handoffs/2026-08-12-1554-persistent-provider-chat-runtime-relay-14.md`)
rebased PR #1593 onto origin/main to resolve the #1256/PR #1587 collision predicted by the plan's
"Finding B" — 5 additive conflict blocks, resolved by keeping both sides, no semantic overlap. PR
moved from `DIRTY` to `CLEAN`/`MERGEABLE`.

This relay confirmed CI on the rebased head (`gh pr checks 1593 --repo motioneso/moss`):

- `Verify foundation and app`: **pass**
- `Compose deployment smoke`: **pass**
- `Prod compose deployment smoke`: **pass**
- `Verify docs`: skipping (expected, no docs-only change)
- `Detect change scope`: **pass**
- `Build and publish images`: pending — **Coordinator has classified this as non-blocking**
  (image-publish, not a gate check). Do not wait on it before reporting.

**All gate-blocking checks are green.** PR #1593 is clean/mergeable.

## Successor's job

This is a poll-and-confirm handoff, not a build handoff — no new code is expected.

1. Re-check `gh pr checks 1593 --repo motioneso/moss` once. If `Build and publish images` has since
   settled (pass/fail), note it, but its outcome does not gate anything per the Coordinator.
2. Re-resolve the Coordinator's pane fresh via `herdr pane list` — **do not cache any pane id**,
   including `w1:p7P` (correct as of this relay) or the stale `coord-overnight-20260810-e7` name
   used in earlier relays. Confirm current session id under label `Coordinator` each time.
3. If the Coordinator has not already been told (check for a reply first — this relay already sent
   one via `herdr-pane-message`), send: PR #1593 URL, confirmation all gate-blocking checks are
   green, and that it's ready for QA dispatch per their standing instruction.
4. **Hard bans, unchanged:** do not merge PR #1593, do not close #1554, do not touch the project
   board, do not touch `docs/coordination/`. QA dispatch and merge decision belong to the
   Coordinator/QA process, not this lane.
5. Before any tree-wide git action, check `herdr pane list` per `shared-checkout` skill discipline
   — this worktree may be shared.

## Reference

- Full rebase/conflict-resolution detail: relay #14 (above).
- Plan: `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`.
- Coordinator: session id changes — always resolve the `Coordinator` label fresh via
  `herdr pane list`, never trust a cached pane id or session id from a prior relay doc.
