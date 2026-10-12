# Handoff: land the scheduled tasks branch into main (PR 3154)

Written 2026-10-11 by the coordinator session that kept the branch in step with main.

## Plain English, always

Ben reads status to know whether the work is going well, not to review code. In chat, status
updates and reports, name things by what they do, not by what the repo calls them. Keep exact
names only where he must act on them (a command, a file, an error string). At most one backtick
per sentence, no coined shorthand, plain ASCII punctuation. Commit messages, code comments and
PR bodies stay precise and technical. Pass this rule on to every agent you spawn and every
handoff you write.

## Where things stand

- PR 3154 merges the branch `integration/scheduled-proactive` into main. It is still a draft.
- Branch tip is 99b83b531. Main is one release-notes commit ahead.
- PR 3154 has no conflicts with main. It is blocked only by draft status and checks.
- No open PRs target the branch. No builders are running. Today's worktrees and branches are
  cleaned up.
- Main allows merge commits. Its only rule is required status checks.

Merged into the branch on 2026-10-10 and 2026-10-11:

| PR                                 | What it did                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| 3333                               | One quiet-hours editor on Alerts & quiet hours (#3130)                    |
| 3385                               | Choose between differing saved quiet hours (#3131)                        |
| 3370                               | Return safely to an interrupted conversation (#3128)                      |
| 3363                               | A due reminder appears at once in the open Main chat (#3195)              |
| 3391                               | Reminders at a local clock time with a deadline and late recovery (#3150) |
| 3398                               | Legacy email monitoring kept under combined alert settings (#3146)        |
| 3341, 3381                         | Chat fixes: launch replay never runs a tool; gate time limit per model    |
| 3364-3371, 3388, 3420              | Live and browser tests moved onto Conversations > New side chat           |
| 3389                               | One approved Claude sign-in reused across installed test runs             |
| 3455                               | Classifier chat journey proves the run-without-asking side again (#3362)  |
| 3374, 3402, 3431, 3443, 3454, 3461 | Syncs from main                                                           |

## What is not known yet

- The PR 3154 description is out of date. Its remaining-work list:
  - #3191 not verified on the PR
  - #3192 and #3193 not done
  - remaining native work
  - a whole-branch review
  - current checks
  - live proof

  Later PRs above may have done some of this. Nobody has checked item by item.

- Issue state cannot tell you what is done. All 40 issues PR 3154 closes stay open until it
  merges.
- CI never ran on the last commit of PR 3461 (4080104759d). That commit only adds a wait to one
  unit test. This branch has no required checks, so auto-merge went through at once. The first
  full CI run on the current tip will be the one on PR 3154.

## The job

1. Build an honest done list. For each issue PR 3154 closes, record:
   - the PR that did it
   - the proof, which must be live proof for anything a user sees

   Anything without proof is not done. Keep the list in a state file outside the transcript.

2. Ask Ben early whether PR 3154 should wait for every issue, or merge with unfinished issues
   moved out of its "Closes" list into follow-ups. This is his decision. Use `needs-ben` and
   the AWAITING-BEN file if one exists.
3. Get CI green on PR 3154 at the current tip.
4. Get a whole-branch review from a fresh Opus 5.5 session with no background. Run the
   Standards lens (docs/DEVELOPMENT_STANDARDS.md) first, then the Spec lens (the #3096 spec).
5. Record live proof on a disposable install with a real model:
   - Claude sign-in, cheapest model
   - a port from `devports claim`
   - never 5173, never 1533
6. Rewrite the PR body to match the truth, including the Release note section. `gh pr edit`
   cannot change a PR body here, so use a REST PATCH.
7. If main has moved, sync it into the branch first, through its own PR. PRs 3443, 3454 and
   3461 are the pattern.
8. Merge PR 3154 with a merge commit (`--merge`) at the full head SHA, so the branch history
   survives. Merging is the agent's job, not Ben's.

## Open follow-ups

- #3444, flaky chat drawer unit test. Fixed on the branch by commit 4080104759d; main still has
  the flaky version. Close the issue once PR 3154 lands.
- #3460: evening planning in auto mode skips new task blocks when the same save also moves a
  block.
- #3427: classifier checks lose their label and confidence under a Claude sign-in. The
  confidence half of chat journey case 11 waits on it.
- #3362, chat journey. Cases 8 and 10 only log how many calls ran. They rely on the helper
  throwing "never ran" when a call does not happen. This is minor and not a blocker.

## How work runs here

- Builders are Codex gpt-6.1-sol in herdr panes in your own tab, at most four panes per tab.
  Close each pane when its PR merges.
- Reviewers are fresh Opus 5.5 sessions with no background.
- Run database tests only through the `verify-gate` skill, with an isolated database.
- This branch has no required checks, so `--auto` merges into it at once. Read CI yourself
  before merging into it.
- Merge methods:
  - syncs into the branch use `--merge`
  - feature and test PRs into the branch use `--squash --match-head-commit <sha>`
- Known flakes not to bisect over:
  - the chat dark-theme browser test
  - the gateway pattern timeout
  - the module-sdk-worker local failures
