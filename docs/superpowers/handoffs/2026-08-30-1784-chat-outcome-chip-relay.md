# Relay — #1784 truthful chat action-outcome chip

**Spec:** `docs/superpowers/specs/2026-08-30-1784-chat-outcome-chip.md`
**Plan:** `docs/superpowers/plans/2026-08-30-1784-chat-outcome-chip.md`
**Branch/worktree:** `build-1784-chat-outcome-chip`, this worktree.
**Coordinator agent name:** `coordinator` (re-resolve fresh via `herdr agent list`).

## Done

- Code fix + test committed (one commit, both plan tasks): `apps/web/src/chat/message-row.tsx`
  now shows the same word (Executed / Allowed / Failed / Denied) as the other activity line,
  instead of guessing "Changed" / "Not changed" from only two of the four outcomes.
- New test in `tests/unit/chat-drawer-activity.test.tsx` locks this in for the `allowed` and
  `error` cases.
- Full local check suite (format, lint, types, and the whole test gate on an isolated database)
  passed.
- Branch pushed. Pull request open: https://github.com/motioneso/moss/pull/2116
- Coordinator already said yes to the plan before building started.

## Left to do — only the live-through-the-browser proof

The pull request needs a comment showing this working in a real browser, not just in tests
(project rule: user-facing chat changes need that before merge). Everything else is finished.

**A throwaway copy of the app from this branch is already running**, separate from anyone else's
copy, so it is safe to keep using or to shut down:
- Web address: `http://localhost:5199` (also reachable on the LAN, same host, port 5199)
- Behind-the-scenes address: `http://localhost:3099`
- Process ID for the web one: 3668688. Process ID for the behind-the-scenes one: 3642151 (started
  as a `pnpm --filter @moss/api dev` child — kill by this PID or by what is listening on port
  3099, not by process name, since a real running copy of the app also uses similar names).
- Log files: `/tmp/1784-web.log` and `/tmp/1784-api.log`.
- It shares the same database as everyone's normal working copy of the app, so log in with the
  same normal working login: `ben@ben.com` / `jarvistest123!`.
- If it needs a restart, see `dev-instance-lan-spinup-trusted-origins` in memory for why a
  non-default port needs an extra setting (`JARVIS_AUTH_TRUSTED_ORIGINS`) or logging in fails with
  an "Invalid origin" error. It's already set correctly on the running copy.

**What to do:**
1. Open `http://localhost:5199`, log in as above.
2. Open the chat drawer, ask the assistant to do something ordinary that it can just do (for
   example, change a setting like the theme) — that should produce a small line under the answer
   that now says **Executed**.
3. Ask it to do something that needs your yes/no first, and click **Reject** (or whatever the
   button is now called) — that should produce a line that says **Denied**.
4. Take a small, focused screenshot or copy the relevant bit of the page's html for just that
   small line (not the whole page), showing the words. Post it as a comment on pull request 2116
   with `gh pr comment 2116 --body "..."`.
5. If ten minutes of trying doesn't produce a real "Executed" or "Denied" line (for example, the
   test account isn't set up with a working assistant model on this shared database), it's fine to
   say so plainly on the pull request and report the honest state to the coordinator: the code
   change itself is finished and tested, just not proven live yet.
6. Tell the coordinator it's done (pull request link + what the live check showed), then stop —
   don't touch the project board or merge anything, that's the coordinator's job.
7. Before finishing, shut down the throwaway copy: kill process IDs 3668688 and 3642151 (or
   whatever is now listening on ports 5199 and 3099), and confirm those ports are free.

## Rules this lane must keep following

- Never run a big check command without going through the check-running skill (`verify-gate`) —
  the plain command can accidentally write to everyone's shared working database.
- Never wait by looping and checking again and again — set up something that waits for the actual
  event instead.
- Don't touch anyone else's files or the shared coordination folder.
- Plain, everyday words in anything a person reads — no invented shorthand, no jargon. Say what a
  thing does, not what the code calls it, except for the exact command, file, or error text
  someone needs to act on.
- This is meant to be the ONLY handoff for this piece of work. If this same 70%-full warning fires
  again before the live check is posted, don't hand off again — push whatever is done, write down
  where things stand, and tell the coordinator this piece of work needs to be split smaller
  instead.
