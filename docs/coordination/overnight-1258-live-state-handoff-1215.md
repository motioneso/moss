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

## Coordinator continuation — 20 Aug, PR 1775 security finish

Coordinator authority after adoption: Codex session
`01a02192-a96b-7231-99fd-fe3655e6e141`, label `Coordinator`. This session adopted the run and
reaped the prior coordinator only after resolving its label plus exact session id. A compaction
summary then fired the coordinate skill's mandatory relay trigger; the successor must replace the
authority line with its own session id before driving or merging, confirm it is the sole
`Coordinator`, and reap this session only after resolving this exact session id fresh.

Mid-doing, in order:

1. PR #1775 is open on `build-1258-dev-instance-provisioning`. Local HEAD is `eaf9f9bdd`, rebased
   onto current `main`; the security fix is `45cfdaf14`. The remote PR head was still
   `d349dfa75088d3274c6d80c2c179f47cd3332f50`. No fix push had occurred at checkpoint.
2. The issue-specific live proof is complete and posted on the PR: reset the persistent dev
   database, reprovision, sign in through the real UI, open Chat with Moss, send
   `Reply with exactly LIVE-PATH-1258-OK`, and visibly receive `LIVE-PATH-1258-OK`. Evidence:
   https://github.com/motioneso/moss/pull/1775#issuecomment-5361674021
3. Security QA found one blocker: the independently configurable migration-owner database URL
   needed the same destructive-target guard. The local fix passes typecheck, all 16 focused unit
   tests, and all 18 fresh-database doctor integration tests. Existing security QA comment:
   https://github.com/motioneso/moss/pull/1775#issuecomment-5361811765
4. The adjacent runtime-context browser check made exactly one authorized attempt with a hard
   20-minute limit. The browser test never started because Docker was still building
   `ghcr.io/motioneso/moss:uat-smoke`. Do not retry it locally. Ben explicitly agreed to push the
   safety fix, use normal CI, then have fresh security QA reassess the exact pushed head without
   repeating that cold image build.
5. Why Docker is slow: each attempt read/wrote roughly 12 GB; the Dockerfile's `COPY . .` alone
   took about 209 seconds; build cache grew to 51.12 GB and filled `/`; pruning inactive cache
   restored 52 GB, but the next cold build consumed about 29 GB and still exceeded 20 minutes.
   The likely cause is an oversized repository build context admitted by an insufficient
   `.dockerignore`, including workspace residue/worktrees/untracked artifacts. Confirm cheaply by
   inspecting `.dockerignore`, tracing the UAT build invocation with the codebase graph, and using
   bounded `du`; do not rerun UAT. Explain this to Ben in plain English.
6. The old build agent `build1258-security-finish`, session
   `76bd7183-12d4-4012-97c6-d74744a40c20`, was interrupted and is idle. Before closing it,
   re-resolve its pane by exact session id and confirm no push is running.
7. Reconfirm the tracked tree is clean, branch/HEAD are as above, and the remote branch is still at
   the expected old head. Then perform the already-authorized mechanical push with an explicit
   lease, verify the remote head once, and consume normal GitHub CI status without reading raw
   gate logs.
8. After CI is green, run fresh Opus security QA against the exact pushed head. It must post its
   verdict to the PR and honor Ben's ruling not to repeat the cold local runtime-context build.
   Merge only after fresh QA is green, the live-proof comment remains present, and coordinator
   session authority is re-confirmed. Ben's explicit agreement is the security-tier sign-off for
   this push/CI/reassessment path.
9. After merge: update and close issue #1258/project status, prove the work landed, apply all four
   worktree-reap gates, stop any recorded dev processes by explicit PID only, clean recorded test
   data, reap the lane, and relay immediately because every security-tier merge triggers relay.
10. The shared dev instance is reset/reprovisioned and free for Food work. The account exists and
    signs in with the configured development admin password; the old familiar password is stale.
    The Food pane was informed and delivery was verified.

## Coordinator continuation — 20 Aug, PR 1775 merged and security relay

Coordinator authority before this mandatory post-security-merge relay: Codex session
`01a02192-a96b-7231-99fd-fe3655e6e141`, label `Coordinator`. The successor must replace this
authority line with its own immutable session id, confirm it is the sole `Coordinator`, then reap
this session only after resolving the exact old session id fresh.

Run result:

1. PR #1775 merged to `main` as squash commit `cb3552f9022c0f3a8ec9100faa4eb653719a6a59`.
2. Issue #1258 is closed and its Project 2 card is `Done`.
3. Exact pushed head before merge was `0970e05c0cc1b0f319e9c58f72b84180879ddb74`.
4. GitHub CI run `32430970873` was fully green: foundation/app 27m42s, compose smoke 3m12s,
   production compose smoke 2m11s, image build 15m36s, and the aggregate CI gate passed.
5. Real-UI live proof remains at
   https://github.com/motioneso/moss/pull/1775#issuecomment-5361674021.
6. Fresh Opus security QA was GREEN and merge-ready at
   https://github.com/motioneso/moss/pull/1775#issuecomment-5363758205.
7. Ben's scoped instruction not to repeat the cold runtime-context Docker/browser build is
   durably recorded at https://github.com/motioneso/moss/pull/1775#issuecomment-5363767423.
8. Docker cause, confirmed without rerunning UAT: production compose builds from the repository
   root, while `.dockerignore` does not exclude `.claude/`; the checkout had 80 worktrees, so
   Docker repeatedly packed roughly 12 GB before `COPY . .` and consumed tens of GB of cache.
9. No dev PID or seeded-row identifier was recorded in the newest handoff, so nothing was killed
   or deleted by guess. The shared dev instance was already recorded reset/reprovisioned and free.
10. The temporary QA pane/worktree/branch were reaped immediately after consuming the verdict.
11. The CI-fix agent pane is closed. Its worktree `~/Jarv1s/.claude/worktrees/pr1775-ci-fix`
    remains intentionally because the four-gate result was: ahead=27, tracked modifications=0,
    processes cwd=0, Herdr panes cwd=0. Policy says an ahead count after squash merge is still
    `keep`; do not delete it casually. Branch `pr1775-ci-fix` points at the exact pre-merge head.

This security-tier merge fires the mandatory relay trigger. The run itself is complete; the
successor's only immediate bookkeeping is to adopt authority, confirm this state, preserve the
ahead worktree unless a later authorized cleanup procedure clears it, and reap the old coordinator.
