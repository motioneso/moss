---
name: coordinated-qa
description: Use when you are an EPHEMERAL QA AGENT spawned by a dev coordinator to independently verify one PR branch and return a compact verdict. You run the full gate + code review + security review on a branch you did NOT author, then report a short structured verdict (green/red, blocking findings, merge-ready y/n) back to the coordinator — and you are then reaped. This exists so the coordinator never burns its own context on heavy verification.
---

# coordinated-qa — independently verify a PR, return a compact verdict

## Overview

The coordinator must not spend its (long-lived, precious) context reading 10k-line logs and
diffs, and the build agent must not grade its own work (verify-never-trust). So **you** — a fresh,
throwaway agent — do the expensive verification on a branch you did not write, and hand back a
**short verdict**. The coordinator consumes the verdict and reaps you.

**Spend tokens on review, not on re-running the gate.** CI already executes the mechanical gate;
duplicating it is the single biggest QA waste. You **trust `gh pr checks`** for gate pass/fail and
spend your budget on what CI can't do: judgment review, invariant checking, and — for security
tier — an adversarial stronger-model hunt for what's NOT tested.

Your output to the coordinator is the compact verdict in step 5, **and** (always) a `gh pr comment`
posting it durably to the PR. Do not paste raw logs. Write the verdict **terse and result-first**
in normal English — caveman/telegraph style was removed from this family on 2026-07-27 because it
mangled precisely the findings that need precision.

## Inputs (from your handoff / bootstrap)

- The **PR branch** (and/or worktree) to verify, the **spec** it implements, the **risk tier**
  (`routine` | `sensitive` | `security`), and the **coordinator agent name** (normally
  `coordinator`) to report to. If the tier
  isn't given, infer it from the diff's content triggers and treat ambiguity as the higher tier.

## Procedure

