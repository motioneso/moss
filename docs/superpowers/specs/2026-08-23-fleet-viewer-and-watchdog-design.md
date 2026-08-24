# Fleet fixes: close the overnight gaps, then the viewer — design

Date: 2026-08-23
Status: approved direction; Ben's four rulings of 2026-08-23 are folded in below. Replaces the
earlier viewer-and-watchdog draft of the same date.

## Why this spec changed shape

The first draft covered a lane watchdog and a nicer screen. An adversarial review of the daemon
found bigger problems underneath: one way the fleet can merge an unproven user-facing change on
its own, three ways a lane stalls forever once its first agent exits, and three loops that spend
a model call every minute all night. The same evening, a live run then demonstrated a defect
the review had not: the whole fleet froze in silence when GitHub stopped answering questions,
and the freeze was indistinguishable from normal progress (unit 2). The watchdog and the screen are still here, but they ship
last, because none of them matter if the fleet strands its lanes or burns money while everyone
sleeps.

The goal, restated: the fleet runs start to finish with nobody awake, merges every issue it
works except security-tier sign-offs, and spends model calls only on real judgment.

Two constraints are settled and not revisited here:

- No supervising model watching agents all night. That token cost is the thing the daemon
  exists to avoid. Every fix below is a script, a state change, or a bounded one-shot call.
- No model name anywhere in daemon or viewer code, except the one seed table in the launcher's
  setup file, which a test already guards.

## Ship order

Eight units, each one pull request. Units 1 through 5 must land before the next unattended
overnight run: without them the fleet can merge an unproven change (unit 1), freezes the whole
run in silence when GitHub's answer allowance runs out (unit 2, observed live tonight), strands
most lanes that hit any bump (unit 3), can burn a model call a minute (unit 4), and silently
wedges its merge step (unit 5). Units 6 through 8 follow in order; the fleet is safe to run
overnight without them, just rougher around the edges.

Unit 2 sits that high, above lane recovery, because of how the two fail. Every other defect
strands one lane and leaves evidence a human can read in the morning. This one freezes every
lane at once and writes nothing at all - the board looks like normal progress. It has already
happened once, at a single lane, at eight in the evening; at five lanes and thirty agents it is
close to guaranteed. Unit 1 stays first only because it is tiny and it is the one defect that
can break production rather than waste a night.

---

## Unit 1: make the live proof check unfoolable

**The bug.** A user-facing pull request may only merge after live proof is posted on it. Today
the daemon checks this by searching every comment on the pull request for the words "live-path
proof". Any comment containing the phrase passes, including a reviewer writing "there is no
live-path proof on this PR". That false pass turns on auto-merge for an unproven user-facing
change, which is the one way the fleet can break production on its own.

**The fix.** The proof must be a comment whose first line is exactly:

    LIVE-PATH PROOF

and the daemon accepts only a comment that starts with that line, nothing before it. The build
brief and the wrap-up instructions are updated to say: post your proof with that exact first
line, then the evidence below it.

**Why this over the alternatives.** A pull request label would be simpler to check but carries
no evidence and can be added by mistake. A required CI check would be strongest but means new
CI wiring for what is a formatting rule. An anchored first line costs one changed grep and one
changed brief, and a review comment discussing missing proof can no longer pass, because prose
does not start with that marker line.

**Tests.** The daemon's dry-run test gains two cases: a pull request whose only mention of the
phrase is inside a reviewer's sentence stays parked; a pull request with a properly anchored
proof comment proceeds to merge.

**Live proof for this unit.** On a live dev instance: a real pull request carrying only a
"no live-path proof found" style comment is shown staying parked across a tick, then the same
pull request with a real anchored proof comment is shown moving to merge. Both recorded on the
unit's own pull request.

---

## Unit 2: silence must never read as progress

