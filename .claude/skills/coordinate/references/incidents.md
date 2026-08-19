# Incident history — why the coordinate rules exist

Read on demand when you want the rationale behind a rule. The rules themselves live in
`coordinate/SKILL.md`, `relay/SKILL.md`, and `coordinated-*/SKILL.md` — this file is evidence,
not instructions.

## 2026-06-09 — two coordinators ran a parallel merge loop

A stale pane still labelled `Coordinator` woke on an agent's escalation and started merging
independently alongside the live coordinator. → **Single-coordinator lock (Phase 0a)** and the
**session-id authority check before every merge** (Phase 3 step 0). Label = routing only
(re-claimable); only the immutable Claude session id is authority.

## 2026-06-11 (audit-remediation run) — pane numbers reflow constantly

The run restarted many times; `w…-N` pane numbers renumbered on every restart/split/reap. A reap
target baked into a bootstrap doc had become **the user's chat pane** by read time (near-miss).
→ Never write a `…-N` number into a manifest/handoff as an identifier; resolve panes fresh by
**label + session id** at read time.

## 2026-06-11 — blocking sleep poll-loops burned the coordinator's context

Six blocking `herdr pane run <pane> 'sleep 45'` iterations, each re-sending the coordinator's
full context per turn. → **Never block to wait.** Use `ScheduleWakeup` (fixed interval),
`Monitor` (event-driven), or a harness-tracked background task.

## Real run — same-lens Sonnet QA missed CRITICAL security findings

