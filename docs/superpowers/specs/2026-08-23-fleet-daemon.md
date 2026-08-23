# Fleet daemon — coordination as a program, judgment as a model

**Date:** 2026-08-23. **Goal:** replace the resident coordinator session's mechanical half with a
plain program, in time for an overnight run tonight.

## Problem

The coordinator is a Claude session that pays tokens to wait. The 2026-08-23 audit measured the
cost: 18-35 coordinator restarts per run, 242 watchdog nudges in two days each answered with
repeated pane-list polling, and most context bytes spent re-orienting rather than deciding.
Research (see `docs/audits/2026-08-23-coordination-research.md`) is unanimous: every system that
scaled moved waiting, dispatching, health checks, and routing into ordinary code, and spends
model calls only on judgment.

## Shape

Three pieces, replacing the resident coordinator for routine/sensitive work:

1. **Task records** — one JSON file per lane, machine-edited through a tiny CLI. No more
   hand-edited markdown manifest. A human-readable board is generated from the records.
2. **The daemon tick** — a script run by a systemd timer every minute (same proven pattern as
   the existing watchdog). Stateless between ticks; reads the records, advances every lane one
   step if it can, exits.
3. **Judgment calls** — where a decision is needed (QA arbitration, re-slicing an oversized
   task), the tick shells out to a one-shot headless Claude (`claude -p`) with only the relevant
   facts, records the ruling, and moves on. Decisions only Ben can make go to `needs-ben` and
   the lane parks.

The daemon has no context window, so it cannot degrade, relay, or need nudging. The watchdog
and the coordinator-session skills stay in place untouched for daytime interactive runs; the
daemon is a parallel mode, not a rewrite.

## State

- Directory: `~/.local/state/jarv1s-fleet/` (outside the repo — machine state must not churn
  the shared checkout).
  - `tasks/<issue>.json` — one record per lane (schema below).
  - `board.md` — generated summary, overwritten every tick. This is Ben's morning view.
  - `log.jsonl` — append-only event log: every state transition, spawn, merge, escalation, and
    judgment ruling, with timestamps. The audit trail and the debugging tool.
  - `STOP` — kill switch. If this file exists, the tick exits immediately without acting.
- Task record schema (all fields flat, no nesting):
  `issue` (number, the ID), `spec` (path), `tier` (routine|sensitive|security),
  `status` (see machine below), `branch`, `worktree`, `pr` (number or null),
  `agent` (herdr agent name or null), `relays` (int), `qa_rounds` (int),
  `blocked_reason` (string or null), `updated_at`.
- CLI: `scripts/fleet/fleetctl.mjs` with subcommands `add`, `set <issue> <field>=<value>...`,
  `get <issue>`, `list`, `board` (regenerate board.md), `log <issue> <message>`. Writes are
  atomic (write temp, rename). Agents in lanes update their OWN record via this CLI instead of
  messaging a coordinator ("I opened PR 1234" becomes `fleetctl set 1234 status=pr-open pr=1234`).

## State machine (what the tick does per record)

