---
name: coordinated-wrap-up
description: "Use when you are a BUILD AGENT under a dev coordinator and your spec's work is done — close out YOUR slice only. Derived from the `wrap-up` skill but scoped down: clean tree, your own green gate, push your branch, open the PR, then report the PR + verified evidence to the coordinator. You do NOT touch the board, milestones, or merge — those are the coordinator's."
---

# coordinated-wrap-up — close out your slice and hand it to the coordinator

## Overview

The stock `wrap-up` closes out a whole session including board/milestone/merge bookkeeping. Under
a coordinator, **that bookkeeping is the coordinator's, not yours.** Your finish line is a green,
pushed branch with an open PR and a truthful report to the coordinator. It then runs QA, merges,
and updates GitHub.

**Announce:** "Using coordinated-wrap-up to close out my slice." TaskCreate one item per step.

## Procedure

### 1. Clean tree — your files only

```bash
git status --porcelain
```
Commit your remaining green work by **explicit path** (`Co-Authored-By: Claude`). If a
linter/Prettier reformatted files, `pnpm format` then commit — `format:check` is part of the gate.
You have your own worktree, but still stage by path; never `git add -A` reflexively.

### 2. Your own green gate — on an ISOLATED gate DB, verified, not assumed

**The gate writes to a database. Pick the wrong one and you break Ben's running instance.** With
`JARVIS_PGDATABASE` unset, `verify:foundation` falls through to the live dev database `jarv1s` —
that happened on 2026-07-25 and took Ben's chat down for ~90 minutes (uat-seed rewrote the AI
provider rows; every request came back 400 "No active chat-capable model is configured"). Durable
uat-seed rows also survive between runs, so a reused gate DB fails the *next* run for no real
reason. Both are fixed by a fresh, per-agent gate DB.

**Use `scripts/run-gate.sh`. Do not hand-roll a background run and a wait loop** — that is how
lane #1273 lost 19 hours (its `pgrep` wait-loop matched Claude's own bash wrappers forever, so a
gate that had died at `db:migrate` looked alive all night). The runner does the fresh gate DB, the
`flock`, the `export`, and a trap-guaranteed `### FINAL rc=N` sentinel for you.

```bash
# 1. Start it. Returns immediately with a log path; the gate runs detached in its own session.
scripts/run-gate.sh start                       # defaults to pnpm verify:foundation

# 2. Poll to completion. Each call blocks up to 540s then exits 3 = "still running, call again".
#    Give the Bash tool a 600000 ms timeout — its 120s default is shorter than the wait.
scripts/run-gate.sh wait

# 3. Read the verdict. Exit 0 = green, 1 = the gate failed, 2 = the run DIED (no sentinel,
#    log gone stale), 3 = still running.
scripts/run-gate.sh status
```
Useful flags: `--gate audit:release-hardening` to run a different pnpm script (each gate gets its
own log), `--keep-db` to keep the gate DB for debugging, `--exclusive` to hold the DB lock for the
whole run when a sibling lane is also gating. `scripts/run-gate.sh stop` terminates a run and still
lands a sentinel. Full usage is in the script header.

- **Liveness comes from the sentinel + log mtime, never from `ps`/`pgrep`.** Every Claude Bash call
  is wrapped in a snapshot-sourcing shell whose command line contains your worktree path and your
  command text, so `pgrep -f <anything>` matches wrapper shells — and the wait loop itself — long
  after the real process is gone. A process count cannot tell "still working" from "died hours ago".
- **Never pipe a gate to `tail`/`grep` as the final stage** — a pipeline returns the *filter's*
  exit code and masks the failure. This is measured: 44% of gate invocations in one sampled run
  were piped, and a blocking PreToolUse hook (`.claude/hooks/check-gate-pipe.sh`) now denies them.
  A denial is the hook working; fix the command, don't route around it.
