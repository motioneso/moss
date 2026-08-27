---
name: verify-gate
description: The only safe way to run the local gate — `pnpm verify:foundation` or any DB-touching test or migrate command — in this repo. Wraps scripts/run-gate.sh (fresh isolated gate database, detached run, sentinel-based wait). Use BEFORE running verify:foundation, test:integration, test:uat-seed, or db:migrate.
---

# Running the gate

`pnpm verify:foundation` is the full local gate (`package.json` lists what it chains). It is not
safe to run bare, and it is not safe to hand-roll either — every improvised variant here has a
real incident behind it (live-DB hit, piped exit code read red as green, a 19-hour dead gate that
`pgrep` said was still running).

## The one procedure: scripts/run-gate.sh

Do not DROP/CREATE databases, export variables, background subshells, or write wait loops by
hand. The script does all of it correctly.

```bash
# 1. Launch — creates a fresh isolated gate DB, detaches, prints the log path, returns at once.
scripts/run-gate.sh start            # add --gate <pnpm-script> for a narrower gate

# 2. Wait — blocks until the gate reaches a terminal state or the timeout.
#    Pass an explicit Bash tool timeout of 600000 ms; the command's own default is 540s.
scripts/run-gate.sh wait             # exit 3 = still running, call wait again

# 3. Verdict — exit code is the answer; never parse prose, never pipe.
scripts/run-gate.sh status
```

Exit codes for `status`/`wait`: `0` passed, `1` failed (gate's rc printed), `2` dead (no sentinel
and the run is gone), `3` still running. **Check the exit code, not the text.**

A long wait costs zero context if you run it as a background Bash task with an `until` loop
around `wait`, and let the completion notification bring you back — never foreground-sleep or
re-run `status` in a loop.

## Rules that still apply around the script

- **Never pipe a gate command** (`| tail`, `| grep`, `| tee`): a pipeline returns the filter's
  exit code, so red reads as green. `.claude/hooks/check-gate-pipe.sh` blocks the obvious forms —
  a block there is the hook working, not an obstacle.
- **Never decide liveness with `pgrep`/`ps`.** The Bash tool's wrapper shells match your pattern
  long after the real process died (the 19-hour stall). The script's sentinel is the only truth.
- **Stagger with other sessions.** Concurrent gate runs crash the shared dev Postgres. Check
  `herdr pane list` before starting one; if another gate is running, wait for it.
- **Green local is not green CI.** The gate does **not** include `test:e2e`; CI runs the browser
  suite separately. Say which one you verified.
- **`pnpm test:unit` trap:** the module-sdk-worker suite fails locally but is green in CI — do
  not bisect your branch over it.

Other skills (wrap-up, coordinated-wrap-up, coordinated-qa, start) must invoke this skill rather
than restating any gate recipe. If you see an inlined gate procedure elsewhere that contradicts
this file, this file wins.
