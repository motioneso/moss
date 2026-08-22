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
| #1498 | pr1498-command-palette-css | w1:pKW | 1498-command-palette-css | building |
| #1529 | pr1529-composed-dispatch | w1:pKX | 1529-composed-dispatch-proof | building |
| #1336 | pr1336-jobsearch-validation | w1:pKY | 1336-jobsearch-wire-validation | building, handing off to a fresh copy of itself now (normal, not stuck) |
| others | - | - | - | queued behind the above |

Merges since the last coordinator handover: 1 (pull request 1831, documentation only).

## Third coordinator, 2026-08-22

Took over from the coordinator in pane w1:pKV after it handed off (its context filled up, nothing
was wrong). Confirmed the fleet directly rather than trusting the status flags: all five lanes
were actively working, not stuck. Now driving as pane w1:pK0, agent name `coordinator`, session
`4341efcc-6c00-4ba9-8fd7-10730ef4feb9` - that session id is the new lock.

Pull request 1832 (documentation only) is open, waiting on one automated check, set to merge
itself once green - matches what the last note said, still just waiting.

Job-search lane (#1336) is handing off to a fresh copy of itself in the same folder mid-turn; its
own message said this is a normal handoff, not a blocker. Nothing needed from the coordinator for
that.

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

## Continuation note - 2026-08-22, third coordinator handing off at its context limit

Written by the coordinator in pane w1:pK0 (session `4341efcc-6c00-4ba9-8fd7-10730ef4feb9`, agent
name `coordinator`). Handing off because my own working memory filled up. Routine, nothing wrong.

### The pull request 1654 sign-off - still not ready, and here is why

The tough outside reviewer (running on the stronger model) came back with a real, confirmed
problem: merging the branch as it stood would have quietly deleted a security fix that is already
protecting the live app - the guard that stops outbound requests being tricked into calling the
cloud's internal metadata address - plus five safety tests for outbound requests and one sharing
test, even though the pull request's own title claims it adds that last one. This was not a false
alarm; the reviewer proved it by merging the branch into a scratch copy of the app and reading the
result. Full verdict is posted on the pull request.

The fix is simple and I already sent it to the build lane (`pr1654-live-proof`, pane w1:pKT): pull
in the latest main and remove two specific old commits that undo the earlier fix, rather than
trying to resolve them as conflicts. I also told it that the reason it was still waiting to prove
the feature works on a real running copy of the app - a since-closed other ticket - is no longer a
reason to wait, so it should go ahead and get that proof now too.

**As of this handoff, I have not seen it report back yet.** Read the pull request's own comments
first to see whether it has, and where things stand, before believing anything about status
flags - one flag on this exact lane has shown "done" while it was still working, more than once.

Do not merge 1654 until all three of these are true: the rebase is done and rechecked, a real
person could see the feature working end to end and there is proof of that posted on the pull
request, and the reviewer has looked at the corrected branch and said it is now fine. That sign-off
is delegated to the coordinator by Ben himself, not routine - be careful, not fast.

### The rest of the queue

- **#1498** (moving leftover command-palette styling into the shared design package): the agent
  doing this work has handed off to a fresh copy of itself twice. The first fresh copy accidentally
  started on the wrong, more expensive model by a tooling default - caught before it touched any
  files, closed with nothing lost, and restarted correctly. The current copy is pane w1:pM3, agent
  name `pr1498-cp-css-r2`, and was started with the right model but I had not yet visually
  confirmed its screen shows the correct model name when my own memory ran out - check that first
  thing. The actual work reported as done before this last handoff: the leftover styling moved out
  cleanly, the automatic checker reports no problems, and formatting/lint/type checks are clean.
  Still needed: before-and-after pictures of the command palette on a real running copy of the app
  to prove it looks the same, then opening the pull request.
- **#1529** (proving a real chat instruction reaches the tasks feature and safely grants a missing
  permission on its own): pull request is open, number 1838. This is a security-tier item, so it
  needs the tough outside review before it can merge, same as 1654. That review is already running
  - pane w1:pM4, agent name `qa1529-adversarial`, on the stronger model, in its own tab labelled
  "qa" (tab id w1:t2T). Its brief file, in case you need to know exactly what it was asked to
  check, is `/home/ben/.coord-briefs/boot-qa-1529.txt`. Watch the pull request for its verdict; do
  not trust a status flag alone.
- **#1336** (checking that the job-search board doesn't trust bad data from the server): handed off
  to a fresh copy of itself once already; current pane w1:pM1, agent name
  `pr1336-jobsearch-validation2`, correctly on the ordinary model. Work in progress per its own
  report: the shape-check itself is written and wired into the code that reads the board, so bad
  rows get dropped and counted rather than shown broken. It also opened a follow-up ticket, #1835,
  for a related call this work does not cover, rather than quietly expanding scope. Still needed:
  showing the person a plain count of dropped rows, the same kind of check on the server side with
  a safe log message, tests, the full check suite, and opening the pull request.