- **Never trust a wrapper `echo $?`** either — read the runner's exit code or the `### FINAL` line
  out of the log. A wrapper echo masked a real rc=1 during the #1270 recovery.
- **A gate that dies on `error: tuple concurrently updated` is contention, not your bug.** Another
  worktree ran DDL at the same moment. Don't just re-run locally — you re-enter the same window;
  push and let CI be the gate, and tell the coordinator.
- **Run the FULL suite**, not just your module — a shared-table/contract change can break other
  suites. If red, fix it (`superpowers:systematic-debugging`) before reporting done.
- This is *your* check so the PR isn't dead-on-arrival; the coordinator re-verifies independently
  via a QA agent (verify-never-trust). Don't treat your green as the final word.

### 3. Pre-push fast checks + push + open the PR

Before pushing, run the cheap trio + a fresh rebase (catches most CI round-trips locally):
```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```
Then push and open the PR:
```bash
git push -u origin <your-branch>
gh pr create --base main --head <your-branch> \
  --title "<type>(<scope>): <spec> (#NN)" \
  --body "<scope shipped · spec link · VF_EXIT/AUDIT_EXIT evidence · what remains, if anything>"
```
Body states scope, the spec link, your verified gate result (exit codes), and anything deferred
(with where it's tracked). Open follow-up issues for deferred scope so it never silently vanishes.

### 3b. ⛔ Live-path proof — the real finish line for anything user-facing

If the PR adds or changes a **user-facing feature, module, or UI surface**, a green gate and an
open PR are *not* done. The PR needs a live end-to-end proof comment, and without it the
coordinator must refuse the merge — so produce it here, not after a rejection.

```bash
# Run the UAT spec(s) your diff triggers, capturing a real exit:
gh pr diff <PR> --name-only | .claude/skills/coordinate/resolve-uat-triggers.sh
( pnpm test:uat -- "<spec>" > /tmp/cb-uat.log 2>&1; echo "### FINAL test:uat rc=$?" >> /tmp/cb-uat.log ) &

gh pr comment <PR> --body "Live-path proof: <UAT run + rc, assertions/evidence, path exercised>"
```
The proof must show the feature **exercised through the real UI on a live dev instance** — owner
signup → the real Settings/module path → the feature actually running. Record the exact assertions
and bounded DOM, network, or application-log evidence needed to prove that path.

**A passing headless test alone is not the artifact** — it doesn't prove a person can reach the
path. If you can't produce the proof (no live instance, or a step that needs Ben in person), say
exactly that in the PR body and report the honest status: **code-complete, unverified**. Never
report it as done. Full rule: `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

### 5. Report to the coordinator — then STOP (teardown FIRST — step 4 — the report asserts it already happened)

Report **terse and result-first** — lead with the outcome, no recap, no option survey, but in
normal English (caveman/telegraph style was removed from this family on 2026-07-27; it saved few
tokens and mangled the messages that need precision). The PR body stays conventional.

Via `herdr agent prompt coordinator` through `herdr-pane-message`:

> "<slug> DONE. PR: <link>. VF_EXIT=0 AUDIT_EXIT=0 (full suite, gate DB jarvis_gate_<slug>).
> Live-path: <proof comment posted | n/a, no user-facing surface | NOT MET — code-complete,
> unverified because <reason>>. Branch <b> pushed, rebased on origin/main as of <sha>.
> Deferred: <none | issue #NN>. Teardown: <instance stopped PIDs … | none started>, <N seed rows
> deleted | none seeded>, worktree reapable. Ready for QA + merge. [pane <your pane id>]"

Sign off with your own pane id (`$HERDR_PANE_ID`, or `herdr pane list` matched on your session id)
— pane numbers reflow, so this isn't a return address, it's how the coordinator (or a successor
reading the manifest later) ties a report to the physical pane that produced it without
cross-referencing a label that may since have been reused or reaped.

Then stop — but **stay alive. Your lane owns this branch until the PR is MERGED** (or the
coordinator explicitly reassigns it). "Worktree reapable" describes the tree's state, not
permission to disappear: QA has not run yet, and red findings come back to YOU with your context
(re-open, fix, cite commit + file:line per finding, report again). **Do not** move the board,
close the issue/milestone, or merge — the coordinator owns QA, merge order, conflict resolution,
and all GitHub bookkeeping.

### 4. Tear down everything you stood up — BEFORE the report

**Your work is not finished when the PR is green.** Anything you started outside your own worktree
is still running until you stop it, and the next lane inherits the mess. Do this BEFORE writing the step-5 report — the old ordering (report first, teardown after) invited asserting teardown that had not happened yet. Before you report done:

- **Dev instances: stop by explicit PID, never by name pattern.** Record the PIDs when you start
  them. `pkill -f worker` matches prod's containerised worker, which shows up in host `ps` as a
  bare `node dist/worker.js` — a broad pattern kill hits production and nothing else.
- **Seeded rows: delete by recorded id, and check the row counts.** The dev DB is shared. Never
  `TRUNCATE`, never a seeded reset.
- **Your worktree: tell the coordinator it is reapable** (branch pushed, tree clean, nothing
  running in it), or say plainly what you are leaving behind and why.

Then state teardown explicitly in your report — "instance stopped (PIDs 1234/1235), 3 seed rows
deleted, worktree reapable". Silence reads as done, and it usually isn't.

### 6. Durable memory (only if you discovered something non-obvious)

If you hit a real trap or made a non-obvious decision, `memory_save` (`project: "jarv1s"`) now —
or tell the coordinator so it's captured. Don't store secrets.

## Red flags — STOP

- Claiming "green" from an exit code obtained through a pipe, or from a wrapper `echo $?` instead
  of the `### FINAL` line in the log.
- **Waiting on `pgrep`/`ps` to decide a gate is still running.** It matches Claude's own bash
  wrappers and never goes false — use `scripts/run-gate.sh wait`.
- **Hand-rolling the gate DB or the background run** instead of `scripts/run-gate.sh` — without an
  exported `JARVIS_PGDATABASE` you are writing to Ben's live dev instance.
- Moving the board / closing an issue / **merging** — not yours; report instead.
- Reporting "done" with a red or unrun full gate.
- **Reporting a user-facing PR "done" with no live-path proof comment** — the honest status is
  *code-complete, unverified*, and saying "done" instead is the failure the gate exists to stop.
- Letting deferred scope evaporate (no follow-up issue).
- **Reporting done with a dev instance still listening or seed rows still in the shared DB.** A
  green PR is not a finished lane; leaving `:3000` held is how the next lane loses an hour.
- **Killing anything by name pattern.** Prod's worker looks like a stray dev process in `ps`.

## Quick reference

| Need | Command |
| ---- | ------- |
| Clean tree (your paths) | `git status --porcelain` · `pnpm format` |
| Gate (fresh DB + real exit) | `scripts/run-gate.sh start` → `scripts/run-gate.sh wait` → `scripts/run-gate.sh status` — never a pipe, never a wrapper `echo $?`, never `pgrep` |
| Second gate | `scripts/run-gate.sh start --gate audit:release-hardening` (its own log) |
| Pre-push trio + rebase | `pnpm format:check && pnpm lint && pnpm typecheck` · `git fetch origin main && git rebase origin/main` |
| Push + PR | `git push -u origin <b>` · `gh pr create --base main` |
| Live-path proof (UI-facing) | `resolve-uat-triggers.sh` → `pnpm test:uat -- <spec>` → `gh pr comment` with run + assertions/evidence |
| Report done | `herdr agent prompt coordinator` through `herdr-pane-message` (PR link + exit codes + live-path status) |

See also: `wrap-up` (the stock skill this scopes down), `coordinated-build`, `relay`.
