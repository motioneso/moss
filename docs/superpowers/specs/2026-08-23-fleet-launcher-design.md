# Fleet launcher and viewer — design

Date: 2026-08-23
Status: proposed
Related: #1904 (watch status screen), #1895 (live proof + runbook),
[fleet daemon spec](2026-08-23-fleet-daemon.md)

## Why

The fleet daemon (merged in #1903) does a dev coordinator's job on a one-minute timer: it picks up
issues, starts build agents, watches their pull requests, and decides what to do when one gets
stuck. It has no interface. Today you configure it by editing environment variables in a systemd
unit, start it with `systemctl`, and find out what it did by reading a generated markdown file.

That is fine for a program and wrong for a person. Ben's ask: run one command from the repo
directory, answer a few setup questions, and get a screen showing what the fleet is working on,
with arrow keys and Enter for detail — taking inspiration from Claude Code's agent view.

## Shape

Three programs. Status flows one way; actions take a separate path.

```
  launcher --starts--> daemon --writes--> state folder --read by--> viewer
      |                                        ^                       |
      +--writes settings-----------------------+                       |
                                                                       |
                     running agents <---- pause / rescue --------------+
                     (via the terminal workspace manager)
```

**The daemon** already exists: `scripts/fleet/tick.sh` on a systemd timer, with
`scripts/fleet/fleetctl.mjs` as its state layer. It has no screen and does not know whether anyone
is watching.

**The launcher** is the entry point. On first run it asks the setup questions, writes a settings
file beside the state folder, and starts the daemon as a background service. On later runs it finds
the settings, skips the questions, and confirms the daemon is alive.

**The viewer** is the screen. It reads the state folder on a short interval and redraws. It never
speaks to the daemon process; when it acts, it addresses the running agents directly.

### What the viewer may and may not do

The viewer reads everything it displays from the state folder. It never queries GitHub, never
inspects worktrees, never talks to the daemon process.

Two consequences, both the point: closing the viewer cannot affect the run, and the whole screen can
be tested by pointing it at a directory of fixture lanes.

It is not, however, read-only. Pause and rescue act on live agents through the terminal workspace
manager (`herdr`), which is how every other tool on this box addresses a running agent.

Its writes are enumerated, and this list is exhaustive:

| Write                               | Where                                                    |
| ----------------------------------- | -------------------------------------------------------- |
| Pause or unpause a lane             | `paused` field in the lane record, through the state CLI |
| A line saying what a human just did | That lane's log, through the state CLI                   |
| Deputy on or off                    | The settings file                                        |

It never edits a lane's status, never enables a merge, and never writes anything else. Everything
else it shows, it read.

**Racing the daemon.** The daemon ticks every minute and may act on the same lane a human just
acted on. Messages alone do not prevent this: the daemon decides from the lane record, so an action
it cannot see in the record is an action it will talk over.

Both actions therefore make themselves visible in the record before anything else happens. Pause
sets the paused field, which the daemon checks first. Rescue's spawned agent claims the lane through
the state CLI as its first act, exactly as a build agent does, so the record names it and the clock
on it restarts.

Without that claim there is a specific collision worth naming, because it is the one this design
nearly shipped with: the daemon treats a lane whose record has not changed in thirty minutes as
dead, and starts a fresh agent. A rescue agent working quietly on a lane whose record still names
the old agent looks exactly like that, and would get a second agent dropped onto the same branch
half an hour later.

Every viewer action is also written to that lane's log marked as human, so the morning board shows
who did what.

## Implementation choice

Built with Ink (React for terminals), the same foundation as Claude Code's agent view. It supplies
the tab strip, scrolling list, and detail pane; a hand-rolled terminal renderer would spend most of
its budget on that plumbing.

The cost is a dependency tree, which matters because this program is meant to be usable outside
this repository. Mitigated by giving it its own directory and its own `package.json`, so copying
that directory to another machine yields a working program with no ties to the Moss application.

Location: `scripts/fleet/launcher/`. Not imported by the app, not part of its dependency graph.

## Two units, in order

This is two pieces of work, and the second cannot be built first.

**Unit one — teach the daemon what the launcher needs.** Today the daemon takes two settings from
environment variables and holds the rest as fixed numbers in the script. It has no per-lane pause,
no concept of effort, one build model for everything, and it does not copy a lane's outstanding
question into the lane record. Every one of those is something the screens below assume.

**Unit two — the launcher and viewer**, built against a daemon that has them.

Building the screen first would mean building against state nothing writes. Each unit gets its own
issue and its own plan.

### Unit one in detail

| Change               | Today                                                         | After                                                                                                 |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Settings             | Environment variables plus fixed numbers in the script        | Reads `settings.json` from the state folder; environment still wins, for the systemd unit             |
| Build model          | One model for every lane                                      | A model and effort level per kind of work: routine, sensitive, security-touching                      |
| Pause                | Only a switch that stops the whole fleet                      | A `paused` field on the lane record; a paused lane is skipped entirely, including the dead-lane check |
| Deputy gating        | A file carrying an expiry; no file or a past expiry means off | A setting; the expiry logic is removed from the daemon                                                |
| Memory floor         | None                                                          | Refuses to start an agent below a floor of free memory, logs why, carries on                          |
| Outstanding question | Only a one-line blocked reason in the lane record             | The full question and when it was asked, copied into the lane record                                  |

That last one keeps the viewer honest: without it the screen would have to read the folder that
pings Ben as well as the state folder, and the single-source-of-truth claim would be false.

### The seam between the units

Unit two builds against what unit one writes, so the shape is fixed here rather than in two separate
plans, where it would be invented twice and differently. Everything lives under the state folder
(`$JARV1S_FLEET_STATE`, default `~/.local/state/jarv1s-fleet`).

| Thing                    | Where                | Shape                                                                                     |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| Settings                 | `settings.json`      | `judgeCmd`, `buildModels`, `laneCap`, `spawnBudget`, `deputyEnabled`, `deputyWaitSeconds` |
| When tonight began       | `run-started`        | One ISO timestamp, written by the launcher                                                |
| A lane is paused         | lane record          | `paused`, plus `pausedAt` and `pausedBy`                                                  |
| The outstanding question | lane record          | `question` with the full text, plus `questionAskedAt`                                     |
| Who is working the lane  | existing agent field | Unchanged; a rescue agent overwrites it when it claims the lane                           |

Unit one writes all of these except the start time, which the launcher owns. Unit two may assume all of them exist. Changing this table changes
both units, so it lives here rather than in either plan.

**Nothing starts the daemon, so the daemon cannot record when the night began.** It is a script that
runs once a minute and exits; every tick is a new process with no memory of the last, and there is
no moment matching "tonight started". The launcher is the only thing that knows, so the launcher
writes the start time when it starts the service. Opening and closing the viewer does not touch it.

**Settings must not be shadowed.** Environment variables win over the settings file, so the service
can still be driven directly when needed. But the service definition is where those variables live
today, and if the launcher started it unchanged the old values would silently override every answer
the user just gave. The launcher owns the service definition and keeps those variables out of it.

## Setup flow

Six questions, each with a working default, so pressing Enter six times produces a running fleet.
Answers are written to `$JARV1S_FLEET_STATE/settings.json` (default
`~/.local/state/jarv1s-fleet/settings.json`), which unit one teaches the daemon to read.

| #   | Question                                                                        | Setting             | Default     |
| --- | ------------------------------------------------------------------------------- | ------------------- | ----------- |
| 1   | Which command makes judgment calls?                                             | `judgeCmd`          | `claude -p` |
| 2   | Which models build, per kind of work?                                           | `buildModels`       | see below   |
| 3   | How many lanes at once?                                                         | `laneCap`           | 5           |
| 4   | How many agent starts tonight?                                                  | `spawnBudget`       | 30          |
| 5   | Is the deputy on?                                                               | `deputyEnabled`     | off         |
| 6   | How long does it wait for you before deciding? (asked only if the deputy is on) | `deputyWaitSeconds` | 1200        |

Question 1 asks for a command, not a model name, so pointing the fleet at another provider is a
one-line change. This is the provider-agnostic rule from `CLAUDE.md`, which Ben extended to ops
tooling on 2026-08-23.

Question 2 collects a list rather than a single answer, because effort and cost should not be
uniform across work of different risk. The daemon already classifies each lane as routine,
sensitive, or security-touching; the setup maps a model and an effort level onto each:

```json
"buildModels": {
  "routine":   { "model": "sonnet",      "effort": "medium" },
  "sensitive": { "model": "sonnet",      "effort": "high" },
  "security":  { "model": "gpt-5.6-sol", "effort": "high" }
}
```

All three may name the same model. Effort reaches the agent as a spawn argument where the provider
takes one — for the local Claude command, its reasoning-effort flag — and is ignored, with a line in
the log, where it is not.

**Where model names are allowed to appear.** The rule is that no model name is compiled into the
fleet's logic. Names in a settings file the user edits, and in the seed defaults the setup screen
offers on first run, are data. The test is exact: no model name may appear in the daemon or in the
viewer's own code. The seed defaults live in one exported table in the launcher, and a test asserts
that table is the only place they occur.

**Lane and budget numbers.** The approved daemon design said 3 lanes and 12 agent starts. This
raises them to 5 and 30 — Ben's decision on 2026-08-23, made after measuring the box: an agent
session costs around 270 MB, so the machine was never the constraint. The limit is how many pull
requests are worth reviewing in one morning.

### The deputy toggle

The daemon today gates the deputy behind a file carrying an explicit expiry: no file, no expiry, or
a past expiry all mean off. That design fails closed by construction — forget about it and it turns
itself off overnight.

Ben's ruling on 2026-08-23 is a plain on/off switch with no time element, flipped from the setup
screen or from the viewer. Recorded honestly: this trades a switch that expires on its own for one
that stays as last set, so leaving it on means it stays on until turned off.

Two things keep that safe enough. The default is off, so pressing Enter through setup never enables
a stand-in. And the viewer shows the deputy's state in the header at all times, on every tab, so an
enabled deputy is never invisible.

The hard floor is unchanged and non-negotiable: the deputy may not merge work that has not been
proven to run on a live instance, and may not touch production, delete data, rewrite history,
disable checks, or exceed the spawn budget. Already enforced in the daemon; not configurable.

### Memory floor

The daemon refuses to start a new agent when free system memory is below **4 GB**, logs the refusal
in plain English, and continues its tick. Sized against measurement: an agent session costs roughly
270 MB resident, so the floor leaves room for the lane cap several times over while still stopping
well short of swap.

This is not protection against the fleet. On 2026-08-23 an unrelated process on the box was found
holding 18 GB, a third of system memory, and the fleet should degrade rather than push the machine
into swap at 4am.

## Screens

### The list

A tab strip across the top; left and right arrows switch tabs, up and down move the selection,
Enter opens a lane, `q` quits.

| Tab                       | Contents                                          |
| ------------------------- | ------------------------------------------------- |
| **In Progress** (default) | Lanes being worked now                            |
| **Ready**                 | Queued lanes, in the order they will be picked up |
| **Done Tonight**          | Lanes finished since this run started             |

One line per lane: issue number, title, and a short plain-English status — "building", "waiting on
checks", "review found problems", "waiting on you". Lanes needing a human are visually distinct.

**Done Tonight is run-scoped, not status-scoped.** It is not the set of lanes whose stored status is
`done`; it is the set that reached `done` since tonight's run began. The launcher writes the start time
into the state folder when it starts the service, and the viewer filters on that.

The distinction matters at 7am: if the filter were "since this window opened", reopening the viewer
in the morning would show an empty list at exactly the moment the night's work is what you want to
see. Opening and closing the viewer changes nothing; only restarting the daemon starts a new night.

**Ready shows an approximate order.** The daemon walks lane files in whatever order the filesystem
returns them and promises no ordering, so the tab is labelled as the likely next few rather than a
queue. Committing the daemon to a real order is possible but is not part of this work.

### The detail view

Enter on a lane shows the story of that one issue:

- What it is doing now, and for how long
- Its pull request, if any, and whether checks passed, failed, or are running — and which check
  failed
- How many times it has been round the loop: relays to a fresh agent, rounds sent back by review
- The last several log entries for that lane, newest first
- If it is waiting on a decision: the question, and whether the deputy answered or the clock is
  still running

Escape returns to the list.

### Actions

Both keys exist only in the detail view, where the target is visible and unambiguous. Both act
through the terminal workspace manager rather than by editing state, and both write what they did to
the lane's log, marked as a human action.

**`p` — pause.** Confirms, then marks the lane paused on its record and sends its running agent a
message telling it to stop at its next safe point and wait. Pressing again unmarks the lane and
tells the agent to carry on.

Pause is cooperative, not a kill. An agent mid-edit finishes what it is doing and then stops, which
is what you want at 1am: a hard stop mid-commit leaves a worse mess than the problem you were
interrupting.

Three consequences the daemon has to handle, none of which it does today:

- **A paused lane is skipped entirely, including the dead-lane check.** The daemon judges a lane
  dead when its record has not changed in thirty minutes, and a paused agent produces exactly that
  signature. Without this, any pause lasting longer than half an hour ends with the lane parked.
- **The agents must be told what a pause is.** Their briefs currently say the opposite — finish or
  stop your session, never idle waiting — so a pause message arriving in that session would be
  obeyed unpredictably. Unit one adds a line to the brief: on a pause, stop at a safe point and
  wait to be told to continue or to stop for good.
- **Resume must survive a missing agent.** If the agent exited while paused, there is nothing to
  tell. Unpausing simply clears the mark, and the lane rejoins the normal flow, where the dead-lane
  path picks it up on the next tick.

If the lane has no running agent to begin with, pausing just sets the mark, which is enough to stop
the daemon spawning for it.

**`r` — rescue.** Two steps, with a decision in between.

First it gathers the lane's story — current status, failing check, recent log, the outstanding
question if there is one — and sends it to the configured judgment model with cold context. The
screen stays responsive while the call is in flight. What comes back is displayed: a plain reading
of what went wrong, and a suggested next move.

Then you choose. Accept starts a fresh rescue agent on that lane through the workspace manager,
carrying the model's reading as its brief. Pause instead does the pause above. Dismiss writes
nothing.

Nothing is spawned before you accept. That is the whole reason rescue is two steps: the same
judgment call the daemon already makes on its own, but with a preview, because a keypress at 1am
should not start real work sight unseen.

**What a rescue agent may do.** It is a build agent with a better brief, not a diagnostician (Ben,
2026-08-23). It may change code, push, and carry the issue the rest of the way, under the same rules
as any build agent.

Three things follow, and all three are what make it safe to start one from a keypress:

- **It claims the lane first.** Before touching anything it writes itself into the lane record
  through the state CLI, exactly as a spawned build agent does. Until it does, the daemon still sees
  the old agent on a stale record and will eventually send a second agent to the same branch.
- **It counts against the night's budget.** A rescue is an agent start like any other. If the budget
  is exhausted the viewer still shows the preview, but cannot be accepted, and says why.
- **Its brief carries the hard floor.** It may not merge unproven work, touch production, delete
  data, rewrite history, or disable checks — the same list the deputy is bound by.

The floor is enforced in the brief and in the daemon, which already refuses these at the point of
action. It is deliberately not enforced by the viewer inspecting the model's answer: that answer is
free text, and a screen claiming to detect a forbidden intention in prose would promise something it
cannot deliver.

## Out of scope

Named so that their absence is a decision rather than an oversight:

- No chat with the daemon or with agents. Pause and rescue send fixed messages, not free text
- No editing issues, no starting new work from the screen
- No history beyond the current run
- No mouse support
- No log streaming; the detail view shows a bounded tail

## Errors

| Condition                        | Behaviour                                                           |
| -------------------------------- | ------------------------------------------------------------------- |
| State folder missing or empty    | Viewer says the daemon has not ticked yet, keeps polling            |
| Daemon not running               | Launcher offers to start it; viewer shows a banner and stays usable |
| A lane's state file is malformed | That row shows an error, the rest of the screen renders             |
| Rescue call fails or times out   | Message in the detail view; nothing written; lane untouched         |
| Agent-start budget exhausted     | Rescue shows its preview but cannot be accepted, and says why       |
| Terminal too small               | A clear message rather than a broken layout                         |

## Testing

The viewer displays only what it reads from a folder, so the screens can be tested by rendering
against fixture state. No fleet, no network, no cost.

Viewer:

- In Progress is the tab on open
- A lane awaiting a human is marked, and the outstanding question appears in its detail view
- Done Tonight excludes a lane completed before the daemon's start time, and is unaffected by
  opening and closing the viewer
- Arrows move selection and tabs; Enter opens detail; Escape returns
- A malformed lane file shows an error on its row and does not take down the screen
- The deputy's state is visible in the header on every tab

Actions, with the workspace manager stubbed:

- Both keys prompt for confirmation and do nothing when declined
- Pause messages the running agent, marks the lane, and logs the action as human
- Pause on a lane with no running agent still marks it, and does not error
- Rescue shows the model's answer before anything is spawned, and dismissing spawns nothing
- An accepted rescue claims the lane in the record before the agent does anything else
- An accepted rescue is refused when the agent-start budget is exhausted, and says why
- A paused lane survives past the dead-lane threshold without being parked
- Unpausing a lane whose agent has exited clears the mark and does not error
- A failed or slow model call leaves the lane untouched and says so

Setup:

- Enter through every question yields valid, complete settings
- The deputy is off after an all-defaults setup
- A second launch skips the questions
- No model name appears in the daemon or in the viewer's code, only in the launcher's seed table

Unit one, against the daemon:

- The daemon reads the settings file, and an environment variable still overrides it
- A paused lane is skipped and spawns nothing
- Below the memory floor, no agent starts and the refusal is logged
- Each kind of work spawns on its configured model and effort
- A lane's outstanding question reaches the lane record

The rescue model call is stubbed throughout.

## Manual

One page, `scripts/fleet/launcher/MANUAL.md`, travelling with the program:

1. What this is
2. Starting it the first time
3. What each setup question means, and what pressing Enter gives you
4. Reading the three tabs
5. Pause and rescue: what they actually do
6. Stopping: closing the window versus stopping the fleet
7. When something looks wrong at 1am

Plain English, no code names or file paths beyond the commands to type. This absorbs the runbook
portion of #1895; that issue keeps its live-proof requirement.

## Open questions

- **Does the daemon leave this repository?** Ben on 2026-08-23: it "shouldn't go IN the repo / app
  really. It can be used outside of Moss." This design keeps it in `scripts/fleet/` with the
  launcher self-contained, which makes extraction cheap but does not perform it. The cheapest moment
  to move is before #1895 writes a runbook around these paths.

## Decisions recorded here

Made by Ben on 2026-08-23, in this design conversation, and captured so they are not relitigated:

| Decision                                                        | Note                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built with Ink                                                  | Chosen over a hand-rolled renderer for the tab and list plumbing                                                                                                                                                                                                               |
| Launcher starts the daemon, then the daemon survives on its own | Closing the viewer does not stop the fleet                                                                                                                                                                                                                                     |
| Three tabs, In Progress by default                              | Ready and Done Tonight alongside                                                                                                                                                                                                                                               |
| Rescue is in the first version                                  | Reviewed as the least-defined piece; kept and specified rather than cut                                                                                                                                                                                                        |
| Pause messages the running agent                                | Cooperative stop through the workspace manager, not a marker the agent never sees                                                                                                                                                                                              |
| Deputy is a plain on/off switch                                 | No expiry, contrary to the daemon's current fail-closed file; default off, always visible in the header                                                                                                                                                                        |
| 5 lanes, 30 agent starts                                        | Raised from 3 and 12 after measuring the box                                                                                                                                                                                                                                   |
| Build everything, then prove it once at the end                 | Unit one, then unit two, then the live proof. Ben on 2026-08-23: "the delay is fine, I want it done right." The daemon has never been installed or run, so waiting costs nothing currently in use. The cost accepted is one large proof session rather than several small ones |
| A rescue agent fixes the lane and carries it on                 | Ben on 2026-08-23. It is a build agent with a better brief, not a diagnostician: it may change code, push, and take the issue the rest of the way                                                                                                                              |
| The one-page runbook is dropped                                 | The launcher manual replaces it; #1895 keeps only its live-proof requirement                                                                                                                                                                                                   |
