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

Three programs with one direction of data flow.

```
launcher  ──starts──>  daemon  ──writes──>  state folder  ──read by──>  viewer
   │                                              ▲                       │
   └──writes settings──────────────────────────────┘        writes pause/rescue markers
```

**The daemon** already exists: `scripts/fleet/tick.sh` on a systemd timer, with
`scripts/fleet/fleetctl.mjs` as its state layer. It has no screen and does not know whether anyone
is watching.

**The launcher** is the entry point. On first run it asks the setup questions, writes a settings
file beside the state folder, and starts the daemon as a background service. On later runs it finds
the settings, skips the questions, and confirms the daemon is alive.

**The viewer** is the screen. It reads the state folder on a short interval and redraws. It never
speaks to the daemon directly.

### Why the viewer only reads

Three consequences, all of them the point:

- Closing the viewer cannot affect the run. The daemon keeps ticking; `q` exits the window, not the
  fleet.
- The viewer is testable without a fleet. Point it at a directory of fixture lanes and assert on
  what it draws.
- There is no protocol to design, version, or debug between the two.

The two actions are the deliberate exception, and they stay one-directional: pause writes a marker
file that the daemon reads on its next tick. Rescue calls the judgment model in the viewer's own
process and only writes a marker once the user accepts.

## Implementation choice

Built with Ink (React for terminals), the same foundation as Claude Code's agent view. It supplies
the tab strip, scrolling list, and detail pane; a hand-rolled terminal renderer would spend most of
its budget on that plumbing.

The cost is a dependency tree, which matters because this program is meant to be usable outside
this repository. Mitigated by giving it its own directory and its own `package.json`, so copying
that directory to another machine yields a working program with no ties to the Moss application.

Location: `scripts/fleet/launcher/`. Not imported by the app, not part of its dependency graph.

## Setup flow

Six questions, each with a working default, so pressing Enter six times produces a running fleet.
Answers are written to `$JARV1S_FLEET_STATE/settings.json` (default
`~/.local/state/jarv1s-fleet/settings.json`).

| #   | Question                              | Setting             | Default     |
| --- | ------------------------------------- | ------------------- | ----------- |
| 1   | Which command makes judgment calls?   | `judgeCmd`          | `claude -p` |
| 2   | Which models build, per kind of work? | `buildModels`       | see below   |
| 3   | How many lanes at once?               | `laneCap`           | 5           |
| 4   | How many agent starts tonight?        | `spawnBudget`       | 30          |
| 5   | Is the deputy on?                     | `deputyEnabled`     | on          |
| 6   | If on, how long does it wait for you? | `deputyWaitSeconds` | 1200        |

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

All three may name the same model. Effort is passed through only where the provider supports it.

After the questions the launcher prints the resolved settings and asks once whether to start.
Re-running setup later is a flag on the launcher and a key on the viewer's settings screen.

### Not a setting

The deputy may never merge work that has not been proven to run on a live instance. This is the
live-path gate from `DEVELOPMENT_STANDARDS.md`, enforced in `tick.sh` as a hard floor. It does not
become configurable.

### Memory floor

The daemon gains one rail not previously specified: it refuses to start a new agent when free
system memory falls below a floor, logs the refusal in plain English, and carries on. Sized against
measurement rather than guesswork — an agent session costs roughly 270 MB resident.

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
`done`; it is the set that reached `done` after this run began. The launcher writes a run-start
timestamp into the state folder and the viewer filters on it. Without this the tab becomes an
ever-growing all-time list and stops answering the question it exists to answer.

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

Both keys exist only in the detail view, where the target is visible and unambiguous.

**`p` — pause.** Confirms, then writes a pause marker on the lane. The daemon leaves it alone from
its next tick. Pressing again resumes.

**`r` — rescue.** Gathers the lane's status, failing check, and recent log, sends them to the
configured judgment model with cold context, and displays what comes back: a plain reading of what
went wrong plus a suggested next move. Nothing is written until the user chooses — accept, pause
instead, or dismiss. The screen stays responsive while the call is in flight.

Rescue is the same judgment call the daemon already makes autonomously. Exposing it as a key does
not add a new capability; it adds a way to invoke that capability on demand, with a preview.

## Out of scope

Named so that their absence is a decision rather than an oversight:

- No chat with the daemon or with agents
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
| Terminal too small               | A clear message rather than a broken layout                         |

## Testing

The viewer's read-only design is what makes it testable: render it against a fixture state
directory and assert on output. No fleet, no network, no cost.

Viewer:

- In Progress is the tab on open
- A lane awaiting a human is marked
- Done Tonight excludes a lane completed before the run-start timestamp
- Arrows move selection and tabs; Enter opens detail; Escape returns
- Both action keys prompt for confirmation before writing anything
- A malformed lane file does not take down the screen

Setup:

- Enter through every question yields valid, complete settings
- A second launch skips the questions
- No provider or model name is hard-coded anywhere in the launcher

The rescue model call is stubbed in tests.

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
- **Ordering against #1895.** Task C is end-to-end live proof — the gate on whether the daemon can
  be trusted to run unattended. The launcher makes it pleasant to watch; the live proof makes it
  safe to leave. Not yet ruled on.
