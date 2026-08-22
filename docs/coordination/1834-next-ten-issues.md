# Run 1834 - the next ten issues

Written 2026-08-22 by the coordinator (pane w1:pKV, agent name `coordinator`,
session `f0d75fbb-74dd-45ab-89fe-b9acbd4fc293`). That session id is the lock: only the
session holding it may merge. Anyone else picking this up must re-check that first.

Ben asked for the next ten issues to be worked through, and said to swap out anything that
gets stuck rather than grind on it. He is asleep; he delegated the sign-off on pull request
1654 to the coordinator, and nothing beyond that.

## What is already running

Pull request 1654 (audit logging truthfulness plus outbound-network safety) is being proved
in a live copy of the app by the agent in pane w1:pKT. It is not part of this run's ten, but
it blocks one of them - see #1511 below.

## The ten, best first

Every one of these has a real, detailed design document that lists the exact files it should
touch. That was checked, not assumed.

| # | Issue | What it actually delivers | Design doc | Risk | Live proof needed? | Waits for |
|---|-------|---------------------------|-----------|------|--------------------|-----------|
| 1 | #1498 | Moves the command palette's leftover styling into the shared kit so it stops drifting | `specs/2026-08-10-css-guard-residue.md` | routine | yes | - |
| 2 | #1529 | Proves a chat instruction really travels the whole way to the tasks module and heals itself when a permission is missing | `specs/2026-08-10-1339-security-review-followups.md` | security | yes | - |
| 3 | #1336 | Stops the job-search board trusting whatever the server sends it without checking the shape first | `specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md` | routine | yes | - |
| 4 | #1499 | Same styling cleanup for the assistant surface | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1498 |
| 5 | #1500 | Same for shared web forms | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1499 |
| 6 | #1501 | Same for keylines and background texture | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1500 |
| 7 | #1502 | Same for the app's global styling | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1501 |
| 8 | #1503 | Turns on the automatic check that keeps all of the above from regressing | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1502 |
| 9 | #1530 | Makes a failed permission repair fail safely (closed) rather than letting the action through | `specs/2026-08-10-1339-security-review-followups.md` | security | yes | #1529 merged |
| 10 | #1511 | Checks who you are sharing with actually exists before writing the permission | `specs/2026-08-10-1137-robustness-followups.md` | security | yes | **blocked** - see below |

## What can run at the same time, and what cannot

- **Three can start immediately and in parallel: #1498, #1529, #1336.** They touch different
  parts of the codebase.
- **The styling cleanup is one long chain**: #1498, then #1499, #1500, #1501, #1502, #1503, in
  that order. They all register themselves with the same automatic style checker, so two of them
  at once would collide on the same file. The design doc numbers them in this order for that
  reason.
- **#1529 then #1530**, in that order. The design doc says #1530 needs #1529 merged first.
- **#1511 is blocked and should not be started yet.** Its design doc says it must wait for
  #1246 and for any live tasks-sharing work to clear. #1246 is still open, and pull request 1654
  is touching tasks sharing right now. Starting it would collide.

Because #1511 cannot start, the tenth active slot goes to whichever of #1335, #899 or #1105
is ready when a lane frees up. Prefer #1335 (nothing currently type-checks 54 test files) but
note it changes a shared setting that affects everyone's checks, so it should not run beside
another lane touching the same config.

## Rules every lane in this run is held to

- Plain English in every status message and handoff. Ben reads status to know whether things
  are going well, not to review code. This gets passed on to every agent and every successor.
- Green automated checks do not mean done. Anything a person can see or click needs proof it
  was actually exercised in a live copy of the app, posted on the pull request.