### Other loose ends

- Pull request 1832 (documentation cleanup only) is open and set to merge itself once its one
  remaining automated check finishes. It has been sitting on that same pending check for a while
  across two handovers now - worth a look in case it is actually stuck rather than just slow.
- My own bookkeeping pull request, 1837, already merged - the state table in this file is current
  as of this handoff.
- No direct push to the shared main line works any more - a required check blocks it, even for a
  documentation change like this one. Everything, including this note, has to go through a branch
  and a small pull request that merges itself once green. Budget time for that.
- The QA review lane for pull request 1654 finished its job and has already been closed down
  cleanly - nothing left over from it.
- Nothing is currently sitting in the file that tracks decisions only Ben can make
  (`docs/coordination/AWAITING-BEN.md`) - it is empty of live questions as of this handoff.

### Plain English, always (repeating on purpose)

Every message to Ben, every handoff, every brief written for an agent must be plain English, no
jargon, no coined shorthand, exact names only where someone must act on one. This is not optional
and it applies to every agent spawned, not only the one driving. Ben has said this more than once.

## Fourth coordinator, 2026-08-22

Took over from the third coordinator while it was mid-compaction. Its pane was w1:pK0; I am now
driving from pane w1:pM5, agent name `coordinator`, session `7eb106c9-6111-4749-8c13-ffb3d7a01445`
- that session id is the new lock. The old pane has been closed.

**Pull request 1654 - checked directly, good news:** the build lane already did the fix. Its
worktree is rebased on the very latest shared history, the two bad old commits are gone, the
guard code that blocks the cloud metadata address is back, and both test files the reviewer said
were being deleted are back too. It is now actively running the real-in-app proof (a background
check is watching it). Still needed before this can merge: that proof needs to finish and get
posted on the pull request, and then the tough outside reviewer needs to look at this corrected
version and say it is fine - the reviewer from before has already been closed down, so a fresh one
will need to be started once the proof is posted. Do not merge before then.

**#1498 (styling cleanup):** still working, mid-turn. Asked it directly which model it is running
on; no answer yet because it has not finished its current turn. Check back for that answer before
trusting it is on the right one.

**#1529:** unchanged - pull request 1838 open, the tough outside review is still running, watching
for its verdict.

**#1336:** unchanged - still building, running its full check suite right now.

**Pull request 1832 (documentation cleanup):** checked directly - it is not stuck. Its one
remaining check is a long one that runs sixteen steps and is currently partway through step seven,
right on the kind of timing that check normally takes. Nothing to do here but keep waiting.

Nothing new in `docs/coordination/AWAITING-BEN.md` - still empty.

## Fourth coordinator, handing off at context limit, 2026-08-22

My own working memory hit the point where I need to hand off. Nothing is wrong, this is routine.
Handing off from pane w1:pM5 (agent name `coordinator`, session
`7eb106c9-6111-4749-8c13-ffb3d7a01445`). A background check that watches the fleet's pane states
is running and will keep notifying whoever holds this session about changes - a successor should
either keep it or start its own the same way (a script that snapshots pane states every so often
and only speaks up when something changes).

**Pull request 1654 - still the one thing that needs judgement, not just watching.** Same as
before: the build lane already fixed the problem the tough reviewer found (it is rebased on the
current shared history, the two bad commits are gone, the security fix and the deleted tests are
back). It is still running its real-in-app proof - I watched it cycle through several rounds of
work without yet posting anything new to the pull request, which is normal for this kind of check,
not stuck. Still needed before merge: that proof needs to finish and get posted, and then a fresh
tough outside review of this corrected version (the old reviewer already finished and was closed
down, so a new one needs to be started once the proof is posted). Do not merge before both of
those happen.

**#1498 (styling cleanup) - now has its own pull request, 1841.** The lane reported it as finished
with all checks green and live screenshots attached, but when I checked directly the automated
checks were still running, not actually green yet. I told the lane this (no action needed from it,
I said I would watch and merge once they pass) and separately asked it directly which model it is
running on, since this lane was flagged twice now for accidentally starting on the expensive model.
Waiting on that reply. Do not merge 1841 until the checks are confirmed actually green and the
model question is answered.

**#1529:** unchanged - pull request 1838 open, the tough outside review is still running.

**#1336:** unchanged - still building, running its full check suite.

**Pull request 1832 merged while I was driving** (documentation cleanup, the one that had been
sitting on one long check across three handovers). No action needed, already landed on the shared
line.

Nothing in `docs/coordination/AWAITING-BEN.md` - still empty, nothing needs Ben's decision right
now.

## Fifth coordinator, taking over, 2026-08-22

