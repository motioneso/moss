---
name: verify-gate
description: The only safe way to run the local gate — `pnpm verify:foundation` or any DB-touching test or migrate command — in this repo. Wraps scripts/run-gate.sh (own throwaway Postgres server per run, detached run, sentinel-based wait). Use BEFORE running verify:foundation, test:integration, test:uat-seed, or db:migrate.
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
# 1. Launch — starts a throwaway pgvector Postgres server just for this run
#    (own container, own port, nothing shared with the dev database or any
#    other gate), detaches, confirms the runner started (about a second),
#    prints the log path, and returns.
scripts/run-gate.sh start            # add --gate <pnpm-script> for a narrower gate

# 2. Wait — launch this as ONE Bash call with run_in_background: true. It never gives up
#    early, so no foreground timeout to size. You keep working; you get exactly one
#    completion notification when the gate reaches a terminal state.
scripts/run-gate.sh wait --follow
```

Read the exit code the background call returns — that's the verdict, no separate `status` call
needed. Exit codes: `0` passed, `1` failed (gate's rc printed), `2` dead (no sentinel and the run
is gone). **Check the exit code, not the text.** (`status` and plain `wait` without `--follow`
still exist for a one-shot check or a bounded foreground wait, but `wait --follow` backgrounded is
the one procedure to use here.)

Every run log records what it tested: the commit (`### COMMIT`), the dirty-tree file
list (`### DIRTY`), an input fingerprint over commit plus status plus file contents
(`### FINGERPRINT` — same files dirty with different bytes hash differently), toolchain
versions (`### TOOLCHAIN`), the database-server version (`### POSTGRES`), the throwaway
server (`### GATE_CONTAINER`, launched per run and removed when the run ends), the gate
database (`### DB`, freshly provisioned inside that server), the exact command (`### GATE`),
timing, outcome, and log path. File bytes never enter the log, only digests — no secrets.
`status` and `wait` repeat commit, tree, fingerprint, and toolchain in one line.

## Evidence reuse rule (#2462)

An old result may be reused only when every compared input matches AND project rules
permit it:

- commit matches, fingerprint is known on both sides and equal, toolchain and
  database identity match, and the command matches;
- changed or unknown relevant inputs invalidate reuse — a dirty tree with different
  bytes, a different fingerprint, or an `unknown` anywhere means re-run;
- receipt reuse never replaces required CI, independent review, or live proof.
  A matching receipt answers "what was tested", not "what may merge".

## Rules that still apply around the script

- **Never run a database-touching command directly** (`pnpm verify:foundation`,
  `pnpm test:integration`, `pnpm test:uat-seed`, `pnpm db:migrate`, or direct `vitest`/`tsx`
  at those suites): anything not launched through `scripts/run-gate.sh` lands on the shared
  dev database. `.claude/hooks/check-gate-pipe.sh` blocks these with one line pointing back
  here — a block there is the hook working, not an obstacle. Deliberate exception: when Ben
  asks for a migration of the dev database itself (not a gate), prefix the command with
  `JARVIS_ALLOW_DIRECT_DB=1` — that token in command position disables only this block.
- **Never pipe a gate command** (`| tail`, `| grep`, `| tee`): a pipeline returns the filter's
  exit code, so red reads as green. The same hook blocks the obvious forms.
- **Never decide liveness with `pgrep`/`ps`.** The Bash tool's wrapper shells match your pattern
  long after the real process died (the 19-hour stall). The script's sentinel is the only truth.
- **A failed launch is loud, not a hang.** If `start` cannot get the runner going, it exits
  non-zero (exit `4`, which now includes a failed launch) and marks the log, and `status`/`wait`
  report dead (exit `2`) with the reason. When `start` exits non-zero, fix the reported cause
  and start again — never read an earlier result as this run's verdict.
- **Concurrent gates are safe.** Each run gets its own throwaway Postgres server, so two gates
  at once never share a server with each other or with the dev instance. No staggering needed.
- **Green local is not green CI.** The gate does **not** include `test:e2e`; CI runs the browser
  suite separately. Say which one you verified.
- **`pnpm test:unit` trap:** the module-sdk-worker suite fails locally but is green in CI — do
  not bisect your branch over it.

Other skills (wrap-up, coordinated-wrap-up, coordinated-qa, start) must invoke this skill rather
than restating any gate recipe. If you see an inlined gate procedure elsewhere that contradicts
this file, this file wins.