**The bug, observed live on 2026-08-23.** Issue 1422's pull request went fully green at 02:38.
The daemon ticked every minute afterwards and never advanced the lane, and wrote no log line.
Cause: the daemon asks GitHub for a pull request's check results through GitHub's query
service, whose hourly answer allowance is shared by every agent and tool on this box. The
allowance was exhausted. When that happens, the command the daemon runs prints a rate-limit
error and still exits as if it succeeded, with no results. The daemon saw zero failing checks
and zero finished checks, concluded the build was still running, and settled in to wait
forever. One lane hit this at eight in the evening; an overnight run at five lanes shares the
same single allowance, so this is the failure mode where Ben wakes up to a frozen fleet, a
board that says everything is in progress, and nothing done.

Note that unit 5's stuck-checks deadline does not save us here: that deadline fires when the
daemon knows checks are pending too long. In this failure the daemon never learns anything at
all - it cannot tell a starved answer from a build still running.

**The fix, in three layers, ordered from the specific defect out to the general disease.**

- **Never trust an empty answer from a command that claims success.** Everywhere the daemon
  asks GitHub something and gets nothing back, "nothing" stops meaning "no news, wait" and
  becomes a distinct condition: the error text is captured instead of thrown away, and a
  rate-limit message is recognised and handled as "GitHub is refusing to answer right now",
  never as "checks still running". Today the daemon discards every error message these
  commands print, which is exactly why this failed without a trace. Rate-limit responses are
  logged once per tick at fleet level - one line, not one per lane, so a starved hour does not
  flood the log.
- **Ask the healthier door first.** GitHub exposes check results through two separate doors
  with separate allowances: the query service the daemon uses today (which was at zero), and
  the plain REST interface (which was at 4999 of 5000 at the same moment, because almost
  nothing on this box uses it). The daemon switches to the REST interface as the primary
  source for check results and merge state, and keeps the current command only as the
  fallback when REST itself fails. This is the cheapest real fix: same information, an
  allowance nobody is competing for. Also, when GitHub reports the allowance exhausted, the
  daemon backs off: it marks the whole tick as starved, skips the remaining GitHub questions
  that tick instead of burning one failed call per lane, and resumes normally once an answer
  succeeds. The reply says when the allowance resets, and the daemon believes it rather than
  hammering.
- **A stillness alarm, regardless of cause.** The general disease is silence reading as
  progress, and the next silent failure will have a cause nobody has met yet. So the daemon
  gets one cheap, cause-blind rule: at the end of each tick it checks, from the records it
  already has in hand, whether any lane in a supposedly moving state (waiting on checks, in
  review, merging) has gone a full hour with no record change and no log line. If so it
  raises a fleet-level warning: one line in the log, a banner line on the board, and the
  viewer shows it in the header next to the judge alarm from unit 6. It does not park the
  lane and does not spawn anything - the specific deadlines in units 3 and 5 own the acting;
  this alarm owns the noticing, so that even a failure those deadlines cannot see still
  leaves a visible trace by morning. It costs no GitHub calls and no model calls, only a
  comparison of timestamps the tick already read.

**Why this over the alternatives.** Retrying the same starved query harder does nothing; the
allowance is shared and empty. Giving the fleet its own dedicated GitHub identity would truly
isolate its allowance and may be worth doing someday, but it is account setup and credential
handling for a problem the REST door solves today with zero new secrets. And relying on the
stillness alarm alone, without the first two layers, would tell Ben the fleet froze without
making it stop freezing.

**Tests.** The tick tests already run against stubbed GitHub commands, so the fixtures gain: a
check query that exits clean but prints a rate-limit error routes to "GitHub refusing to
answer", not "still running"; a starved tick skips remaining GitHub questions and touches no
lane state; the REST door is asked first and the old door only on REST failure; a lane
unmoved for an hour in a moving state raises the stillness warning and a parked lane does
not; the warning appears once, not once per lane per tick.

