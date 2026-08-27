---
name: relay
description: Use when YOU (a build agent or the coordinator) are approaching your context limit and must continue the SAME work in a fresh session — flush state to a durable doc, spawn a successor with herdr-handoff, and let the coordinator reap you. This is a self-handoff to continue your own work; to start a DIFFERENT new agent use herdr-handoff, to message a running agent use herdr-pane-message.
---

# relay — hand your own work to a fresh session before you degrade

## Overview

A long-running session loses efficiency as context fills (compaction, slower, sloppier). Rather
than degrade in place, **relay**: capture everything the next session needs into a durable doc,
spawn a fresh successor pointed at it, confirm the successor is driving, then have the spent
session reaped. Used by **both** build agents (continuing one spec) and the **coordinator**
(continuing the whole run).

This is a self-handoff of YOUR work. Distinct from:
- `herdr-handoff` — start a *different* new agent on a new task (relay calls this primitive).
- `herdr-pane-message` — message an *already-running* agent.

## When to relay — countable events, not a felt %

Self-perceived context % is known-unreliable, so trigger on things you can **count or see**:

- **Anyone — context-meter warning (primary):** the user-level PostToolUse meter warns at **70%**
  (self-calibrating, fires in every session on this box). First warning = relay now.
- **Coordinator — merge counter:** additionally relay after **every security-tier merge** and
  after **every 2 routine/sensitive merges**, whichever fires first.
- **Either — compaction tripwire:** the instant you see a **compaction summary** in your own
  context (the harness compacted your prior messages), you are already past safe. Relay
  **immediately**. **Coordinator: merge nothing first** — flush the manifest and hand off before
  any further merge, or you risk merging on degraded judgement.

**Relay early, not at 99%** — you need enough headroom to write a clean continuation doc. The moment
a trigger fires, message the coordinator that you are relaying, *then* do it.

**Relay depth is budgeted at ONE for build/QA lanes** (Ben, 2026-08-23: one session per unit of
work — "we handoff work waaaay too much"). Relaying is failure recovery, not a workflow. Count
your depth (successor names carry it: `<slug>-relay<n>`); if you are already `-relay1`+ and your
own trigger fires without an open PR, do NOT relay again — push what you have, write the state
doc, and report to the coordinator that the slice needs re-scoping into smaller lanes. The
coordinator is the only exception (its run outlives any window), and even it should be spawning
smaller scoped lanes rather than carrying work itself.

## Steps

**1. Bring the durable state fully current FIRST.** Everything the successor needs must live on
disk, not in your context:
- **Build agent:** commit your green work; write/update a continuation doc
  `docs/superpowers/handoffs/<date>-<slug>-relay.md` covering: spec link, branch/worktree, what's
  done (commits), what's left (next concrete steps), any in-flight decisions, the coordinator
  label + threshold. Commit it.
- **Coordinator:** flush the **run manifest** (`docs/coordination/<run-id>.md`) — every agent's
  status/pane/branch/PR, merge order, outstanding escalations. Commit it. Add a one-line
  continuation note (what you were mid-doing).

**2. Spawn your successor with `herdr-handoff`.** A fresh session in the appropriate place. The
successor **skips `pnpm install`** — `node_modules` already exists in the reused worktree (shared
pnpm store); re-installing is wasted time/tokens. Bootstrap should say `[ -d node_modules ] || pnpm install`.
Use unattended full-access launch permissions for coordinator relays — and **always pass the
model explicitly**: `herdr … -- claude` boots **Opus** by default (cost policy is Sonnet for
build agents and coordinator loops; confirm the new pane says "Sonnet", respawn if not):
- Claude coordinator: `claude --model sonnet --permission-mode bypassPermissions`
- Codex coordinator: `codex -s danger-full-access -a never`

Do **not** spawn a Codex coordinator with the default, `read-only`, or `workspace-write` sandbox.
The coordinator must be able to update/push the manifest, run Herdr pane operations, and run local
verification without approval prompts.
- **Build agent:** same worktree/branch (your work continues there), bootstrap = "continue
  <slug>; `[ -d node_modules ] || pnpm install`; read your short `docs/.../<slug>-relay.md` and
  resume via `coordinated-build`. Read the spec/plan by SECTION for the current task only — never
  in full (full-reads bloated prior relays to ~71% on boot and forced them to relay again without
  building). You have a FRESH full budget: BUILD and commit per task — reading is not progress.
  Your relay trigger is the meter's 70% warning, same as everyone's; do not invent a higher
  personal threshold. If the warning fires before you have committed anything, you over-read:
  commit whatever is green, relay anyway, and say so in the continuation doc. Never end your turn
  between steps."
  **Tab and grid discipline applies to you too, not just the coordinator.** Split your successor's
  pane into the SAME role tab your own pane already lives in — a build agent stays in `Builders`,
  a QA agent stays in `QA` — never a new tab, never the other role's tab, and never the
  coordinator's own tab. Once your old pane is reaped, that tab has one pane fewer for a moment and
  one more once the successor lands: if that leaves the grid lopsided (not a clean 2x2 for four
  panes, 3x1 for three, etc.), square it up yourself using the same pop-out/split-back-in procedure
  the coordinate skill uses, or flag it to the coordinator so it does. Don't leave a messy grid for
  the coordinator to notice later.
