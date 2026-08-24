# Fleet viewer upgrades and a lane watchdog — design

Date: 2026-08-23
Status: approved by Ben in chat, 2026-08-23

## Why

The fleet daemon ran live for the first time on 2026-08-23 (issue #1422). Two gaps showed up
immediately.

A lane agent that dies is eventually noticed: the daemon sees it vanish from the agent list, waits
for thirty minutes of a stale record, then asks for a judgment call to restart or park it. A lane
agent that is _still alive but wedged_ is never noticed at all. It stays in the agent list, so the
dead-lane check never fires and the lane looks healthy for the rest of the night. This is the exact
failure mode that has cost whole runs before.

Separately, the viewer cannot answer three questions an operator asks constantly: how much is this
costing, how do I stop everything, and which lane needs me right now.

## Two units

These ship as two pull requests because they touch different things and carry different risk.

**Unit A — the lane watchdog.** Changes daemon behaviour. Needs its own tests and live proof.
**Unit B — the viewer.** Changes only what is drawn on screen and what is read from disk.

---

## Unit A: the lane watchdog

### Decision: a script, not a model

An earlier proposal was a second model watching the lane agents from its own pane. Ben rejected it:
a model running all night is precisely the token cost this daemon exists to avoid.

The box already has the right machine. `scripts/ops/coordinator-watchdog.sh` runs as a systemd
oneshot on a one-minute timer, watches one pane, treats either an `agent_status` of `working` or any
change to the pane's `revision` as a sign of life, and after a threshold of quiet sends a nudge via
`herdr agent prompt`. It then resets its own clock so a still-stuck session is re-nudged once per
threshold rather than once per minute. It costs nothing to run.

This unit generalises that script to the fleet.

### What changes

- **Watch a set of panes, not one.** Today the script requires exactly one pane labelled
  `Coordinator`. It should instead watch every pane in the fleet's agents tab (`Fleet Agents`,
  overridable with `FLEET_AGENT_TAB`), matching how the daemon places lane agents.
- **Escalate instead of nudging forever.** Nudge count per lane is recorded. First and second quiet
  periods get a nudge. The third hands the lane to the daemon's existing restart-or-park judgment
  call rather than nudging again — a lane that has ignored two nudges is not thinking, it is stuck.
- **Record every nudge on the lane.** Each nudge writes a line to the lane's record with
  `fleetctl log`, so the viewer and the audit trail can both show it and the count survives a
  watchdog restart.
- **Leave a paused lane alone.** A paused lane is a human holding the lane deliberately. It must
  never be nudged, exactly as the daemon skips it before every other rule.

### Thresholds

Quiet threshold stays at fifteen minutes, matching the existing script and the existing
`COORDINATOR_WATCHDOG_IDLE_SECONDS` override. The daemon's dead-lane threshold stays at thirty
minutes and is unchanged.

A lane doing one long thinking pass can look quiet. This is tolerated deliberately: the cost of a
wrong nudge is one interrupted message, the cost of a wrong restart is a lost session. That is why
the first two strikes nudge and only the third escalates. Issue #1885 closed the old watchdog
precisely because it nudged healthy sessions; the pane's `working` status, which that fix
introduced, is what makes this safe to re-enable.

### The existing unit

`coordinator-watchdog.service` and its timer are currently installed and switched off. The fleet
watchdog ships as its own unit so the two can be enabled independently, and the launcher installs
and enables it alongside the tick timer, so an operator never has to know it exists.

---

## Unit B: the viewer

### Token counts

Every Claude lane agent writes a session transcript under `~/.claude/projects/<worktree>/<session
id>.jsonl`. The pane's `agent_session.value` gives the session id, so a lane's transcript is
directly addressable. Each model reply in that file carries a usage record with input, output, cache
read and cache write counts.

Totals are summed from the transcript, which means they cost nothing to collect and still work after
the agent has exited. Cache reads are counted and displayed separately from fresh input: cache reads
dominate by two orders of magnitude and folding them in makes every lane look identical.

Shown per lane as a bar plus a rounded figure, and as a run total in the header.

### End the run

`e` on the list, behind a confirmation. It stops the tick timer, stops the watchdog timer, and asks
what to do about agents still running: leave them working, or close their panes. It writes a
run-ended stamp so the completed list freezes at what the run actually finished rather than silently
emptying.

### Layout

Mission control, dense but quiet. Ben's ruling on the mockup, 2026-08-23:

- **Header:** run clock, live indicator, lanes in use against the cap, spawn budget, held count,
  token totals, deputy state, and a sparkline of fleet activity across the run.
- **In Progress:** one lane per three lines — identity, then a progress track, then a single plain
  sentence of what it is doing. The progress track (brief, plan, build, tests, PR) is kept; it earns
  its space by showing how far a lane got without the operator reading anything.
- **Ready:** held issues collapse to one dim line rather than hundreds of rows.
- **Completed This Run:** stays at the bottom. Renamed from "Done Tonight" — a run is not always a
  night.
- **Colour carries state:** green moving, amber quiet a while, red blocked or stalled, dim grey held.
- **Key hints** along the bottom.

Copy stays dry and plain. One sentence per lane, no jargon, no invented terms.

## Testing

Unit A: the existing fleet tick test file gains cases for a quiet lane getting nudged, a paused lane
never being nudged, and a third strike escalating to the judgment call rather than a nudge. The
watchdog script gets a dry-run mode matching the existing one, so a test can assert the command it
would send without sending it.

Unit B: the launcher's self check gains cases for token totals parsed from a sample transcript, and
for the end-run action stopping both timers. The existing check that no model name appears outside
the one seed table must keep passing.

## Live proof

Unit A cannot be called done on a green test run. It needs a real lane deliberately wedged on a live
dev instance, the nudge observed arriving in the agent's pane, and the escalation observed on the
third strike. Recorded on the pull request per the live-path gate.
