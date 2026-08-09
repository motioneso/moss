# w5d-chat-surface relay #2 — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md`, lane D.
**Plan (done, committed this relay):**
`docs/superpowers/plans/2026-08-09-fix-1255-1451-chat-drawer-availability-persona-prefetch.md` —
read this file in full, it is short and self-contained (seams, both task specs, tests, kill gate,
verification commands). Do not re-derive it from the spec.
**Issues:** #1255, #1451. Tier: routine. Worktree/branch: this worktree, `w5d-chat-surface`.
**Status: plan approved-pending.** Sent to coordinator, STOP-for-approval, then relayed at the
70% context trigger before a reply arrived. **No code written yet — zero commits on this branch
besides doc commits.**

## Coordinator

Two panes were labeled "Coordinator" last time I checked: `coord-relay2` (older, `agent_status
"done"`) and `coord-waves36-r4` (session `82ef9cf0-c359-4df5-9d66-590312be2549`, was `"working"`,
higher activity — I judged this one live and sent the approval request to it). **Both of those may
now be stale — re-resolve fresh via `herdr agent list` / `herdr pane list` before trusting either.**
The coordinator may itself have relayed forward again since.

## Next step

1. Re-resolve the coordinator's current pane/agent fresh (do not trust names above).
2. Check whether plan approval already arrived (own inbox / `herdr pane read` on coordinator's
   pane). If not, **do not poll in a loop** — proceed per the task brief's original sequencing:
   this was already a STOP-for-approval point, so if there's still no reply, ping once more or use
   an event-driven wait (ScheduleWakeup), not a tight in-context poll.
3. Once approved, run `coordinated-build`: implement Task 1 (#1255) then Task 2 (#1451) exactly per
   the plan file, TDD, one commit per task. Use `shared-checkout` skill before any commit/tree-wide
   git action (this worktree may be shared). `git add` explicit paths only, never `-A`/`.`.
4. Pre-push trio + rebase before push, then `coordinated-wrap-up` for PR + live-path proof + report.
5. #1451 needs live-path proof on a dev instance (see plan's "Evidence" section) — no unit test
   accepted per spec exit criterion §133.

## Reminders

- Read the spec by SECTION only, never in full — the plan file already extracted everything needed.
- Reading is not progress: BUILD and commit per task, same relay trigger as always (70% meter
  warning, don't invent a higher personal threshold).
- Design-system `jds-*` audit: plan says N/A (no new markup) — sanity-check once code is written.