- **Coordinator:** new pane; bootstrap = "you are the new coordinator for run <run-id>; read
  `docs/coordination/<run-id>.md` — the LATEST continuation note + current fleet/merge-order state
  (skim; the manifest is long — do NOT deep-read its full history or you bloat on boot), read
  `docs/coordination/AWAITING-BEN.md` (anything open there leads your next report to Ben), invoke
  `coordinate`, re-confirm the **session-id
  authority line** (your own pane's `agent_session.value` from `herdr pane list` — session id is
  authority; label is routing; the `…-N` pane number is ephemeral and reflows), re-adopt the live
  fleet (`herdr pane list` + labels), confirm you are driving, then reap the old coordinator —
  **resolving it fresh by label + session id, never by a `…-N` number written in this doc**." (No
  `pnpm install` — the coordinator pane doesn't build.)

  **⚠️ Never bake a `…-N` pane number into the bootstrap or the doc as a reap/address target.** Pane
  numbers reflow the instant any pane opens or closes, so a number written here is very likely stale
  by the time the successor reads it — it can point at an unrelated live session (a real near-miss:
  a baked-in reap number had become the user's chat pane). Identify panes by **label + session id**
  and have the successor resolve the number at read time.

**3. Verify the successor is actually driving** before you go (`herdr pane read <pane> --source recent --lines 12` — it
should be reading the doc / re-adopting, not stuck on a trust prompt). Answer any prompt with
`herdr pane send-keys <pane> Enter`.

**4. Request reap.** Tell whoever reaps you:
- **Build agent:** message the **coordinator** "relayed to <successor pane/label>, safe to reap me
  (my pane: <your pane id>)." The coordinator kills your pane.
- **Coordinator:** the **successor** kills your old pane once it confirms it's driving — it
  **resolves your pane fresh by label + session id and verifies the session id before closing**
  (never a bare `…-N` number from the bootstrap — it reflows). That instruction is in its bootstrap.

**Sign off every message this skill sends — the plan-ready ping, the reap request, the
coordinator's report to Ben — with your own pane id** (`$HERDR_PANE_ID`, or `herdr pane list`
matched on your session id). It reflows on the next open/close, so it isn't an address to reply
to; it's how the reader (coordinator, Ben, or a successor re-reading the manifest) ties the
message to the exact pane that sent it, at the moment it sent it.

## Quick reference

| Need | Command / skill |
| ---- | --------------- |
| Flush build state | commit work + write `docs/superpowers/handoffs/<date>-<slug>-relay.md` |
| Flush coordinator state | update + commit `docs/coordination/<run-id>.md` |
| Spawn successor | `herdr-handoff` skill; always `--model sonnet` for claude spawns; coordinator relays use `claude --model sonnet --permission-mode bypassPermissions` or `codex -s danger-full-access -a never` |
| Confirm it's driving | `herdr pane read <pane> --source recent --lines 12` |
| Reap a spent pane | resolve target fresh by label + session id, verify session id, then close (never a baked `…-N` number) |

## Common mistakes

- **Relaying with state still in your head.** If it isn't committed/written, the successor can't
  see it. Durable doc FIRST, spawn SECOND.
- **Relaying too late.** If you wait for felt degradation you can't write a clean continuation.
  Relay on the countable trigger (meter 70% warning / merge counter / compaction summary seen).
- **Re-running `pnpm install` in the successor.** The worktree already has `node_modules` — guard it.
- **Walking away before the successor is confirmed driving.** Always `herdr pane read <pane> --source recent --lines 12` it first.
- **Two sessions live on the same work.** The reap must happen — don't leave the spent session
  running alongside its successor.
- **Reaping by a stale pane number.** Pane `…-N` numbers reflow on every open/close, so a number
  baked into a doc/bootstrap is likely pointing somewhere else by read time (a baked-in reap target
  once became the user's chat pane). Before any `herdr pane close`, resolve the target fresh by
  **label + session id** and confirm the session id matches what you intend to kill.
