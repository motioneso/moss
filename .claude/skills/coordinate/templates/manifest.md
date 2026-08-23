# Coordination Run — <run-id>

**Date:** <YYYY-MM-DD>
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`, **stable anchor = Claude session id `<session-id>`** (match `agent_session.value` in `herdr agent list`). Single-coordinator lock — exactly one live agent named `coordinator` whose session id matches this anchor holds authority for the life of the run. ⚠️ **Pane numbers (`w…-N`) reflow on every restart/split/reap — do NOT trust any pane number written in this file as an identifier; resolve the agent fresh by name+session at read time.** Agents escalate to the **agent name** (routing, re-claimable); the coordinator merges only when its own pane's **session id** (immutable, NOT the pane number) matches this recorded anchor.
**Merge policy:** autonomous-after-verified-QA for `routine`/`sensitive`; **`security`-tier needs Ben's explicit merge sign-off**
**Relay threshold:** security-tier merge → relay immediately after Phase 3 step 7; routine/sensitive `merges_since_relay` ≥ 2 → relay. No deferral. Compaction summary = already past safe → relay, merge nothing.
**merges_since_relay:** 0

> This is the coordinator's externalized memory. Keep it CURRENT — it is what lets a fresh
> coordinator adopt this run after a self-handoff. GitHub is the source of truth for
> spec/issue/board status; this file holds only in-flight operational state.

## Queue

| Spec | Issue | Tier | Status | Agent name | Pane | Branch | PR | Relays |
| ---- | ----- | ---- | ------ | ----------- | ---- | ------ | -- | ------ |
| docs/superpowers/specs/<slug>.md | #NN | routine\|sensitive\|security | queued | — | — | — | — | 0 |

**`Relays` counts lane self-handoffs — budget is ONE per lane** (Ben, 2026-08-23: one session per
unit of work). A lane reaching 2 was mis-scoped: don't relay it again, re-slice the remaining work
into new, smaller lanes with their own issues.

**The `Issue` column may never be `—` or prose.** Every lane needs a real GitHub `task` issue
before it is queued, including work Ben authorizes verbally mid-run. A lane recorded as
`Issue: "live feedback" / PR: —` in a prior run was live-verified, never filed, and swept away in
the 2026-07-26 cleanup along with nine commits — now being rebuilt as #1270/#1271.

Risk tier (content triggers, set at Phase 0 — see `coordinate` Risk tiering):
- `routine` — no schema/auth/secret surface → auto-merge after green QA.
- `sensitive` — shared-table migration / cross-module contract / export-delete / job-payload shape → auto-merge + Ben digest.
- `security` — auth/sessions/tokens/RLS/secrets/rate-limit/network-exposed/policy migration → cross-model Opus QA + `gh pr comment` verdict + **Ben merge sign-off**.

Status vocabulary: `queued` → `building` → `awaiting-plan-approval` → `blocked` →
`pr-open` → `qa` → `qa-failed`/`rework` → `awaiting-live-path` → `awaiting-ben-signoff` (security)
→ `merged` (or `handed-off` when relayed to a fresh session).

`awaiting-live-path` = QA is green but the PR has no live-UI proof comment. It does not merge and
its issue is not Done; the honest status is **code-complete, unverified**. Applies at every tier
including `routine` (`coordinate` → Live-Path Gate).

## Dependency / merge order

- **Parallel group 1:** <specs with no collisions — launch together>
- **Serialized chain A:** <spec-1> → <spec-2>  (reason: shared migration ordering / shared table / shared module)
- **Merge order:** <explicit order PRs land in `main`>

## CI waivers

A red required check merges ONLY if waived here. Each waiver: check name + the SHA it's proven
failing on `origin/main` at + the proof + **Ben-approved (y/date)**. A check failing twice =
stop-the-line + file an issue (no waiver).

| Check | PR | Proven red on `main` @ SHA | Proof | Ben-approved |
| ----- | -- | -------------------------- | ----- | ------------ |
| <none> | — | — | — | — |

## Outstanding escalations

- [ ] <blocker / design-fork awaiting coordinator or Ben — who owns it, since when>

## Merge audit (one block per merged PR)

Written at Phase 3 step 7, before the merge is reported. A merge with no block here is
unaccounted.

- **PR #NN** (<slug>):
  - QA verdict + model used: <verdict, model confirmed>
  - Live-path proof: <link to `gh pr comment`, or "N/A — not user-facing (why)">
  - Session id at merge matched lock anchor: y/n
  - Worktree check: `<verbatim VERDICT line from scripts/worktree-reapable.sh>`
  - Pane teardown recorded (Reaped sessions below): y/n

## Reaped sessions

One line per closed pane, written BEFORE the kill: what the agent was doing and where the work
landed. A closed pane with no line here is unaccounted work.

- <pane id / label — what it was doing; work landed at <branch/PR link | "no output — why">; killed when>