**Live proof for this unit.** Reproduce the real event: on the dev box, exhaust the query
allowance (or point the daemon at a stub that answers exactly what GitHub answered at 02:38),
with a live lane green and waiting. Show the daemon advancing the lane anyway through the
REST door, and show the log carrying the rate-limit line instead of nothing. Separately,
freeze a lane record by hand for an hour and show the stillness warning on the board and in
the viewer header. Recorded on the pull request.

---

## Unit 3: lanes must recover after their first agent exits

**The bug, in three parts.** A build agent ends its session when it opens the pull request.
Everything the daemon does after that assumes someone is still listening, and nobody is:

- Failing checks are a dead end. The daemon posts a comment asking "the lane agent" to fix and
  push. That agent is gone. Nobody reads pull request comments. The lane sits in the
  checks-failing state forever and is not even marked as needing Ben. The "same check failed
  twice, stop the line" rule is dead code, because a second failure needs a push that never
  comes.
- A failed review is nearly as bad. The lane is put back to "being built" with nobody building.
  The only rescue is the dead-agent check: thirty minutes of silence, a judgment call, then a
  respawn with the original build brief, which says nothing about what the review found. That
  accidental respawn also burns the lane's one allowed restart.
- A crashed reviewer strands the lane permanently. The dead-agent check only covers the
  "being built" state, so a lane stuck "in review" with a dead reviewer is never noticed.

**The fix: a deliberate fix agent, and a wider dead-agent check.**

When checks fail, or a review fails, the daemon does not wait for anyone. On the next tick it
spawns a fix agent into the lane's existing worktree with a fix brief the daemon writes at that
moment, containing: the failing check names (for red checks) or the reviewer's findings pulled
from the pull request comments (for a failed review), the branch, and the same report-back
commands every brief carries. The fix agent pushes, sets the record back to "pull request open,
waiting on checks", and stops.

**How recovery spends the budget.** Every recovery spawn - a fix agent, a re-spawned reviewer,
a conflict-resolver from unit 5 - counts against the same nightly spawn budget as everything
else, and respects the memory floor. One number stays honest that way; a separate recovery
budget would be a second dial to misconfigure. But the budget is split by purpose: the last
fifth of it (six spawns, at the agreed thirty) is reserved for recovery. New lanes stop being
dispatched once the unreserved part is used, so a busy night can never spend the whole budget
starting fresh work and then have nothing left to rescue it with. When the entire budget is
gone and a lane still needs a recovery spawn, that lane parks at once with the reason "spawn
budget exhausted" instead of waiting silently - a parked lane with a readable reason is the
correct end state for a night that ran out of fuel, and the reserve makes it rare.

Bounds: each lane gets at most two fix rounds per cause (two for red checks, two for review
findings). A third failure of the same kind parks the lane with a plain reason and a question
for Ben. This replaces the old two-strikes check-name counting, which could never fire. Fix
agents are new sessions, not relays; they do not touch the relay counter, because the relay
rule exists to catch one agent handing off to itself, not the daemon dispatching new work.

The dead-agent check extends to the review state: if the recorded reviewer is gone from the
agent list and the record has been quiet for fifteen minutes, respawn the review round once;
if the respawned reviewer also dies, park with a plain reason. Fifteen minutes rather than the
build state's thirty, because a review round is short and cheap to redo.

The record also stops losing track of the builder: today the one agent field is overwritten by
the reviewer's name, which is how the accidental-respawn confusion happens. The record gains a
second field for the current reviewer, so the build agent and review agent are never conflated.

**Why this over the alternative.** The obvious alternative is keeping the build agent alive
until merge so it can respond to red checks and review findings. That is exactly the idle
token-burning session this whole design forbids: an agent parked in a pane waiting for CI is
the resident coordinator problem again at lane scale. A daemon-dispatched fix agent costs one
spawn only when there is actually something to fix.

**Tests.** Dry-run cases: red checks produce a fix-agent spawn with the check names in the
brief; a failed review produces a fix-agent spawn with the findings in the brief; a third
same-cause failure parks; a dead reviewer is respawned once and a twice-dead reviewer parks;
the builder field survives a review round; a fresh lane is refused dispatch once only the
recovery reserve remains while a fix agent is still granted; a lane needing recovery with the
whole budget spent parks with the reason "spawn budget exhausted".

