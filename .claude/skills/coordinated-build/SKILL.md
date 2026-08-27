---
name: coordinated-build
description: Use when you are a BUILD AGENT spawned by a dev coordinator to implement one approved spec in your own worktree/branch. Derived from the `start` skill but adapted for coordination mode — plan approval comes from the COORDINATOR (not a human gate), you escalate via herdr-pane-message, you self-monitor context, and you never touch the board/milestone/merge. Triggered by your handoff doc.
---

# coordinated-build — implement one spec under a coordinator

## Overview

You were spawned by a **coordinator** with a committed **handoff doc** and an **approved spec**.
Your job: take that spec from plan → build → PR, escalating to the coordinator at each gate.
This is the `start` skill's plan+build stages adapted for coordination mode.

**Key differences from stock `start`:**
- The plan approval gate is the **coordinator**, not a human. You message it and wait.
- You **escalate** blockers / forks / reviews / done to the coordinator's unique Herdr agent name
  (normally the registered name `coordinator`, with visible pane label `Coordinator`) via
  `herdr-pane-message` — you do not sit silently and you do not decide
  product/architecture forks. **Before messaging, run `herdr agent list` and confirm EXACTLY ONE
  live agent has that name.** If >1, do NOT guess a pane and do NOT message a
  different one (a mis-routed escalation once woke a stale duplicate coordinator).
  Never escalate by a raw `…-N` pane-id alone; those reflow when panes close.
  **If 0 agents hold the name, that's almost always a coordinator relay in progress** (the name is
  released for a few minutes during handoff). Don't halt in place: arm a background retry
  (`until herdr agent list | grep -q '"coordinator"'; do sleep 120; done` as a background Bash
  call, ~15 min budget) and keep working on anything not blocked by the escalation. If the name
  never comes back, the coordinator likely died — post your escalation as a comment on your PR or
  issue (durable, survives everything) and run `needs-ben` with a one-liner; never sit silent.
- You **self-monitor context** and relay before you degrade.
- You **never** move the project board, close issues/milestones, or merge — those are the
  coordinator's. Your closeout is `coordinated-wrap-up` (PR + report), nothing more.
- **Report terse and result-first.** Status updates, escalations, and reports to the coordinator
  lead with the result, skip recaps and option surveys, and stay in normal English — do **not**
  compress into caveman/telegraph style. (Caveman mode was removed from this family on 2026-07-27:
  the tokens it saved were small, and it mangled exactly the messages that need precision — plan
  approvals and `[SECURITY]` escalations.) Commit messages, PR bodies, and code comments keep their
  full conventional form.
- **Sign off every message to the coordinator with your own pane id** — `[pane <id>]` at the end
  (get it from `$HERDR_PANE_ID`, or `herdr pane list` matched on your session id). Pane numbers
  reflow, so this isn't an address to reply to later — it's a timestamp-equivalent: it lets the
  coordinator (or a successor reading the manifest afterward) tell which physical pane produced a
  given report without cross-referencing labels that may have since been reused or reaped.

## Procedure

**0. Orient + guardrails.**
- **Spawn-time env check (first).** Confirm you can resolve the skills you'll need
  (`coordinated-build` itself, `coordinated-wrap-up`, `relay`). If a skill does NOT resolve by name
  in your spawn environment, use the **absolute build-skill path** from your handoff doc and follow
  it directly — don't silently proceed half-equipped.
