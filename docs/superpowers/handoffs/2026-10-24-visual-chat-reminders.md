# Visual chat: read-only reminder summaries (#3667)

Branch `feat/visual-chat-reminders-3667`, PR #3700, worktree `~/Jarv1s/.claude/worktrees/visual-chat-reminders`.
Part of #3583. Plan: `docs/superpowers/plans/2026-10-24-visual-chat-reminders.md`.

## Done

- Product code, unit and integration tests, app-map entry, package exports.
- Full local gate green on the product head (needs a disposable GreenMail on claimed ports,
  passed as `MOSS_TEST_IMAP_PORT` and `MOSS_TEST_IMAP_SMTP_PORT`; the gate does not start one).
- Independent Standards and Spec review of the product head: no blockers.

## Remaining

- CI green, then 20 frozen prompts on moss-proof (port 5181, `./switch-branch` from `~/.config/moss-proof`),
  with failed attempts retained; then `gh pr merge --squash --auto`.