**Live proof for this unit.** One real lane on the dev box driven through a deliberately
failing check, the fix agent observed fixing and re-pushing, and the lane reaching merge, all
with nobody typing into any pane. Recorded on the pull request.

---

## Unit 4: stop the repeating model calls

**The bug, in three loops.** Each of these asks a model the same question once per tick, which
is once per minute, with no memory and no cap:

- Deputy loop. With the deputy on, a parked lane past the waiting period triggers a deputy call
  every tick. A PARK ruling changes nothing on disk, so the next tick asks again. One parked
  lane is roughly sixty model calls an hour until morning.
- Resume-and-repark loop. If the deputy answers RESUME on a lane that was parked for hitting
  the relay cap, the lane goes back to the queue, the relay rule immediately re-parks it, and
  the deputy is asked again next tick. Infinite.
- Unparseable-ruling loop. If a judgment answer's first word is not exactly one of the allowed
  words (models sometimes preface), the daemon treats it as no ruling and asks the identical
  question again next tick, forever.

**The fix: rulings are remembered, retries are counted, and one option disappears.**

- Every judgment and deputy outcome, including PARK and including "could not parse the
  answer", writes a stamp on the lane record: what was asked, what came back, and when. The
  same question is never re-asked while the situation it described is unchanged. Concretely:
  a deputy is asked once per distinct parked reason; a dead-lane triage is asked once per
  death. If the blocked reason changes, that is a new situation and one new call is allowed.
- Unparseable answers get two retries (so three attempts total, spread one per tick), then the
  lane parks with the verbatim answer in the reason so Ben can see what the model actually
  said. Parsing also gets more tolerant first: instead of reading only the first word of the
  first line, the daemon accepts the answer if the first line contains exactly one of the
  allowed words. A line containing two allowed words stays unparseable, because guessing
  between them is worse than asking again.
- A lane parked for hitting the relay cap is never offered RESUME. Re-slicing an oversized
  task is real judgment work, not a one-word answer, so the deputy's only options there are
  PARK, and the parked reason tells Ben it needs re-slicing.

**Why this over the alternative.** A global nightly cap on judgment calls (say, twenty) would
also bound the cost, but it fails the wrong way: a burst of legitimate questions early in the
night would eat the cap and silence real triage later. Remembering rulings attacks the actual
defect, which is asking a question whose answer cannot have changed.

**Tests.** Dry-run cases: a parked lane with the deputy on produces exactly one deputy call
across many ticks; a changed blocked reason permits exactly one more; three unparseable
answers park the lane with the answer text in the reason; a relay-capped lane's deputy prompt
contains no RESUME option; an answer of "I would RESTART" parses as RESTART; an answer
containing both RESTART and PARK does not parse.

**Live proof for this unit.** The daemon run against a live parked lane with the deputy on and
the tick log shown across thirty minutes containing exactly one deputy call. Recorded on the
pull request.

---

## Unit 5: merges must succeed, fail loudly, or get out of the way

**The bug.** The command that turns on auto-merge can fail: the branch has conflicts, the
branch is behind and the rules require it current, or auto-merge is not permitted. The daemon
ignores the command's exit code, marks the lane "merging" regardless, and the merging state
waits forever for a merge that was never armed. Nothing in the daemon ever brings a branch up
to date. Two overnight lanes touching the same file guarantee this. Worse, a wedged merging
lane still counts against the lane cap, so a handful of wedged lanes freeze the whole fleet
while the queue waits. The same open-ended wait exists one state earlier: checks that stay
pending forever (a CI outage at 3am) hold a lane slot all night with no deadline.

**The fix.**

