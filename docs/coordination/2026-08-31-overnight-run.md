# Overnight run — night of 2026-08-30 into 2026-08-31

Ben set this run up in conversation just before going to bed, then went to bed. Nothing here is
waiting on him. If you are a new coordinator picking this up, read this whole file first - it is the
live state doc for the night. Update it as you go.

## Ben's rules for tonight, in his own decisions

1. **How the coordinator hands off.** The coordinator may let its own context be compacted twice.
   Before the end of that third stretch, it hands off to a fresh coordinator. This replaces the
   usual "relay after every two merges" rule for tonight. Ben asked explicitly that this be followed
   through the night, so pass it on in every handoff you write.
2. **The two security fixes are pre-approved to merge.** Issues 1612 and 1679 normally need Ben's
   personal sign-off before merging. He gave it in advance. A clean review plus passing tests is
   enough - merge them, do not park them waiting for morning.
3. **His own hands-on judgment on the time work is no longer required.** He dropped that gate
   earlier this evening. Agents judge tone themselves from the automated checks and demo
   conversations.
4. **Use Codex models, not just Claude.** He asked specifically that the next builders run on the
   GPT 5.6 luna model at high effort. Two lanes were started that way. Keep mixing providers and
   models for later spawns rather than defaulting everyone to Claude.
5. **Plain English everywhere**, from every agent, in every message and handoff. No jargon, no
   invented shorthand. Exact names only where someone must act on them.

## What Ben chose to spend the night on

- Finish the time work: issue 1869 slices 2, 3A and 3B.
- Clear the two small security fixes: issues 1612 and 1679.
- Chase the raw-tool bug: issue 1719.
- Push all three stalled pull requests to done: 2101, and the two drafts 2106 and 2107.

## Where things stood when the night started

The board is nearly clear: 900 items tracked, 875 done, 12 marked Ready, 12 Backlog, 1 in review.
Eight of the twelve Ready items cannot be built because they have no approved spec yet, which is a
hard gate on this project. That is why the list above is what it is.

Pull request 2129 (the per-turn time context, issue 1869 slice 1) passed both of its gates tonight -
a real three-turn conversation check and a full code review - had two review notes fixed on top, and
was set to merge automatically once its checks finish. Everything downstream waits on that.

## Lanes running

| Work | Issue / PR | Agent name | Pane | Branch | Program |
|---|---|---|---|---|---|
| Spawned check leaks the real home folder | #1612 | `issue-1612-lane` | `w1:p3N` | `build-1612-multiplexer-env` | Codex |
| Tool failures lose their own message | #1679 | `issue-1679-lane` | `w1:p3R` | `build-1679-safe-errors` | Codex, GPT 5.6 luna, high |
| Assistant grabs raw tools and reports false failures | #1719 | `issue-1719-lane` | `w1:p3S` | `investigate-1719-raw-tools` | Codex, GPT 5.6 luna, high |

Issues 1612 and 1679 are builds and end in a pull request. Issue 1719 is an investigation first: it
only builds if the fix turns out small and clearly safe, otherwise it writes up the options on the
issue and stops.

## Queued, not yet started

Start these as lanes free up. Do not run more than about five building lanes at once - the machine
has sixteen cores and was at roughly a third of its memory when the night began.

1. **Issue 1869 slice 2** (`chat.getCurrentTime`) and **slice 3A** (converting wall-clock times in
   the module toolkit). Both wait for pull request 2129 to merge, then each gets its own work folder
   and branch - never the same one, and never the folder slice 1 used. The approved spec is
   `docs/superpowers/specs/2026-08-30-1869-date-time-context.md`.
2. **Issue 1869 slice 3B** (the food-logging fix) starts only after slice 3A lands.
3. **Pull request 2101** - module-built chat tools going live without a restart. It is finished and
   not a draft, but has sat since early evening. It needs a review and a live check, not more
   building. Its old lane is idle in pane `w1:p2J`; check that folder for uncommitted work before
   closing it.
4. **Pull requests 2106 and 2107** - both drafts. Work out what each still needs before putting a
   lane on it.

## Standing gates that still apply tonight

- A user-facing change is not done on green tests and code review alone. It needs a real hands-on
  check on a running copy before it merges.
- Live checks must not run two at a time against the same running instance. Lanes have been starting
  their own temporary copies on unused ports (3199 and 5199 have been the pair in use); keep doing
  that, and confirm the ports are free again afterwards.
- Anything touching a database must go through the verify-gate skill. Never a bare test command.
- No two agents in one work folder or on one branch.
