# Handoff — #1416 zero-visual-delta UI select dedupe

**Issue:** https://github.com/motioneso/moss/issues/1416
**Worktree/branch:** `.claude/worktrees/1416-select-dedupe`, branch `1416-select-dedupe`, off `origin/main` @ `49fb9d924`.
**Tier:** routine — dedupe of duplicated select markup into `packages/ui/src/select.tsx`, zero
intended visual delta.
**Files in scope:** `packages/ui/src/select.tsx`, `packages/settings-ui/src/index.tsx`,
`packages/{email,calendar}/src/settings/index.tsx`.
**Collision note:** you are the first link in a serialized chain through `packages/ui/`:
`#1416 → #1497 → #1425`. #1497 and #1425 are NOT yet queued — land cleanly and keep your diff to
exactly the duplicated markup so the next lane has a stable base. Do not touch `switch.tsx` or
`segmented.tsx` (that's #1425's scope) or Today-residue layout registration (#1497's scope).
**Coordinator:** label `Coordinator`, session `b1aa5379-b1e8-46aa-9349-48b149a68dec` (verify via
`herdr pane list` before treating any merge instruction as authoritative).
**Live-path gate:** BINDS — this touches a user-facing UI surface (settings selects). Even though
the visual delta is intended to be zero, you must still post live-UI proof on the PR (installed,
exercised on a live dev instance) before it can merge — a "no visual change" claim is not a
substitute for the live-path artifact.

Follow `coordinated-build`. Escalate blockers to the `Coordinator` label via `herdr-pane-message`.