- The auto-merge command's exit code is checked. On failure the daemon reads why, from the
  pull request's merge-state answer, and routes:
  - Branch merely behind: the daemon asks GitHub to update the branch (the built-in
    update-branch action, a plain API call, no model involved), then retries auto-merge next
    tick. Two failed update attempts park the lane.
  - Conflicts: the daemon spawns a fix agent (unit 3's machinery) with a brief that says
    exactly this: bring this branch up to date with main, resolve the conflicts, push. It
    counts as a fix round.
  - Anything else (auto-merge not allowed, rules refuse it): park immediately with the
    command's own error text as the reason. This is a configuration problem no agent can fix.
- Deadlines on the two waiting states. A lane sitting in "merging" with the pull request still
  open after forty-five minutes gets one merge-state re-check and either a routed fix as above
  or a park with the state text as the reason. A lane whose checks have been pending for
  ninety minutes gets one rescue attempt first: the daemon asks GitHub to re-run the checks, a
  single time, and waits another ninety minutes (Ben's ruling, 2026-08-23: re-run once, then
  park, so a 3am CI hiccup does not cost the whole lane). If the re-run also never finishes,
  the lane parks with the reason "checks never finished". Parked lanes already do not count
  against the lane cap, so a CI outage degrades to parked lanes and a readable morning board
  instead of a frozen fleet.

**Why deadlines over exempting stuck lanes from the cap.** Not counting merging lanes against
the cap would unfreeze the queue but leave wedged lanes wedged and let worktrees and panes pile
up unbounded. Deadlines turn every open-ended wait into either progress or a parked lane with
a reason, which is the shape the whole state machine is supposed to have.

**Tests.** Dry-run cases: failed auto-merge with a behind branch triggers update-branch;
conflicts trigger a fix-agent spawn; a refused auto-merge parks with the error text; merging
past the deadline re-checks and routes; pending checks past the deadline trigger exactly one
re-run request; a second timeout after the re-run parks.

**Live proof for this unit.** Two live lanes deliberately made to conflict on one file, and the
log showing one of them detected, fixed by a fix agent, and merged, or parked with a readable
reason, with nobody typing. Recorded on the pull request.

---

## Unit 6: trust and hygiene

Smaller fixes, batched because each is a few lines and they share test scaffolding. All are
real findings from the review, none is speculative.

- **A broken judge must not silently park the night.** Every judge call hides its errors today.
  If the judge command itself cannot run (wrong PATH under the service after a reboot, expired
  login), every new issue is tiered "security" by the in-doubt rule, so every lane parks at
  merge, and no triage ruling ever arrives, with no alarm anywhere. Fix: the daemon
  distinguishes "the command failed" from "the model answered strangely". A command failure is
  logged as a fleet-level alarm, shown at the top of the board, and the decision is retried
  next tick rather than defaulted; only a strange answer from a working command falls back to
  the cautious default. The launcher shows the alarm line whenever it is present.
- **Exact matching on issue numbers.** Intake skips an issue if any live agent's name contains
  its digits, so issue 189 is starved by an agent working 1894. The deputy is suppressed if
  the issue number appears anywhere in any reply file, including inside a clock time. Fix:
  the fleet matches only its own naming patterns, whole-token, for agents (fleet-lane-N,
  fleet-qa-N, fleet-rescue-N) and a fixed "issue N" token for needs-ben entries and replies.
- **Ben's reply must do something.** Today a reply to a parked lane's question changes
  nothing; every parked lane needs a hand-edited record. Fix: a reply whose first word is
  "resume" puts the lane back in the queue, "merge" enables auto-merge (subject to every
  existing gate, including live proof), and anything else leaves the lane parked but stamps
  the record "Ben replied, needs reading" so the board surfaces it. Ben's ruling, 2026-08-23:
  fixed first words, no model between his words and the action.
- **Dispatch stops retrying a failing worktree.** Creating the worktree can fail every minute
  all night (a leftover directory from a prior run is a realistic cause). Two failures park
  the lane with the git error as the reason, matching the box-wide two-identical-failures
  rule.
- **No second agent on a busy lane, checked properly.** Before any spawn for issue N, the
  daemon checks the live agent list for any of its own names for N and refuses if one is
  present. Today the check uses the single recorded agent name, which the review round
  overwrites.
- **Reviewers get real instructions and a real worktree.** The review brief currently tells
  the agent to run a command that is not on its path, and a lane adopted with an existing
  pull request has no worktree, so its reviewer runs in the shared checkout that several
  human sessions co-edit. Fix: briefs always spell the full command, and adoption creates a
  worktree for the branch before any agent is spawned into it.
- **Idle backoff and a finished flag.** When every record is done or parked and intake finds
  nothing new, the daemon polls GitHub every tenth tick instead of every tick, and writes a
  "run complete" line to the board. It never disables its own timer: a program that switches
  off its own supervision cannot be restarted by that supervision, and the real stop belongs
  to the human, via the viewer's end-run action (unit 8) or the STOP file.
- **One set of defaults: five lanes, thirty spawns.** The daemon falls back to three lanes and
  twelve spawns; the launcher seeds five and thirty. Ben's ruling, 2026-08-23: align up, not
  down - the daemon's fallbacks rise to five and thirty so both halves agree. Two consequences
  are handled elsewhere in this spec: recovery spawns now share and reserve part of that
  budget (unit 3), and the memory question below.
- **The memory floor with five lanes.** The 4 GB free-memory floor stays, but it is only a
  pre-spawn check: it stops the next agent from starting, it does not notice a box that
  drifted below the floor after everyone was already running. Five lanes plus reviewers and
  fix agents can mean eight or more live agents at once, which this box has not carried
  before. Two additions: the tick logs a fleet-level warning whenever free memory is below
  the floor even when it is not trying to spawn, so a swapping night is visible in the
  morning log; and the first live five-lane run watches actual memory use before anyone
  trusts the floor at that width. If that run shows the box near the floor with healthy
  lanes, the fix is a higher floor or a lower lane cap, and that is a one-line settings
  change, not code.
- **The log stops growing forever.** The event log is scanned in full several times per tick
  and never rotated, so ticks slow down week over week. Fix: the nightly spawn count moves to
  a small counter file reset at the budget window, and the log rotates when the viewer's
  end-run action fires or it passes ten megabytes, keeping the old file beside it.
- **Reboot honesty.** The runbook gains the two facts that decide whether the fleet survives
  a reboot: user services must be set to linger, and the terminal manager must be running or
  every spawn fails. The tick checks for the terminal manager once at the top and logs one
  fleet-level alarm instead of a per-lane failure storm.

**Tests.** One dry-run case per bullet; the exact-matching and reply-format cases get fixture
files with the near-miss patterns from the review (issue 18 against 1834, a reply containing
a clock time).

**Live proof for this unit.** A live parked lane resumed by writing a "resume" reply into the
replies folder and nothing else. Recorded on the pull request.

---

## Unit 7: the lane watchdog, corrected

The first draft's watchdog had a hole in the middle: its third strike handed a wedged lane "to
the daemon's existing restart-or-park judgment call", but that call only fires when the agent
is gone from the agent list and the record has been quiet thirty minutes. A wedged-but-alive
agent is still in the list, so the third strike would have done nothing. This version keeps
the decision that the watchdog is a script, never a model, and fixes the mechanism.

- **A script on the existing one-minute timer**, generalised from the coordinator watchdog
  that already exists and is switched off. It watches every pane in the fleet's agents tab.
- **Pane to lane mapping, defined.** The agent list maps each live agent to its pane, and the
  fleet's own agent names carry the issue number (unit 6 makes that matching exact). A pane in
  the tab with no fleet-named agent is ignored. A lane whose record says paused is never
  touched: a paused lane is a human holding it on purpose.
- **Signs of life.** As in the existing script, either the pane reporting "working" or any
  change in the pane's content resets the quiet clock. But "working" is a self-report, and an
  agent stuck inside one endless tool call reports itself as working the whole time - the
  commonest wedge, and the one the first draft missed entirely. So "working" is trusted only
  as far as the process check below confirms it.
- **The process check: never kill on quiet alone.** Ben's ruling, 2026-08-23. Before the third
  strike may stop an agent, the watchdog looks underneath the pane: the terminal manager knows
  the pane's top process, and the watchdog reads that process and all its children from the
  system's process table. The test is simple and cheap: it records the total CPU time used by
  that process family, and compares it to the total it recorded on its previous pass a minute
  earlier. If the family used any CPU in between, something is genuinely computing - a long
  install, a slow local gate, a big download being unpacked - and the watchdog does not kill,
  no matter how quiet the pane looks. It logs "quiet but computing" on the lane and keeps
  waiting. Only a pane that is quiet on screen AND flat underneath - no CPU movement between
  passes - is treated as truly wedged. Why CPU time between passes rather than reading each
  process's run state at one instant: a single snapshot catches a process only if it is on the
  CPU at that exact moment, so a busy process sleeping between bursts reads as idle; the
  between-passes comparison cannot miss work, because the counter only ever goes up.
- **Fail safe when the system cannot be read.** If the process table is unreadable, the pane's
  top process cannot be found, or the previous pass left no counter to compare against, the
  watchdog does not kill. It sends a nudge instead, logs that the process check was
  unavailable, and tries again next pass. A blind watchdog must never swing.
- **Escalation that actually connects.** First and second quiet periods (fifteen minutes each)
  send a nudge into the agent's pane. On the third strike, with the process check confirming
  flat, the watchdog stops the agent through the terminal manager and logs why, including the
  CPU readings that justified it. Now the agent really is gone from the list, the daemon's
  existing dead-agent path notices on its normal schedule, and the already-tested
  restart-or-park triage takes over. Why kill rather than add a force-triage flag to the
  daemon: killing reuses one tested recovery path instead of adding a second entry point into
  triage that only the watchdog uses; and an agent that ignored two nudges while doing no
  measurable work is not producing anything worth preserving.
- **Is a time ceiling still needed? Yes, one, much longer, for the opposite wedge.** The
  process check protects the healthy-but-slow agent. It cannot catch the inverse case: an
  agent spinning in a genuine infinite loop, burning CPU forever while its pane and its lane
  record never change. For that, one backstop remains: if the pane content and the lane
  record have both been unchanged for three hours, the watchdog escalates to the third strike
  even though CPU is moving. Three hours, because the longest legitimate silent stretches on
  this box - a dependency install, a full local gate - finish well inside one hour, the agent
  gets two nudges it could answer during the window, and the cost of being wrong once at 4am
  is one lost session against a whole night of a lane burning CPU for nothing. The old draft's
  forty-five minute ceiling is gone; it existed only because quiet alone was the trigger.
- **Nudge counts** live in the watchdog's own small state file keyed by agent name, and each
  nudge is also logged onto the lane so the viewer and the morning board show it. Reading the
  count from its own file rather than re-scanning the fleet log keeps the watchdog cheap.
- Ships as its own service unit next to the existing coordinator one, so the two can be
  enabled independently; the launcher installs and enables it with the tick timer.

**Tests, without wedging a real agent.** The watchdog reads the process table through a
single seam that tests can point at fixture files, the same pattern the daemon already uses
for reading free memory. Fixtures feed it: CPU counters that grew between passes (no kill,
"quiet but computing" logged); counters that stayed flat (third strike proceeds); an
unreadable process table and a missing previous counter (no kill, nudge, logged); a paused
lane (never touched); a pane with no fleet agent (ignored); pane and record unchanged for
three hours with CPU still growing (backstop escalates). Plus the existing dry-run cases: a
quiet lane gets a nudge, and the third strike issues a stop command rather than a nudge.

**Live proof for this unit.** No real agent is wedged. Two stand-in panes on the dev box,
registered under fleet lane names: one running a command that sleeps (quiet on screen, flat
CPU), one running a busy loop (quiet on screen, CPU moving). The sleeper is observed getting
two nudges and then stopped on the third strike; the busy one is observed being left alone
with "quiet but computing" in the lane log. Then the daemon is observed picking up the
stopped lane through its normal dead-agent triage. Recorded on the pull request.

---

## Unit 8: the viewer

Last because it is the least load-bearing: it changes only what is drawn and what is read from
disk. Ben's already-agreed rulings stand: the progress track stays, the fuel bar shows tokens
rather than money, and the completed section is called "Completed This Run" and sits at the
bottom.

- **Token counts, honestly labelled.** Lane agents run by the Claude program write a session
  transcript on disk with a usage record per model reply; the viewer sums those. Three
  corrections to the first draft:
  - Lanes run by other programs have no such transcript. They show "not reported", never a
    zero, because a zero reads as free.
  - A lane can have several sessions (a relay starts a new one; recovery spawns fix agents).
    The viewer keeps a small sidecar list of every session it has seen for each lane and sums
    across all of them, so a relay no longer silently drops the first session's spend.
  - Transcripts get large, and re-parsing them on every screen refresh is not free. The viewer
    remembers how far into each file it has read and reads only the new bytes.
  - Cache reads are shown separately from fresh input, since they dominate by two orders of
    magnitude and folding them in makes every lane look identical. A caption marks the totals
    as "tokens this run, Claude lanes only" so the number never claims to be a bill.
- **End the run.** The "e" key, behind a confirmation: stops the tick timer and the watchdog
  timer, asks whether to leave running agents working or close their panes, writes a run-ended
  stamp so "Completed This Run" freezes at what the run actually finished, and rotates the log
  (unit 6).
- **Layout**, per the agreed mockup: header with run clock, live indicator, lanes against the
  cap, spawn budget, held count, token totals, deputy state, and, when present, the judge
  alarm from unit 6 and the stillness warning from unit 2; three lines per in-progress lane (identity, progress track, one plain
  sentence); held issues collapsed to one dim line; colour carries state; key hints along the
  bottom. Copy stays dry and plain, one sentence per lane, no jargon.

**Tests.** The launcher's self check gains: token totals parsed from a fixture transcript;
a second session file for the same lane included in the total; a non-Claude lane showing
"not reported"; incremental reading picking up only appended bytes; end-run stopping both
timers; and the existing guard that no model name appears outside the seed table keeps
passing.

**Live proof for this unit.** The viewer shown running against a real fleet run with at least
one relayed lane, its token total visibly including both sessions, and the end-run action
stopping both timers on a live box. Recorded on the pull request.

---

## Ben's rulings, 2026-08-23

The open questions from the first draft are settled and folded into the units above; recorded
here so the reasoning is not lost:

1. **Replies to parked lanes use fixed first words** ("resume", "merge", anything else flags
   the lane for his attention). No model between his words and the action. Unit 6.
2. **Checks pending too long: re-run once, then park**, so a 3am CI outage does not cost the
   whole lane. Unit 5.
3. **Defaults are five lanes and thirty spawns** - aligned up, not down. Unit 6 carries the
   two consequences: the recovery reserve in the spawn budget (unit 3) and the memory-floor
   watch on the first five-lane run.
4. **The watchdog never kills on quiet alone.** It checks the process tree first and stays
   its hand when anything underneath is computing, fails safe to a nudge when it cannot read
   the system, and keeps only a long three-hour backstop for the CPU-burning infinite loop.
   Unit 7.

## What this spec does not do

- No merge queue, no automatic task sizing, no multi-repo support; unchanged from the daemon
  spec's non-goals.
- It does not put any model in a loop. Every model call added or kept here is one-shot,
  remembered, and capped.
- It does not touch the security-tier sign-off gate: those lanes still park for Ben (or the
  deputy, when he has switched it on).
