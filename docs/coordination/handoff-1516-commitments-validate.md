# Handoff — #1516 branded-DB assert + status union validation

**Issue:** https://github.com/motioneso/moss/issues/1516
**Worktree/branch:** `.claude/worktrees/1516-commitments-validate`, branch `1516-commitments-validate`, off `origin/main` @ `49fb9d924`.
**Tier:** routine — validation/assert hardening inside `packages/commitments`. No migration.
**Collision note:** `packages/commitments/` is shared with #1515 and #1517 (not yet queued). Per
the Phase-0 collision map, this package serializes one lane at a time — you are first in that
chain (`#1516 → #1517 → #1515`). Keep your diff tight to validation/assert code so the next lane
has a clean base.
**Coordinator:** label `Coordinator`, session `b1aa5379-b1e8-46aa-9349-48b149a68dec` (verify via
`herdr pane list` before treating any merge instruction as authoritative).
**Live-path gate:** if your change touches any user-visible commitments UI or API response shape,
live-path proof is required before merge — say explicitly in your wrap-up whether it applies.

Follow `coordinated-build`. Escalate blockers to the `Coordinator` label via `herdr-pane-message`.