**1. Get on the branch, then ground yourself.** Check out the PR branch into a **fresh
worktree/checkout** of your own (never an author's tree), under
`.claude/worktrees/qa-<issue>-r<round>` — never `/tmp`. `[ -d node_modules ] || pnpm install`.
**Re-review rounds are incremental (round 2+):** reuse round N-1's QA worktree, `git fetch` the
new commits, and review only `git diff <round-N-1-SHA>..HEAD` plus re-running whatever was red —
the build agent's fix report cites a commit and file:line per finding; verify exactly those. A
full fresh review is only for round 1, a force-push, or a diff touching files never reviewed.
(2026-08-23 audit: three small PRs burned 10+ full fresh-checkout rounds in one night.)
**Record the SHA you reviewed in your verdict; if the branch moves mid-review (SHA changed under
you), stop and report "branch moved, re-run round against <new SHA>" rather than grading a mix.
(shared pnpm store — skip if present). Then:
```bash
pnpm audit:preflight        # MUST exit 0 — a stale tree invalidates the whole review
git rev-parse HEAD          # record this SHA in your verdict
```
CLAUDE.md's Grounding Discipline requires this before any audit, review, or bug hunt: a review of
a tree that isn't what you think it is is worse than no review, because it reads as evidence. If
preflight is non-zero, fix the tree (or report RED with "ungrounded") before reviewing anything.
The `audit-grounding` skill covers grounding on a read-only worktree without disturbing another
session.

**2. Trust CI for the mechanical gate — don't re-run it.**
```bash
gh pr checks <PR>          # required checks pass/fail
```
- If **all required checks are green**, record their result and move to review. Do **NOT** run
  `pnpm verify:foundation` / `audit:release-hardening` — CI already did; re-running duplicates cost
  2–4× and adds nothing.
- **Green ≠ the gate ran.** Since #1277, docs-only PRs *skip* the full gate — the checks go green
  without executing it. If the PR is docs-only that's correct and fine; if it is docs-plus-code and
  CI skipped the gate, the skip condition is itself the finding. Say which case you're in.
- **Only if CI is red** do you reproduce locally to diagnose — via `scripts/run-gate.sh`, which
  handles the isolated gate DB for you. With `JARVIS_PGDATABASE` unset the gate writes to Ben's
  live dev database `jarv1s` and has taken his instance down:
  ```bash
  scripts/run-gate.sh start --exclusive       # fresh gate DB, flock'd, detached
  scripts/run-gate.sh wait                    # give the Bash tool a 600000 ms timeout
  scripts/run-gate.sh status                  # 0 green · 1 failed · 2 DIED · 3 running
  ```
  Never decide a gate is still alive from `pgrep`/`ps` — it matches Claude's own bash wrappers and
  stays true forever (that cost lane #1273 19 hours). Never pipe a gate to `tail`/`grep` as the
  final stage, and never trust a wrapper `echo $?`. Don't start a gate while a build lane is
  running one — concurrent `test:integration` has crashed the shared dev Postgres into recovery.
  A known flake (e.g. pg-boss worker-timeout) gets one re-run before you call it red; don't wave
  it off either.
- A red check is **stop-the-line** unless waivable per the coordinator's CI-waiver protocol (proven
  red on `main` @ same SHA + recorded + Ben-approved) — that's the coordinator's call, not yours.
  Report it red.

**3. Review the diff (where your tokens go).** Against `main`:
```bash
git fetch origin main && git diff --stat origin/main...HEAD
```
- Run **`/code-review`** (correctness + reuse/simplification) on the diff.
- Confirm the diff actually covers the spec's **Exit Criteria**.
- Check CLAUDE.md Hard Invariants: no RLS bypass, private-by-default, DataContextDb/VaultContext
  only, no secrets escaping (responses/logs/job payloads/exports/prompts), metadata-only job
  payloads, provider-agnostic AI, module isolation, migrations (never edited; module SQL in module
  `sql/`; no assumed migration numbers).

**3b. ⛔ Live-path gate — EVERY tier, independent of the trigger map.**

First ask a question the map cannot answer: **does this PR add or change a user-facing feature,
module, or UI surface?** If yes, CI-green plus `/code-review` is not merge-ready. The PR must
carry a `gh pr comment` with a live end-to-end proof — the feature exercised **through the real UI
on a live dev instance**, with the UAT run, exit code, and assertions or bounded DOM/network/log
evidence for the exercised path.

```bash
gh pr view <PR> --comments        # is the live-path proof actually there?
```
No proof comment on a user-facing PR = **MERGE-READY: NO**, at `routine` tier too. `routine` is
exactly where this has been skipped. Report it as *code-complete, unverified* — do not soften it to
green-with-a-note. Out of scope: docs-only, refactors with no user-visible surface, internal
tooling. Full rule: `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

**The live dev instance is shared — serialize your UAT.** Before driving the UI, check with the
coordinator (or `herdr pane list` labels) that no sibling QA lane or build lane is mid-UAT against
it; two lanes seeding and clicking one database corrupt each other's evidence. And NEVER touch
:1533 — that is prod.

Then run the changed-path e2e-UAT lookup — **also every tier**, since a spec that exists and fails
is a real failure regardless of how the diff was classified:

1. Resolve the PR's paths through the data-driven lookup (new UAT coverage adds a row to the map,
   not another conditional here):
   ```bash
   gh pr diff <PR> --name-only | .claude/skills/coordinate/resolve-uat-triggers.sh
   ```
   Each unique output row is `<blocking|advisory><TAB><spec>`. **No output does NOT mean "no live
   proof needed"** — the map is deliberately incomplete and can only name specs that exist. Record
   `not-triggered`, and fall back on the live-path question above, which is the real gate.
2. Run every resolved spec exactly through the live Phase-3 harness and capture its real exit:
   ```bash
   if pnpm test:uat -- "$spec"; then
     uat_exit=0
   else
     uat_exit=$?
   fi
   ```
   This is intentionally separate from the mechanical CI gate: #1027/#1000 exists because CI's
   mocked/isolated checks did not exercise the live install path that failed in #999.
3. Apply Ben's locked #1027 policy from the lookup mode. `blocking` is a runtime-path gate:
   failure makes this verdict RED and is **never waived** — fix it, then UAT again. `advisory`
   failure is a non-blocking finding surfaced to the coordinator. Record mode, spec, and exit
   code in the verdict either way.

**4. Tier-specific depth** (on top of steps 1–3b, which every tier gets).
- `routine`: steps 1–3b are enough.
- `sensitive`: add an explicit invariant walk-through (DataContextDb/VaultContext, metadata-only
  payloads, module isolation) naming each as ok/at-risk.
- `security`: run **`/security-review`** AND an **adversarial "what's NOT tested" pass** — you are
  spawned on a stronger model (Opus) precisely because same-lens review missed CRITICALs. Don't ask "does
  the gate pass"; ask **"which trust boundary is unproven, what attack path has no test, what does
  the happy-path test silently skip"** — auth bypass, RLS gaps, secret leakage, missing rate-limit,
  token/session handling, negative/authz tests absent. List concrete omissions, not vibes.

**5. Post the verdict to the PR, then report it to the coordinator.** ALWAYS `gh pr comment` first
(durable evidence that survives the coordinator's relay; mandatory for `security` tier before any
merge), then report to the coordinator by the appropriate channel, then stop.

**If invoked as a native subagent (via `Agent` tool):** your final message IS the verdict — output
the compact verdict block below as your last message with no trailing text. Do NOT call
`herdr-pane-message` (there is no coordinator pane to target).

**If invoked as a Herdr pane:** use `herdr agent prompt coordinator` through `herdr-pane-message`
with the compact block,
appending `[pane <your pane id>]` (`$HERDR_PANE_ID`, or `herdr pane list` matched on your session
id) — pane numbers reflow, so this ties the verdict to the exact pane that produced it without
relying on a label that may since have been reused or reaped. (Not applicable to the native-subagent
path — your final message returns as a tool result, not a Herdr pane message, so there's no pane to
sign off with.)

```bash
gh pr comment <PR> --body "QA verdict (<tier>): <paste the block below>"
```

```
QA <slug> (<tier>) — VERDICT: GREEN | RED
grounded: HEAD <sha>, audit:preflight EXIT=0
gate: CI <green|red> (gh pr checks)[ — gate SKIPPED (docs-only rule) | reproduced locally: VF_EXIT=<n> AUDIT_EXIT=<n> only if CI red]
live-path: <n/a, no user-facing surface | proof comment present <link> | MISSING — code-complete, unverified>
e2e-uat: <not-triggered | mode spec EXIT=n[, ...]>
review: <N blocking, M non-blocking>
  - BLOCKING: <file:line — one line each, or "none">
  - non-blocking: <one line each, or "none">
invariants: <ok | which one is at risk>
exit-criteria: <met | what's missing>
not-tested (security tier): <unproven trust boundaries / missing tests, or "n/a">
MERGE-READY: YES | NO  (NO if any blocking finding, red gate, unmet criteria, or missing live-path proof)
```

**6. You will be reaped.** The coordinator kills your session after consuming the verdict. Don't
start new work, don't merge, don't touch the board — verdict only.

## Red flags — STOP

- **Re-running `pnpm verify:foundation` when CI is already green** — that's the wasted-budget
  anti-pattern. Trust `gh pr checks`; reproduce locally only when CI is red.
- Skipping a spec emitted by the UAT lookup, or treating a `blocking` #1027 runtime failure as
  waivable.
- **Returning GREEN on a user-facing PR with no live-path proof comment**, at any tier — including
  `routine`, which is where it actually gets skipped.
- **Reading "no UAT rows resolved" as "no live proof needed"** — the map is incomplete by design.
- Reviewing without `pnpm audit:preflight` exiting 0, or omitting the grounded SHA.
- Running a local gate without an isolated `JARVIS_PGDATABASE` — that writes to Ben's live instance.
- Returning "green" from a piped exit code, or (when you did reproduce) from a partial run.
- **Skipping the `gh pr comment`** — the PR verdict is mandatory (durable evidence; hard gate for
  security tier). Post it before you message the coordinator.
- **Treating a `security`-tier PR as a gate-pass check** — your job there is the adversarial
  what's-NOT-tested pass, not "CI green so ship it".
- Pasting raw logs/diffs to the coordinator — that defeats the purpose. Verdict only.
- Approving a diff that doesn't meet the spec's Exit Criteria, or that risks a Hard Invariant.
- Merging or editing code — you verify, you don't change or land anything.

## Quick reference

| Need | Command / skill |
| ---- | --------------- |
| Ground the tree (first) | `pnpm audit:preflight` (must exit 0) · `git rev-parse HEAD` |
| Gate (trust CI) | `gh pr checks <PR>` — reproduce locally ONLY if red, on a fresh `JARVIS_PGDATABASE` |
| Live-path gate (all tiers) | `gh pr view <PR> --comments` — user-facing PR with no live-UI proof = MERGE-READY: NO |
| Diff vs main | `git fetch origin main && git diff --stat origin/main...HEAD` |
| Reviews | `/code-review` (all tiers) · `/security-review` + "what's NOT tested" (security tier) |
| Post verdict to PR | `gh pr comment <PR> --body "<compact block>"` (always; mandatory for security) |
| Report verdict (native subagent) | return compact verdict block as final message (no `herdr-pane-message`) |
| Report verdict (Herdr pane) | `herdr agent prompt coordinator` through `herdr-pane-message` (same compact block) |

See also: `coordinate` (who spawns + reaps you, risk tiers, model tiering), CLAUDE.md (Hard
Invariants you check against).