- The two security-tier items (#1529, #1530, and later #1511) get a tougher, deliberately
  adversarial review before they go anywhere.
- No lane touches `docs/coordination/` - that is the coordinator's alone.
- No sweeping `git add` and no repo-wide reformatting in the shared checkout.

## State

| Issue | Lane name | Pane | Branch | Status |
|-------|-----------|------|--------|--------|
| #1498 | - | - | - | not started |
| #1529 | - | - | - | not started |
| #1336 | - | - | - | not started |
| others | - | - | - | queued behind the above |

Merges since the last coordinator handover: 1 (pull request 1831, documentation only).

## Continuation note - 2026-08-22, coordinator handing off at its context limit

Written by the coordinator in pane w1:pKV (session `f0d75fbb-74dd-45ab-89fe-b9acbd4fc293`).
Handing off because my own context filled to 70 percent. Routine, nothing is wrong.

### The one thing that needs judgement, not just watching

**Ben delegated the sign-off on pull request 1654 to the coordinator and went to sleep.** His
words: "Please review 1654 in my place, I am going to sleep." That authority passes to you. It
covers pull request 1654 and nothing else. Treat it as a reason to be more careful, not less. If
the review turns up anything genuinely worrying, leave it unmerged with a short written reason
and let Ben decide when he wakes. Delegated authority is not permission to wave something through.

Before 1654 can merge, all of these must be true:
1. The build agent (pane w1:pKT, "1654 live proof") has finished proving the fix in a live copy
   of the app and posted the evidence on the pull request. It was on its fifth run, capturing the
   app's own server-side logs as well as the test result.
2. The adversarial reviewer (pane w1:pKZ, agent `qa1654-adversarial`, running on the stronger
   model) has posted its verdict on the pull request. Its brief is at
   `/home/ben/.coord-briefs/boot-qa-1654.txt` if you need to know what it was asked to attack.
3. The branch is rebased on main (it was 2 commits behind) and re-checked after rebasing.

**Already chased down and cleared, do not re-investigate:** the branch reverts a fix for an
address-spoofing hole in outbound network requests. That looked alarming on a pull request meant
to harden exactly that. It is legitimate: the fix was split into pull request #1663, which merged,
and the protection is confirmed present on main including the hex form that reaches a cloud
provider's internal metadata address. This is written up in a comment on pull request 1654.

### Lanes running right now

| Issue | Agent name | Pane | State |
|-------|-----------|------|-------|
| 1654 | `pr1654-live-proof` | w1:pKT | proving in a live app, run 5 |
| #1498 command palette styling | `pr1498-command-palette-css` | w1:pKW | plan approved by me, building |
| #1529 dispatch and self-heal proof | `pr1529-composed-dispatch` | w1:pKX | doing the pre-flight contract check the spec demands |
| #1336 job-search data checking | `pr1336-jobsearch-validation` | w1:pKY | plan approved by me, building |
| 1654 hostile review | `qa1654-adversarial` | w1:pKZ (qa tab) | just started |

Build lanes share tab w1:t2P in a 2x2. The reviewer is in its own qa tab. Keep both squared up as
lanes come and go - Ben has asked for that repeatedly and it is a standing rule, not a one-off.

### Approvals I already gave, so you do not second-guess them

- **#1498**: approved. I warned it that the shared style entry and the checker registration are
  also in scope, so "single file" was slightly wrong but harmless.
- **#1336**: approved, with a condition I want held to: dropped rows must be VISIBLY counted on
  screen, not silently discarded, and no job content may go into logs. I also told it to open a
  real GitHub issue for the match-detail follow-up rather than leave it as a sentence in a plan.

### Queue and blockers

The full queue of ten is in `docs/coordination/1834-next-ten-issues.md` (merged). Short version:
the styling cleanup is a strict chain #1498 then #1499, #1500, #1501, #1502, #1503 - they all
register with the same checker so two at once collide. #1529 must merge before #1530. **#1511 is
blocked** and must not be started: its design document requires tasks-sharing work to clear, and
1654 is touching that now. Use #1335 for that slot instead, but not beside anything else touching
shared check configuration.

### Housekeeping state

- Local main is clean and level with origin.
- Pull requests 1831, 1833, 1834 merged (all documentation).
- **Pull request 1832 is still open** - it ignores 72 leftover agent startup files and commits
  five stranded coordination documents. It is set to merge itself when checks pass. Check it.
- Pushing straight to main is blocked now; a required check must run, so even documentation goes
  through a pull request.
- Agent briefs live in `/home/ben/.coord-briefs/`, deliberately outside the repo so they do not
  red anyone's checks.
- Merges since last handover: 3, all documentation only.

### Traps I hit, so you do not

- A helper agent I dispatched in-process went silent and only emitted idle pings, never doing the
  work. I stopped it and did the job myself. If a delegated helper goes quiet, check it early
  rather than waiting.
- Checking whether an issue has a design document by searching for its number alone gives false
  negatives. Several slices are covered by a parent document that never names the child number.
- There is stray unsubmitted text sitting in pane w1:pKX's input box that I did not write. I left
  it alone rather than pressing Enter on words that are not mine. Do the same.

### Plain English, always

Every message to Ben, every handoff, every brief you write for an agent must be plain English. He
reads status to know whether things are going well, not to review code. No jargon, no coined
shorthand, keep exact names only where he must act on one. PASS THIS ON to every agent and every
successor.
