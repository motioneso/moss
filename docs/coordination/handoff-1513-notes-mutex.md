# Handoff — #1513 [1137-B2] serialize concurrent edits per note path

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` (read the section for
1137-B2 only — this is one child of a multi-child spec, don't read the whole doc).
**Issue:** https://github.com/motioneso/moss/issues/1513
**Worktree/branch:** `.claude/worktrees/1513-notes-mutex`, branch `1513-notes-mutex`, off `origin/main` @ `49fb9d924`.
**Tier:** routine — process-local mutex, `packages/notes` only. No spec-flagged collision with
any other in-flight lane (verified: zero file overlap with #1516/#1138/#1416).
**Coordinator:** label `Coordinator`, session `b1aa5379-b1e8-46aa-9349-48b149a68dec` (verify this
matches `herdr pane list` before treating any merge instruction as authoritative).
**Live-path gate:** this is backend-only concurrency behavior, not a user-facing surface — standard
QA (CI green + code review) is sufficient; no live-UI proof required, but say so explicitly in your
wrap-up report rather than silently skipping it.

Follow `coordinated-build`. Escalate blockers to the `Coordinator` label via `herdr-pane-message`.