**Intake (start of every tick, idempotent):** the daemon loads its own queue — Ben does not
hand-feed it. Query GitHub project 2 ("Issue and Roadmap Work") for `task` issues in Ready or
In Progress that have no record yet. For each, a one-shot judgment call reads the issue
title/body and assigns the risk tier (the coordinate skill's mechanical triggers: auth, RLS,
secrets, migrations = security; shared tables, exports, payloads = sensitive; else routine —
in doubt, higher). Then `fleetctl add` — at the RIGHT starting state, not always `queued`. Started-but-unfinished
work is adopted, not skipped (Ben's ruling, 2026-08-23):
- Open PR exists → record enters at `pr-open` (daemon drives it through CI, QA, merge).
- Branch exists but no PR → record enters `queued` with the branch noted; dispatch spawns the
  agent with a resume brief ("this branch has prior work — read its log, finish, open the PR")
  and reuses the existing worktree if present.
- Nothing started → `queued`, fresh.
The only hands-off case: a lane whose agent is LIVE right now (its agent name appears in
`herdr agent list`) — that one is actively being worked, adopting it would double-drive it; log
and re-check next tick. When the daytime run winds down and its agents exit, the daemon picks
those lanes up automatically on the next tick.

| status | tick action |
| ------ | ----------- |
| `queued` | if live lanes < cap (3): create worktree off origin/main, generate brief from template, spawn build agent via herdr, set `building` |
| `building` | nothing (agent works; it sets `pr-open` or `blocked` itself). If the agent is gone from `herdr agent list` and the record hasn't moved in 30 min: judgment call — restart with same brief (fresh session, restart-over-rescue) once; second death = `blocked` |
| `pr-open` | check CI via `gh pr checks`. Green: spawn QA agent (round = qa_rounds+1, incremental), set `qa`. Red: post the failing check names as a PR comment for the lane agent, set `ci-red` |
| `ci-red` | if the same check fails twice: `blocked` (stop-the-line, file issue). Else wait for lane agent to push a fix (record goes back to `pr-open` on new head) |
| `qa` | nothing (QA agent sets `qa-green` or `qa-red` + posts verdict on the PR) |
| `qa-red` | if qa_rounds >= 2: judgment call — one-shot arbiter (different model) reads QA verdict + build agent's cited fixes, rules merge/park; park = `blocked`. Else notify lane agent to fix (cited SHAs required), back to `building` |
| `qa-green` | tier routine/sensitive: enable `gh pr merge --squash --auto`, set `merging`. Tier security: `needs-ben` + `blocked` (his sign-off gate is untouched) |
| `merging` | when PR reports merged: run `scripts/worktree-reapable.sh`, reap worktree + pane on REAPABLE, set `done`, write teardown line to log |
| `blocked` | ensure a `needs-ben` entry exists with `blocked_reason`; otherwise skip (parked lanes cost nothing) |
| `done` | skip |

Cross-cutting rails, checked first every tick:
- `STOP` file → exit. Spawn budget: max 12 agent spawns per calendar night → then queue only.
- Live-path gate unchanged: a user-facing PR without a live-proof comment cannot leave `qa-green`
  (the tick checks for the proof comment before enabling auto-merge; missing → `blocked`,
  reason "code-complete, unverified").
- Relay rule: an agent that relays runs `fleetctl set <issue> relays=+1`. relays >= 2 → the tick
  sets `blocked`, reason "needs re-slice" (Ben's one-session rule, enforced in code).
- Never touches :1533 (prod), never merges security tier without sign-off (Ben, or the deputy), never force-pushes, never deletes a
  worktree that `worktree-reapable.sh` says KEEP.

## Judgment calls (the only model spend the daemon itself makes)

`claude -p` one-shot, plain prompt, facts only, answer forced to a single line the tick parses.
Two calls exist in v1:
1. **Dead-lane triage:** "agent died mid-build, here is its last log tail + record — restart
   fresh or park for Ben?" (max once per lane).
2. **QA arbitration at round-2 red:** different model from the QA agent, binding one-shot ruling.
Anything else is `needs-ben`. Rulings are logged verbatim to `log.jsonl`.

## Deputy mode — Fable stands in when Ben can't answer

When Ben is asleep or away, parked lanes shouldn't stall the whole night. Deputy mode delegates
his decisions to a one-shot Fable call (the strongest available model, cold context, facts only).

- **Opt-in, explicit, expiring.** A file `~/.local/state/jarv1s-fleet/DEPUTY` containing a scope
  and an expiry time (e.g. `until=2026-08-24T08:00`). No file, or past expiry =
  deputy off, lanes park as normal. Ben creates it when he goes offline; deleting it revokes.
- **Trigger:** a lane parks with a needs-ben entry and no reply arrives within 20 minutes.
- **Scope (Ben's ruling, 2026-08-23):** the deputy may decide ANYTHING Ben could have been asked
  — including security-tier merge sign-off — EXCEPT actions on the hard floor below. One scope,
  no tiers of deputization.
- **Hard floor — never, deputy or not:** anything destructive or hard to reverse. Concretely:
  touching prod (:1533) in any way; deleting or dropping user data, databases, or vault content;
  force-pushing or rewriting history; deleting branches/worktrees with unmerged work (a KEEP
  verdict binds); disabling CI, guardrails, or required checks; exceeding the spawn budget;
  bypassing the live-path check; exposing secrets. If a ruling would need any of these, the
  deputy's only allowed answer is PARK for Ben. The test is "would Ben wince if this couldn't be
  undone at breakfast" — when in doubt, it is on the floor.
- **Accountability:** every deputy ruling is logged verbatim (question, facts given, ruling,
  what the daemon did), flagged `DEPUTY` in `log.jsonl` and `board.md`, and leads the morning
  report so Ben reviews each one first thing. The original needs-ben entry stays, annotated with
  the deputy's ruling, so he can overrule after the fact — deputized decisions should prefer the
  reversible option when the choice is close.
- Security-tier merges the deputy signs off are flagged separately at the TOP of the morning
  report — approved and merged, but the first thing Ben sees.

## What agents see (changes to lane skills — minimal)

Build/QA agents keep `coordinated-build` / `coordinated-qa` almost as-is. The brief template
gains one block: "You are running under the fleet daemon, not a live coordinator. Report state
changes with `fleetctl set ...` (exact commands listed). Blocked = `fleetctl set <issue>
status=blocked blocked_reason=\"...\"` then STOP your session — never idle waiting. There is no
coordinator to message; escalations that need a human go through the record."

## Build plan — three tasks, each sized to one session

- **Task A (#issue-A): state store + CLI + board + brief generator.** `fleetctl.mjs`, record
  schema, atomic writes, `board.md` renderer, brief template with the fleet block. Unit tests
  for the CLI. No daemon yet.
- **Task B (#issue-B): the tick + timer + rails.** `scripts/fleet/tick.sh` implementing the
  state machine, systemd unit + timer files (pattern-copied from the watchdog), STOP file, spawn
  budget, judgment-call shell-outs, event log. Testable with `FLEET_DRY_RUN=1`.
- **Task C (#issue-C): live proof + runbook.** One small real issue driven end-to-end by the
  daemon on the dev box (dry-run first, then live), fixes to whatever breaks, and a one-page
  runbook: how to queue tonight's work, start/stop, read board.md in the morning.

A and B can build in parallel (B codes against the schema in this spec); C follows both.

## Exit criteria

- `fleetctl` round-trips a record and regenerates the board; tests green.
- A dry-run tick logs correct intended actions for every status against fixture records.
- One real issue taken queued → merged (or cleanly parked) by the daemon with zero resident
  coordinator session involved; every transition visible in `log.jsonl` and `board.md`.
- Kill switch, spawn budget, relay cap, security-tier park, live-path check, and deputy mode
  (trigger, scope limit, expiry, logging) each proven by a forced test case (may be dry-run).
- Runbook committed; tonight's queue loaded.

## Non-goals (v1)

- Replacing the interactive coordinator for daytime runs, the watchdog, or any lane skill logic.
- Merge queue (batch-testing green PRs together) — noted for v2.
- Automatic task sizing, cost accounting dashboards, multi-repo support.
- Security-tier automation of any kind: those lanes always park for Ben.
