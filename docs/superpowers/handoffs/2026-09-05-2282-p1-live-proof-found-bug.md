# 2282 news sources, phase 1: live proof found a real bug, needs a new slice

Do not relay this doc again — the prior relay budget for this slice is used up. This is a stop
and re-slice, per the box-wide rule: split the work instead of continuing in one more session.

Branch: `build/2282-news-sources`, worktree `.claude/worktrees/news-sources-2282`, PR 2298 (draft).

## What happened

Picked up the live-proof step from `docs/superpowers/handoffs/2026-09-05-2282-p1-e2e-liveproof-relay.md`
(read that file for the original task). Starting the app on the alternate ports found two problems,
one fixed, one not:

1. **Fixed and committed** (commit `9788410bd`). The app would not even start: a description in
   `packages/news/src/manifest.ts` (the "add a source" feature) was 341 characters, over the
   app map's 240-character limit, so the server threw on startup. Shortened it; the one test that
   checks its wording (`tests/unit/news-manifest.test.ts`) still passes.

2. **Found, not fixed.** With the app actually running and a real browser adding `r/technology`
   the same way a person would, the add was refused with "That source isn't allowed by the content
   policy." This is a real defect, not a live-proof artifact — every existing automated test fakes
   this step, so nothing caught it before now.

## The real bug

The code that checks whether a source is allowed always asks the AI model to classify it as one
specific thing: a "news publisher." A subreddit is not a publisher, so a real model correctly
answers "this is something else," and the code then treats "something else" as rejected —
regardless of whether the content itself is fine.

Where this lives:
- The check itself: `packages/news/src/discovery/policy-validation.ts`, function
  `decideSourcePolicy` (around line 42) and its schema `sourceSchema` (line 9) and its wording
  in the prompt (line 74).
- The place that calls it for a subreddit: `packages/news/src/discovery/source-resolution.ts`,
  function `resolveSubreddit` (around line 360-401) calls the exact same check used for regular
  publishers, with no way to tell the model "this one is a community, not a publisher."
- Why the existing automated test for this never caught it:
  `tests/unit/news-source-resolution.test.ts`, the fake AI helper near the top of the file
  (functions `ai` and `aiSpy`, around lines 20-35) always answers as if everything were a "news
  publisher," so the subreddit tests in that file (the `describe("resolveSourceInput: subreddits")`
  block, from line 795) never exercise the case a real model actually returns.

## Suggested fix (not started)

Give the check a second mode for "this is a community, not a publisher" so a subreddit can be
approved as itself rather than being compared against the wrong label:

- Add a way to tell `decideSourcePolicy` which kind of thing it is checking (publisher vs.
  community), defaulting to publisher so the other two callers
  (`source-resolution.ts` line ~551, `compilation/candidates.ts` line ~442) are untouched.
- Adjust the schema and the wording sent to the model so a community is judged as itself.
- Update `resolveSubreddit` to say "this is a community."
- Update the two subreddit tests that currently expect success
  (`tests/unit/news-source-resolution.test.ts` lines ~806 and ~880) so their fake model answers
  match what the real code will now ask for.
- Re-run the live proof end to end once this is fixed. Nothing was saved to the database this
  session — the add attempt failed before any save, so there is nothing to clean up there.

## State of the worktree

Clean except for the one committed fix above. No servers running (both were started and then
stopped by exact process id after the finding above; nothing left listening on the alternate
ports). No database rows were added.

## Report to the coordinator

Tell the agent named "coordinator" (`herdr agent prompt coordinator "<message>"`, after confirming
its current pane with `herdr pane list`) that: the app-map length problem is fixed and committed,
but the actual feature does not work yet — a subreddit is always refused by the content check
because that check only knows how to judge "is this a news publisher," never "is this a
community." This needs its own follow-up slice to fix the check itself, not another live-proof
relay. Say where the diagnosis is written down (this file's path) so the next session does not have
to re-discover it.