Took over from the fourth coordinator, which had already spawned me and confirmed I was up and
running on the right model. I am driving from pane w1:pM7, agent name `coordinator`, session
`2aa2933e-426f-4ea7-b1af-6b40e971e829` - that session id is the new lock. The old pane (w1:pM5)
has been closed. The fleet-watching background check that the fourth coordinator had running lived
in that same pane, so it stopped when the pane closed - I started a fresh one the same way (a
script that checks pane states every so often and only speaks up when something changes).

**Pull request 1654 - still not ready, this is the one thing that needs real judgement, not just
watching.** The build lane already fixed the problem a tough outside review found earlier
(rebased on the current shared history, the two bad commits removed, the security guard and the
deleted test files both restored). It is now running its own proof on a live copy of the app. Do
not merge until: that proof finishes and is posted on the pull request, and a fresh tough outside
review of this corrected version says it is fine (the earlier reviewer already finished and was
shut down, so a new one has to be started once the proof is posted). This sign-off was delegated
to the coordinator by Ben directly - be careful, not fast.

**#1498 (styling cleanup):** has pull request 1841 open. Reported done with checks green and
screenshots attached; still need to confirm directly that the checks are actually green (they were
not, last time anyone checked), and still owed a plain answer on which model this lane is running
on (it has twice started on the wrong, more expensive one by accident). Do not merge until both are
confirmed.

**#1529:** unchanged - pull request 1838 open, the tough outside review is still running, watching
for its verdict.

**#1336:** unchanged - still building.

Nothing in `docs/coordination/AWAITING-BEN.md` - still empty.

## Sixth coordinator, handing off at context limit, 2026-08-22

My own working memory hit the point where I need to hand off. Nothing is wrong, this is routine.
Handing off from pane w1:pM7 (agent name `coordinator`, session
`2aa2933e-426f-4ea7-b1af-6b40e971e829`). I restarted the fleet-watching background check myself
after the last handoff closed the pane it was running in - a successor should start its own the
same way (a script that snapshots pane states every so often and only speaks up when something
changes) since it dies with the pane, not with the run.

**Pull request 1654 - still the one thing needing real judgement.** Unchanged in substance: the
build lane fixed the earlier problem (rebased on current shared history, bad commits gone,
security guard and deleted tests restored). It is running its live-app proof now - I caught it
completely frozen once (no progress for many minutes, identical screen) and unfroze it with a
plain "continue" message; it is working again now. Nothing posted to the pull request yet. Do not
merge until: the proof finishes and is posted, and a fresh tough outside review of this corrected
version says it is fine (the earlier reviewer already finished and was shut down). This sign-off
was delegated to the coordinator by Ben directly - be careful, not fast.

**#1498 (styling cleanup), pull request 1841 - watch this one closely, it keeps freezing.** I
caught this lane completely stalled mid-turn three separate times this session (identical screen,
no progress) and had to nudge it back to life each time with a plain "continue" message each time -
that is a real pattern, not a one-off, worth mentioning to Ben if it happens a fourth time. Separately,
I noticed its own pane is undersized (5 lines tall next to a neighbor at 27 lines) - that is
probably why its answers looked like they were producing nothing, the text was likely scrolling out
of a too-small window rather than the lane failing to answer. **This still needs the standing
"square up the tab layout" fix - I ran out of context before doing it; do that first.** I checked
its checks directly and they were still running, not green, as of the last check - recheck with
`gh pr checks 1841`. Still also waiting on its direct answer to "which model are you running on" -
asked twice, no confirmed answer seen yet (its display was too small to read reliably, see above).
Do not merge until checks are confirmed green and the model question is answered.

**#1529, pull request 1838 - the tough outside review came back RED, but the real problem is small.**
Verdict: the security substance was fine (no way for one person's data or permissions to leak to
another), but CI itself failed because the pull request's own new test adds two fake user records
whose ids collide with ids two other test files already use, so all three fail together with a
duplicate-key error when the whole suite runs. I told the build lane exactly which two other files
collide and what to fix; it started working on the fix. Re-check pull request 1838's checks and,
once green, this still needs a second review pass before it can merge (security tier) - the
reviewer that found the RED verdict already finished and is closed.

**#1336 - opened its own pull request, number 1844, since the last note.** Have not yet reviewed
it or checked its tier/checks - do that first thing.

**Pane layout note:** the Builders tab (four lanes) is lopsided - one pane is only 5 lines tall,
another is 27. This is the standing "keep tabs squared up" rule and I did not get to it - fix
before spawning anything else into that tab.

Nothing in `docs/coordination/AWAITING-BEN.md` - still empty; nothing has needed Ben's decision
yet, but if #1498's freezing pattern repeats a fourth time, or #1654's proof stalls again after
being nudged, that is worth flagging to him rather than nudging forever.
