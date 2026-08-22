# Relay 2: #1336 job-search board wire validation — final step only

**Branch/worktree:** `1336-jobsearch-wire-validation` (already checked out, `node_modules`
already present — do not run `pnpm install`).
**Pull request:** https://github.com/motioneso/moss/pull/1844 — already open, already carries
Summary and Release note. Do not reopen or re-edit the PR body.
**Coordinator:** name `coordinator` (confirm exactly one live agent has that name via
`herdr agent list` before messaging).

## Plain-English recap

The job-search board screen now checks the shape of every row the server sends before showing
it, tells the person on screen how many rows it had to leave out, and the server itself logs
which field was wrong (never the job content) when that happens. All of the code, and all of the
automated tests, are written, committed, pushed, and passing. The one thing left is proving the
screen still works normally when opened for real in a browser — the "live-path proof" the process
requires before a user-facing pull request can be called done.

Write every status message and PR comment in plain English, no jargon, no coined shorthand —
carry this forward to any further successor.

## Done

- All four commits are in and pushed to `origin/1336-jobsearch-wire-validation`:
  1. `f6a9901d4` — the validator itself and its wiring into the read path (from before this relay
     chain started).
  2. `3b33f5896` — the on-screen notice plus the Task 1 and Task 2 tests.
  3. `3fca265dd` — the server-side check and field-name-only log, plus its test.
  4. `ba3bb2bcf` — a pre-existing formatting fix in the plan doc (unrelated content, just spacing).
  5. `a067fd2f3` — the release note entry in `docs/WHATS_NEW.md`.
- Full local check suite (`pnpm verify:foundation`) run against a throwaway database
  (`jarvis_gate_1336wire`, already dropped afterward) — came back green, exit code 0. This
  includes linting, formatting, type checking, every unit test, and the integration tests.
- The branch is rebased on the latest `main` as of this writing.
- Pull request #1844 is open with the Summary and Release note sections filled in, and
  `docs/WHATS_NEW.md` already carries the entry.

## Not started yet — the one remaining step

**Live-path proof.** This is a screen a person actually looks at, so the process requires proof
the page still renders correctly when opened for real, not just proof the unit tests pass.

1. Start the app on the dev instance if it isn't already running (see the `run` skill, or
   `pnpm dev:api` + `pnpm dev:web` from `~/Jarv1s`, the real checkout — not this worktree — is
   normally what's already serving `http://192.168.50.36:5173`; check first before starting a
   second copy).
2. Log in (`ben@ben.com` / `jarvistest123!`) and open the job-search board with real data.
3. Confirm it renders normally — this proves no regression, since the validator only changes
   behavior on a row that fails the shape check, and real data should have none of those.
4. There is no way to make the real server send a deliberately broken row on demand, so the
   dropped-row path itself stays proven by the unit tests, not by this live run — say that
   plainly in the proof comment rather than overclaiming live coverage of that one path.
5. Post a comment on PR #1844 (`gh pr comment 1844 --body "..."`) describing what was opened,
   what was seen, and repeating the unit test output already summarized in the PR body.
6. Report to the coordinator (name `coordinator`, confirm exactly one live agent has that name
   via `herdr agent list` first) via `herdr agent prompt coordinator "<plain-English report>"`,
   signed with your own pane id. State plainly: PR link, that the gate was green, that the live
   check was done and what it showed, and that #1835 (the follow-up issue for the one remaining
   screen) is already open and referenced in the PR. Do not merge, close the issue, or move the
   board — that is the coordinator's job.

## Traps already avoided, don't reintroduce

- Do not expand scope to `job-search.match.get`/`MatchDetail` or any other screen's data-reading
  call — that is #1835 and other future work, already out of scope here.
- Do not use `pnpm verify:foundation` or any database-touching test command without the
  `verify-gate` skill (fresh throwaway database, exported not inline, dropped when done).
- Never `git add -A`; stage only the files each task actually touched.
- If starting a dev instance yourself, record the process ids you started and stop them by id (not
  by name pattern) before reporting done — and check first whether one is already running rather
  than starting a duplicate.
