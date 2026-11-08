# Notes part two execution checkpoint

Card: 524. Part of #4027. Full acceptance remains the seven-step continuation in
`docs/superpowers/specs/2026-11-08-rust-phase5-notes-report.md`.

Start from merged main, including Notes part one and the shared SDK/host. Keep
legacy SQL unchanged and module interaction on declared public interfaces. Do not
install new third-party packages without approval or claim complete Notes parity.

First close the three retained implementation gaps: JavaScript replacement-token
semantics, reading linked folders without writing a lock file, and independent
account calls avoiding a global filesystem mutex. Generate edit vectors from the
actual legacy handler with explicit boundary stand-ins; these prove domain
behavior, not the UI or database. Observe the targeted regressions fail first.

Then extend disposable-database checks to the six existing Notes tables, including
read/change refusal for another account, an unrelated admin, and app/worker roles.
Exercise the same assertions with RLS removed and restored. Check frozen migration
hashes and retain the original ledger identities.

Continue to guest/package assembly and the remaining settings, tools, sync,
managed publication, exports and real UI/device steps if they fit the task's
context limit. Otherwise stop at a clean, tested, reviewed commit and document
exactly what remains. A checkpoint is not full Notes acceptance or a Ready claim.
