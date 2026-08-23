---
name: end-coordination
description: Use when a Jarv1s dev-coordinator run is fully finished — the queue is empty, nothing is left building or in review, and you are not relaying to a successor — to close the run out completely. Invoked as `/end-coordination` ("end coordination", "shut down the fleet", "we're done coordinating"). Reaps every remaining pane and worktree, verifies nothing landed unmerged, turns the idle watchdog back off, gives Ben a final report, and releases the coordinator name. NOT for a mid-run relay (`relay`) or for closing out one build agent's slice (`coordinated-wrap-up`) — this is the very last step of a whole run, done once.
---

# end-coordination — fully close out a finished coordinator run

## Overview

`coordinate` Phase 4 ("reap & report") runs after every merge, all run long. This skill is the
one-time step at the very end: the run's queue is empty, no build or QA lane is still going, and
there is no reason to keep a coordinator resident. Leaving the fleet and the watchdog running
after that point is exactly the kind of drift `coordinate`'s reap discipline exists to prevent —
it just needs a step that fires once, deliberately, instead of after every merge.

**Announce:** "Using end-coordination to close out run `<run-id>`." TaskCreate one item per step.

**Do not run this if:**
- Any spec in the manifest queue is still `building`, `blocked` on QA, or awaiting merge — finish
  or explicitly abandon it first (log the abandonment in the manifest, don't silently drop it).
- You are relaying because of context pressure — that is the `relay` skill; the successor keeps
  the watchdog running and the coordinator name held. Stopping the watchdog mid-relay would leave
  the new coordinator pane unwatched.

## Procedure

### 1. Confirm the run is actually done

Read the manifest's queue table. Every row must be `merged`, `closed`, or explicitly `deferred —
not this run` (with why). If anything is still open, stop here and go finish it — this skill is
not a way to walk away from unfinished work.

### 2. Sweep every remaining pane and worktree

```bash
herdr pane list
git worktree list
```

For every build or QA pane still open under this run: run `coordinate`'s Phase 3 step 6 four-gate
check before touching anything —

```bash
git -C <wt> rev-list --count origin/main..HEAD          # informational only, see below
git -C <wt> status --porcelain | grep -cv '^??'          # must be 0
for p in $(ls /proc | grep -E '^[0-9]+$'); do readlink /proc/$p/cwd 2>/dev/null; done | grep -Fc <wt>
herdr pane list                                          # no pane cwd'd there
```

A non-zero ahead-count does not by itself mean unmerged work (a squash-merged branch still shows
its old commits) — confirm landed-on-`main` status against the PR/issue, not the count alone.
**Never remove a worktree whose commits you have not confirmed on `main` or that you have not
explicitly logged as abandoned in the manifest.** If anything fails the four-gate check, stop and
handle it like any other Phase 3 reap — this skill does not get a looser version of that rule.

Once clear: `git worktree remove --force <wt>`, delete the branch, close the pane
(`herdr pane close <pane>`). Close any now-empty Builders/QA tabs.

### 3. Reconcile the manifest and GitHub one last time

- Every merged PR's issue is closed and its board item is in Done.
- `docs/coordination/AWAITING-BEN.md` — every entry this run opened is either resolved (comment it
  out with the resolution, same convention as existing entries) or, if genuinely still open,
  **left in place** — do not close this run out with a live question sitting unanswered and
  unflagged. If one remains open, do not proceed past this step; that's a reason to keep
  coordinating, not to stop.
- Write a closing entry to the run manifest: what shipped this run (PR links), what's still open
  and why (if anything was deliberately deferred), and that the run is now closed. Commit it with
  the `shared-checkout` skill's explicit-path discipline.

### 4. Turn the idle watchdog back off

The watchdog (`coordinator-watchdog.timer`) only earns its keep while a coordinator pane exists to
watch. Leaving it running after the last coordinator pane closes just means it does nothing every
minute forever — turn it off:

```bash
systemctl --user stop coordinator-watchdog.timer
```

Use `stop`, not `disable` — the next coordinator run turns it back on itself (`coordinate` Phase
0a). Confirm it's actually stopped:

```bash
systemctl --user list-timers coordinator-watchdog.timer   # should show inactive/no next run
```

If the pane it was watching is already closed, the watchdog script itself is a no-op on its next
tick regardless (it exits quietly when no pane is labeled `Coordinator`) — stopping the timer is
still worth doing so it isn't burning a tick every minute indefinitely for nothing.

### 5. Release the coordinator identity and close your own pane

```bash
herdr agent rename "$HERDR_PANE_ID" <something-neutral-or-just-let-it-go-idle>
```

There is no successor to hand the `coordinator` name to — this run is over. Leave the name free
for whoever starts the next one. Close your own pane last, after everything above is confirmed,
the same way you'd close any other reaped pane.

### 6. Final report to Ben

Same ordering and tone as `coordinate` Phase 4's report — plain English, no jargon, lead with
anything still awaiting him, then what shipped, then explicitly say the run is closed and the
fleet is down to nothing. This is the one message in the run that should make it obvious nothing
is quietly still running in the background.

## Red flags — STOP

- **Stopping the watchdog while any coordinator pane (yours or a successor's) is still meant to be
  driving.** That's what makes the pane go unwatched.
- **Reaping a pane/worktree without the four-gate check** just because "the run is ending anyway."
- **Closing out with an open `AWAITING-BEN.md` entry.** An unanswered question doesn't become
  answered because the run ended.
- **Running this mid-relay.** Relaying keeps the watchdog and the coordinator identity alive for
  the successor; this skill's whole point is that there is no successor.
