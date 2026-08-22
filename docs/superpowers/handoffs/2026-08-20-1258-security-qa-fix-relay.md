# Relay: #1258 PR 1775 — fix the blocking security QA finding

Written 2026-08-20 by the session that opened PR 1775, on hitting the context-meter 70% warning
while still only reading (no code changed yet). Nothing to undo — pick this up fresh.

## Where the work lives

- Issue **#1258**, PR **https://github.com/motioneso/moss/pull/1775**.
- Branch **build-1258-dev-instance-provisioning**, in the shared checkout `~/Jarv1s` — use the
  `shared-checkout` skill before every commit.
- Coordinator: the Herdr pane labelled **Overnight Coordinator**. Re-resolve its pane number fresh
  with `herdr pane list` every time — do not trust a written pane number.
- **Do not `git reset`/`stash`/broad-`add`.** Two coordinator commits already sit on top of this
  branch in this worktree (`27a5afb7d` docs: update coordinator handoff, `6b322256b` docs:
  transfer coordinator authority) plus other sessions' unrelated shared-checkout changes. Preserve
  all of it. Commit your fix by explicit path only.

## The one blocking finding to fix

Full QA verdict: https://github.com/motioneso/moss/pull/1775#issuecomment-5361811765 (read it in
full — it also lists 8 non-blocking findings, don't touch those, and a UAT note, see below).

**The bug:** `scripts/dev-instance.ts:68` calls `assertTargetIsDevInstance` (from
`scripts/dev-instance/guard.ts`) only on `urls.app`. The CLI then opens a second, more privileged
handle on `urls.migration` (around line 80) using the migration-owner role — unguarded. That
migration-owner handle is what runs the CLI's only DELETE (`scripts/dev-instance/fix.ts:73`,
`DELETE FROM app.users`) and every doctor read. `urls.app` and `urls.migration` are independently
overridable env vars (`packages/db/src/urls.ts:60-65`), so a shell with
`JARVIS_MIGRATION_DATABASE_URL` pointing off-box passes the app guard and deletes rows on the
wrong database.

**The fix:** apply `assertTargetIsDevInstance` to `urls.migration` too, in
`scripts/dev-instance.ts`, alongside the existing `urls.app` guard call (line 68).

**The wrinkle:** the allowlist in `scripts/dev-instance/guard.ts` (`DEV_INSTANCE_PORTS = ["55433"]`)
must also accept the in-container form, which uses port `5432`, not `55433` — see
`tests/uat/provisioner.ts:222` (`JARVIS_MIGRATION_DATABASE_URL=postgres://jarvis_migration_owner:...@postgres:5432/jarv1s`).
So this is not a one-line "just call the guard again" — the port allowlist itself needs to accept
`5432` for the migration URL case without loosening what the app-URL guard accepts, or the guard
needs a per-call allowed-ports parameter. Read `scripts/dev-instance/guard.ts` in full (it's short)
and `scripts/dev-instance.ts` lines ~60-90 before deciding the exact shape — don't guess the
signature from this summary.

## Required negative test

QA's "not-tested" list says the guard is never exercised against a divergent migration URL. Add
the smallest test that proves it: a call into the CLI (or directly into the guard/wiring) with
`urls.migration` pointing at a non-dev-instance database rejects before any destructive work runs.
Put it in `tests/unit/dev-instance-guard.test.ts` (that file only feeds the guard app-shaped
strings today — extend it) or wherever fits the existing test structure best; use your judgment,
this isn't prescriptive.

## After the fix — required steps, in order

1. `npx tsc --noEmit -p tsconfig.json` — must be exit 0.
2. Run the new negative test plus the existing `tests/unit/dev-instance-guard.test.ts` and
   `tests/unit/dev-instance-not-bundled.test.ts` — must be green.
3. Rebase onto current `origin/main` (`git fetch origin main && git rebase origin/main`) — the
   branch was 16 commits behind at QA time. **Careful:** last relay hit an untracked file collision
   during rebase from an unrelated session's stray doc — if that happens again, move the file aside
   to `/tmp` (don't delete), don't guess, check `herdr pane list` first per the `shared-checkout`
   skill.
4. Re-run the integration test (`tests/integration/dev-instance-doctor.test.ts`) against a fresh
   gate database — DROP + CREATE `jarvis_gate_1258p3` (or a fresh name if that's stale/held), then
   `pnpm db:migrate`, then `npx vitest run tests/integration/dev-instance-doctor.test.ts`. Must be
   18 passed (was green at this count before the fix; confirm it still is after).
5. **Re-check the blocking runtime-context UAT — do not waive it.** QA flagged it failing
   (`page-context push count was 1, expected 0`) but believes it's likely pre-existing/unrelated
   (this PR's only chat-adjacent change is a one-line re-export of `RpcConnection`) and that main
   has landed chat-privacy fixes since this branch's base. Per the locked #1027 policy, a blocking
   UAT failure is **never** waived by QA — it needs to be confirmed red on `main` at the same
   commit, then routed through the CI-waiver protocol, not silently ignored. Ask the coordinator
   how to route this if the waiver protocol isn't already clear to you — this is a process
   question, not a code question, and the coordinator/Fable owns that call.
6. Push the focused fix to the existing PR (`git push`) only after steps 1-4 are green. Do not
   force-push unless you know exactly why.
7. Report the new head commit and every exit code (tsc, unit tests, integration tests) to the
   coordinator via `herdr-pane-message`, re-resolving its pane fresh. Mention the runtime-context
   UAT routing outcome explicitly — don't let it go unmentioned.

## Ground rules that still apply

- Plain English to every human and to the coordinator: name things by what they do, not by what
  the repo calls them; keep exact names only where someone must act on one (a command, a file, an
  error string). Pass this instruction on to every agent you spawn.
- Never run the full gate (`pnpm verify:foundation`) without the `verify-gate` skill's
  DROP+CREATE-fresh-DB discipline. It was already known to fail at an unrelated step on this branch
  (a pre-existing typecheck error in an external module, unrelated lint errors in stray scratch
  files elsewhere in the tree) — don't try to fix those, they aren't yours.
- Do not merge. CI was still running last check; the merge decision waits on someone doing a live
  look through the real interface, which is a separate step nobody has done yet.
- Ben is asleep — do not wake him. Route real product/process forks (like the UAT-waiver question)
  to the coordinator for Fable.
- Your own relay trigger is the context-meter 70% warning — not a felt percentage.