- Read your handoff doc in full (it's short by design). Read the spec/plan it points at BY SECTION
  for your current task only — never front-to-back in one pass. A full-read bloats a fresh context
  toward the relay threshold before you write any code, which forces a premature relay with zero
  progress (a real failure mode this run: lanes that spent hours emitting only handoff docs, no
  code). Reading is not progress — BUILD and commit per task; your relay trigger is the meter's
  70% warning (step 3), not a felt %. Note your worktree/branch, the coordinator agent name
  (normally `coordinator`), your
  **risk tier**, and any collision notes. A `security`-tier spec ships to a higher bar
  (cross-model QA + Ben merge sign-off) — build defensively and document trust boundaries.
- **Confirm your handoff names a GitHub task issue** (`#NN`, not "live feedback" / "—"). No issue
  means your work is invisible to every later sweep. Untracked lanes are exactly what the
  2026-07-26 repo cleanup deleted — nine live-verified commits, gone, because the lane that built
  them had no issue and no PR. If the field is empty, escalate before you plan; do not build.
- **Never end your turn mid-procedure.** Waiting on a background gate, a rebase, or your own next
  step is not a stopping point — chain straight into it. The only sanctioned stops are: coordinator
  plan approval (step 1), a real blocker you escalated, and your finish line (step 4).
- **Install only if needed:** `[ -d node_modules ] || pnpm install`. Worktrees share the pnpm
  store; if `node_modules` already exists (e.g. you're a relay successor), don't re-install.
  Confirm you are on your own branch, not `main`.
- Run the agentmemory required recalls from CLAUDE.md for the work you're doing (state, plus the
  row matching RLS / migrations / AccessContext / integration-test / frontend).
- Honor every CLAUDE.md **Hard Invariant**. Respect collision notes — **never assume a migration
  number**; the coordinator assigns landing order.

**½. Verify the spec against the actual branch (before planning).**
- Specs go stale. Related work lands between spec-authoring and your build, and the spec's premises
  (line numbers, "X doesn't exist yet", "add Y") may no longer hold. **Verify before you plan — don't
  inherit a stale spec.**
- For each spec item, grep/read the cited files on YOUR branch and confirm the gap or state the spec
  describes is still real. Specifically check:
  - "X doesn't exist" claims → grep for X; confirm it's still absent.
  - "Add Y" / "Change Z" claims → confirm Y is absent and Z is in the described state.
  - Cited line numbers / function names → confirm they still match (or note the drift).
- **If any spec item's premise has already shipped or drifted**, do NOT silently absorb it into your
  plan. **Escalate to the coordinator** with: which items are already done / stale, what the current
  branch state actually is, and your re-scoped plan reflecting reality. Let the coordinator confirm
  the re-scope before you proceed. (Proven necessary: 2026-06-24, #456 — spec written against pre-`202c638b`
  state, 3 of 5 items already shipped in intermediate commits; the build agent caught it by grounding
  in the branch, saving a rework cycle. Make that standard, not luck.)
- Only when every spec item's premise is verified current do you proceed to step 1 (plan).

**1. Plan — then escalate for approval.**
- **REQUIRED SUB-SKILL: `plan-build`** → `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. It
  **supersedes `superpowers:writing-plans`** (#1278) — do not use the old skill here. The
  difference that matters: plans carry *decisions* (exact paths, signatures, DDL, manifest JSON,
  test cases, verification commands) and **not** implementation bodies. Pasting complete code into
  a plan is what produced the six-round review loop that never converged (5→4→4→6 blockers).
- `plan-build` gates on a seams check with `file:line` citations before you plan, a kill gate after
  phase 1, and **an observed-passing e2e test per phase** — that last one is how you satisfy the
  live-path gate as you go instead of as rework at merge time.
- Read the spec with fresh eyes; verify coverage of its Exit Criteria.
- **If the spec touches a user-facing feature, module, or UI surface, your plan MUST include the
  UAT spec** (`tests/uat/specs/<slug>.uat.spec.ts`) and a row in
  `.claude/skills/coordinate/uat-trigger-map.tsv`. See step 4 — the PR cannot merge without a live
  proof, so plan for it rather than discovering it at the gate.
- **Message the coordinator** (label from your handoff doc) via `herdr-pane-message`: "plan ready
  for <slug>: <path>. Approve, or flag a fork." **STOP and wait** — do not write code.
- If the plan surfaces a genuine product/architecture fork the spec didn't settle, say so in the
  message; the coordinator routes it. If the coordinator approves, proceed.

**2. Build (only after coordinator approval).**
- Execute the plan with **`superpowers:test-driven-development`**. Each task commits green with
  the `Co-Authored-By: Claude` trailer; `git add` only that task's files.
- The superpowers *execution* skills (`executing-plans`, `subagent-driven-development`) are
  disabled in this repo by design — drive the plan yourself, task by task.
- **Escalate immediately** (don't burn turns spinning) if you hit a real blocker — a failing
  invariant, an ambiguous requirement, a missing dependency, a flaky gate you can't resolve.
  Message the coordinator with the specific question.
- **Answering QA findings: every "fixed" must be checkable in one look.** Your report back cites,
  per finding, the fix commit SHA and the exact `file:line`. An uncited "fixed" claim forces QA to
  re-review the whole PR (and one false claim doubled a QA cycle on 2026-08-19) — the coordinator
  will bounce it without spawning QA.

**3. Self-monitor context on countable events.** Relay on the **context-meter 70% warning** (the
user-level PostToolUse hook that fires in every session — don't trust felt %), or **immediately**
if you see a compaction summary in your own context. Message the coordinator
that you're relaying, then use the **`relay`** skill (commit work, write a continuation doc, spawn
your successor in this same worktree, request reap). Relay early enough to write a clean handoff.
**One relay is the budget** (Ben, 2026-08-23: one session per unit of work). Your slice was scoped
to fit one window; if your SUCCESSOR also hits 70% without an open PR, the slice was mis-scoped —
the successor reports that to the coordinator for a re-slice into smaller lanes instead of
relaying again.

**3b. Pre-push fast checks (before EVERY push).** Cheap trio + fresh rebase catch most CI
round-trips locally:
```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```
Fix anything red before pushing. This is in addition to your full gate at wrap-up.

**4. Close out with `coordinated-wrap-up`.** When the spec's Exit Criteria are met: invoke the
**`coordinated-wrap-up`** skill — clean tree, your own gate (it has the gate-DB recipe; do not
improvise one), push (after the pre-push trio), open PR, **post the live-path proof**, report the
PR + verified evidence to the coordinator. Then stop. The coordinator owns QA, merge, board, close.

**⛔ Live-path gate — part of YOUR finish line, not QA's.** If your work adds or changes a
user-facing feature, module, or UI surface, "green gate + PR open" is not done. The PR needs a
`gh pr comment` carrying a live end-to-end proof: the feature exercised **through the real UI on a
live dev instance** (UAT run output, exit code, and path assertions or bounded DOM/network/log
evidence). Without it the coordinator must refuse the
merge and send the lane back — so produce it yourself. If you genuinely cannot (no live instance
reachable, a step that needs Ben in person), say so plainly in the PR body and report the honest
status: **code-complete, unverified**. Full rule: `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Red flags — STOP

- About to **write code with no coordinator plan approval** → violates the gate. Message and wait.
- About to **assume a migration number** or change a shared table flagged in your collision notes
  → coordinate first; the coordinator serializes ordering.
- About to **decide a product/architecture fork** yourself → that's the coordinator's (or Ben's)
  call. Escalate.
- About to **move the board / close an issue / merge** → not yours. Report to the coordinator.
- About to push past your relay trigger (meter 70% warning / compaction summary seen) without
  relaying → you'll degrade and lose state. Relay now.
- About to push **without the pre-push trio** (`format:check && lint && typecheck`) + fresh rebase →
  you'll burn a CI round-trip. Run them first.
- About to **plan with `superpowers:writing-plans`** → superseded; use `plan-build`.
- About to report a UI-facing PR done **with no live-UI proof comment** → that's not done. Post the
  proof or report *code-complete, unverified*.
- About to **build a lane with no GitHub issue** → stop and escalate; untracked work gets deleted.
- About to **end your turn to "wait" for something** → don't. Chain into the next step.

## Common mistakes

- **Going quiet on a blocker.** The coordinator can't unblock what it can't see. Escalate early.
- **Treating `git add -A` as safe.** Stage only your task's files — other sessions share the repo
  host (though you have your own worktree, keep the habit).
- **Doing the coordinator's closeout.** PR + report is your finish line; merge/board/milestone are not.

See also: `plan-build` (your planning skill), `start` (the stock lifecycle this adapts),
`coordinated-wrap-up`, `relay`, `herdr-pane-message`, and CLAUDE.md (Hard Invariants, recalls).