Sonnet QA reviewing Sonnet-built security-tier code passed CRITICALs that an adversarial
stronger-model pass caught. → **Security tier always gets Opus adversarial QA** ("what's NOT
tested / which trust boundary is unproven"), posted durably via `gh pr comment`, plus Ben's
explicit merge sign-off.

## 2026-06-23 — herdr spawns boot Opus by default

`herdr agent start … -- claude …` launches **Opus** unless `--model sonnet` is passed (Ben cost
policy: build/QA/coordinator loops run Sonnet). → Every spawn command carries `--model sonnet`,
and the spawner reads the pane to confirm "Sonnet" (respawn if wrong).

## 2026-06-24 — stale spec nearly caused a rework cycle (issue #456)

The spec was written against pre-`202c638b` state; 3 of 5 items had already shipped in
intermediate commits. The build agent caught it by grounding every spec premise in its branch
before planning. → **Spec-vs-branch verification is step ½ of `coordinated-build`**, and drift is
escalated, never silently absorbed.

## 2026-06-27 — unbounded pane reads were the dominant coordinator context leak

Measured on a live coordinator: bare `herdr pane read` ≈ 960 tokens vs `--source recent
--lines 12` ≈ 402; sweeps hit the whole fleet every loop, compounding to ~hundreds of k overnight.
`--source visible` **ignores `--lines`** on tall panes. → Only `--source recent --lines N` is
bounded; a user-level PreToolUse hook (`~/.claude/scripts/enforce-bounded-pane-read.sh`) now
denies unbounded reads, and a PostToolUse context-meter warns at 70% (self-calibrating — this is
what makes context % a *countable* relay trigger).

## 2026-07-08 — a module shipped as nine green slices and never worked

Nine slices each closed on CI-green plus code review; not one had been run through the real UI.
The install path was broken the whole time, so the owner could not use any of it. Green parts,
dead whole. → The **Live-Path Gate**: a user-facing feature, module, or UI surface merges only
with a live end-to-end proof posted to the PR (`gh pr comment` with the UAT run, exit code, and
assertions or bounded DOM/network/log evidence).
It overrides auto-merge at every tier including `routine`. No proof → the honest status is
**code-complete, unverified**, and the issue is not Done. Full rule:
`docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## 2026-07-1x — "complete code in every step" plans did not converge under review

Plans written to the old `superpowers:writing-plans` shape (full code bodies inline) drew a
six-round Codex review that never converged: 5 → 4 → 4 → 6 blockers, because each round reviewed
freshly-invented implementation detail instead of decisions. → Build agents plan with
**`plan-build`** (#1278), never `superpowers:writing-plans`. Plans carry decisions, contracts,
seam citations (`file:line`), and a rulings ledger — not code bodies. Phase 1 has a kill gate;
every phase names an e2e test that was **observed** passing.

## 2026-07-25 — an unscoped gate run took chat down for 90 minutes

`pnpm verify:foundation` ran without `JARVIS_PGDATABASE` set, so migrations and integration
tests executed against the live dev database `jarv1s`. Inline `VAR=x pnpm …` does **not** survive
backgrounding — the variable must be `export`ed. → `coordinated-wrap-up` step 2 now DROPs and
CREATEs a per-agent gate DB and `export`s it before backgrounding anything, and DROPs it when
done. Concurrent gate runs also crash the shared dev Postgres, so agents stagger them.

## 2026-07-2x — piped gate commands reported the filter's exit code

44% of gate invocations in one sampled run were piped (`… | tail`, `… | grep`), which returns the
**last stage's** status, not the gate's — red runs read as green. A wrapper `echo $?` after a
backgrounded command is equally worthless. → Never pipe a gate command: redirect to a file and
append a `### FINAL <cmd> rc=$?` marker inside the same subshell, then grep the marker. Enforced
by the blocking hook `.claude/hooks/check-gate-pipe.sh`.

## 2026-07-26 — a lane with no issue lost nine live-verified commits

A settings/onboarding stack was built, live-verified, and recorded in the manifest as
`Issue: "live feedback" / PR: —`. With no GitHub issue and no PR it was invisible to the
repo-cleanup sweep (38 worktrees, ~500 branches) and was deleted; it is now being rebuilt as
**#1270 / #1271**. → **No issue, no lane** — including work Ben authorizes verbally mid-run. The
manifest Queue's `Issue` column may never be `—` or prose, and the coordinator proves commits are
on `main` before reaping a pane or deleting a branch. (Everything deleted is recoverable from the
archive bundle and the `archive/2026-07-26/*` tags.)

## 2026-07-2x — `agent_status` reported idle while the agent was working

`herdr pane list` showed `agent_status: idle` for a pane whose own display read
`Perambulating… 19m`. → `agent_status` is a hint, not liveness. Confirm with a bounded pane read
before concluding an agent is stuck.

## 2026-07-2x — nudging a waiting agent made things worse

Two distinct failure modes were being treated as one. (a) **Frozen mid-turn** — an API 529 or a
hung turn; a nudge clears it, so do not re-spawn. (b) **Turn ended on a calm wait declaration**
("I'll wait for CI") — the agent is not stuck, it has abdicated; nudging restarts a session that
will simply declare another wait, and one such lane shipped an untested fallback (#1313). →
`TaskStop` it, take over the lane yourself, and read the diff before trusting any of it.

## 2026-07-27 — docs-only PRs are green without running the gate

Commit `00c6bf3e` made docs-only changes skip the full gate, so a green check set on such a PR is
not evidence the gate ran. → QA reads *which* checks ran, never just the ✅ colour, and says so in
its verdict.

## 2026-07-27 — caveman mode removed from this skill family

The telegraph-style compression saved few tokens and mangled exactly the messages that need
precision — plan approvals and `[SECURITY]` escalations. → Report terse and result-first in
normal English; do not compress into caveman/telegraph style.

## 2026-08-06 — spawned lanes were anonymous, in two namespaces at once

Two lanes spawned for PRs #1437 and #1379 showed up as bare pane ids with an empty label, so Ben
could not tell which was which without reading each pane. → Every spawn is named **twice**:
`herdr pane rename <pane> "<Human Label>"` sets what `herdr pane list` and FleetView display;
`herdr pane run <pane> "/rename <slug>"` sets the header inside the agent's own pane. Setting one
leaves the other blank. Name for the work (`PR1437 typecheck fix`), not the wave.

## 2026-08-06 — this skill's spawn command had drifted from the herdr CLI

`herdr agent start` accepts only `--kind`, `--pane` and `--timeout`; the documented `--cwd` and
`--tab` no longer exist, so the recorded command could not spawn anything. → Split the pane first
(`herdr pane split … --cwd <worktree>`), then start the agent into that pane. Two argument rules
that each cost a spawn: the agent name must be 1–32 chars of lowercase/digits/`-`/`_`
(`invalid_agent_name`), and the bootstrap must be shell-encodable — newlines, backticks or quotes
are rejected with `invalid_agent_argument`, which is herdr refusing to guess, not a transient
error. Pass a one-line pointer to a brief file kept **outside** the agent's worktree, since an
untracked file inside it reds that agent's own gate.
