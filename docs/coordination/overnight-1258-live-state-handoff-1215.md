# Handoff — #1258 dev-instance tool, 12:15 (20 Aug) checkpoint

Read `docs/coordination/overnight-1258-live-state.md` in full first — this file is just a
short pointer into it, newest section at the bottom ("12:15 (20 Aug)").

## Where things stand right now

- Pull request https://github.com/motioneso/moss/pull/1775 is open, branch
  `build-1258-dev-instance-provisioning`, CI fully green (all checks).
- **Not merged. Not marked done. Board not moved.** That stays true until live-path proof
  is actually completed — this is a hard rule from the project's own CLAUDE.md and from Ben
  directly, not a suggestion.
- The live end-to-end check (reset the dev database with the new tool, reprovision, sign
  in through the real interface, confirm AI chat still works) was started tonight but not
  finished. Doctor and fix were each proven working against the real dev database earlier.

## What's actually blocking the live-path check right now

The "hang" turned out to be nothing — the health check just takes about 20 seconds to start,
not actually stuck. The real blocker, found after that: **no development copy of Moss is
running on this machine at all.** Every process that looked like "the dev side" tonight was
actually production's (checked properly this time, by container membership, not by name —
see the incident note below on why that matters here). The tool's own repair step tried to
start a development chat-helper process and failed, because a required shared secret
(`JARVIS_CLI_RUNNER_RPC_SECRET`) that the app and its chat-helper use to talk to each other
isn't set anywhere in this development setup — it's documented as required for production,
with no equivalent for running from source in development.

1. **Start the real development app first**, if it isn't already running by the time you
   pick this up: `pnpm dev:api` + `pnpm dev:web`, per the usual recipe, with that secret set
   in the shell first.
2. **Finish the live-path check** once the app is actually running: reset the database with
   the new tool, reprovision, sign in through the real interface, confirm chat still works
   post-reset. Record the result with a comment on pull request #1775.
3. Worth a judgment call, not decided here: is "the tool correctly refuses to start a
   chat-helper without its required secret" itself worth a small follow-up ticket (missing
   a documented dev default), separate from #1258's own scope? Leaning yes, but #1258 itself
   is not blocked on deciding that — just on actually having a running dev app to test
   against.

## One incident worth knowing about before touching processes on this machine

This machine runs both the live production copy of Moss and the development copy side by
side, sharing one process list. A plain process search by name doesn't tell them apart.
Tonight a process belonging to production was killed by mistake while looking for a stuck
development process — production restarted itself automatically within about a minute, no
data was lost, and Ben has already been told and confirmed he's fine with continuing. Before
stopping or killing any process on this machine, check whether it belongs to the production
container first, not just by name.

## Separate, smaller, unrelated item left for whenever

The full local check-everything command fails at its very first step (the code-style check)
on every branch, not just this one — it's missing an entry for one already-ignored folder.
Small, low-risk, mechanical fix. Not done by anyone yet, left for morning.

## Coordinator continuation — 20 Aug, release-note queue

Coordinator authority after adoption: Codex session
`01a020f6-1fd0-7b12-bc33-733b10e06488`, label `Coordinator`. Re-resolve its pane from
`herdr pane list`; pane numbers are not authority. It replaced relayed session
`01a020ba-0bb3-7b73-b386-afe3d4e0d5f8` after that session's compaction tripwire fired.

Mid-doing, in order:

1. Finish #1258 live-path proof. The reset succeeded and the PR-branch dev API/web were restarted
   on ports 3000/5173. Sign-in and opening Chat with Moss were proven in Firefox. The remaining
   proof is to send `Reply with exactly LIVE-PATH-1258-OK` and visibly receive that exact reply.
   Webwright state is in `/tmp/webwright-1258-live-proof`; an exploratory browser exec session
   `31181` stalled during the Send click, so inspect whether it is alive before retrying. Produce
   the required clean `final_runs/run_<id>/` artifact, crop any screenshot before inspection,
   comment the evidence on PR #1775, update the #1258 checklist comment, then merge only if the
   live-path gate is genuinely satisfied.
2. After #1258 is finished, message the currently labelled `926 Food spec Fable review` pane that
   the dev stack is ready to hand over. Re-resolve it from `herdr pane list` first and use the
   `herdr-pane-message` skill.
3. Implement #1794 in the existing isolated worktree
   `~/Jarv1s/.claude/worktrees/1794-release-notes-daily`, branch
   `fix-1794-release-notes-daily`. Requirement: every user-facing merge appears in
   `docs/WHATS_NEW.md`, grouped by Pacific merge date; first merge creates the date, later merges
   append under Added/Fixed/Changed; `Category: N/A` is skipped.
4. Root cause: `.github/workflows/release-notes.yml` directly pushes protected `main`, so run
   `32413183976` failed its required CI gate. `scripts/append-release-note.mjs` also overwrites one
   dated Edge heading rather than preserving daily groups. Use the existing script and workflow;
   do not add another system or dependency.
5. Minimal chosen design: make the script reconcile recent merged-PR JSON idempotently, converting
   each `mergedAt` to `America/Los_Angeles`; migrate the legacy Edge format; preserve category
   order and skip PR numbers already present. Extend its built-in `--self-test` for first/same-day/
   later-date/duplicate/legacy cases. Change the workflow to rebuild a dedicated rolling automation
   branch from current `origin/main`, reconcile recent merges, create or reuse one PR, and enable
   squash auto-merge. Never direct-push `main`. Convert `docs/WHATS_NEW.md` to the dated layout.
6. #1794 exists, is on project 2, and is In progress. Keep its issue/board comments current. Do not
   stage, commit, push, or open the implementation PR without Ben's explicit authorization.
7. #1789 was reopened and moved back to In progress because it merged without live proof. #1739's
   Stage 1 plan is complete at commit `ef2fd9d74` on `plan/1739-stage1-workshop`; no PR yet.

The successor should read only this newest section plus the current queue/state sections it needs,
invoke `coordinate`, update the authority line to its own session id, and continue item 1.
