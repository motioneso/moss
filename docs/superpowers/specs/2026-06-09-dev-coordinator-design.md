# Dev Coordinator — Design

**Status:** Approved for build (design interview, 2026-06-09)
**Date:** 2026-06-09
**Owner:** Ben
**Depends on:** Herdr CLI (`~/.local/bin/herdr`), the existing `start` / `wrap-up` /
`herdr-handoff` / `herdr-pane-message` skills, and the Jarv1s SDD lifecycle (GitHub as source
of truth).
**Informs:** how all subsequent multi-agent Jarv1s build runs are orchestrated.

---

## Context

Jarv1s work is built by autonomous Claude Code agents running as Herdr panes. Today each agent
is launched ad hoc via `herdr-handoff` and supervised manually. There is no standing **role**
that (a) makes sure work is actually ready before any agent spawns, (b) fans the work out across
isolated agents while respecting collisions, (c) stays resident to unblock/approve/verify, and
(d) does so without drowning its own context.

This spec defines that role — a **dev coordinator** — and the coordinator-mode skill family that
implements it. It is the output of a `brainstorming` design interview (2026-06-09).

The coordinator sits **above** existing primitives, not replacing them:

- `herdr-handoff` — the one-shot "spawn a fresh agent in an isolated worktree" primitive the
  coordinator calls N times.
- `herdr-pane-message` — the channel agents and coordinator use to talk.
- `start` / `wrap-up` — the per-item SDD lifecycle the coordinated agent variants are derived
  from.

## Goals

1. **Readiness before spawn.** No agent is launched on a spec that is not approved and slotted
   into a dependency-aware run plan.
2. **Aggressive-but-safe fan-out.** Run independent specs in parallel; serialize anything that
   would collide (shared modules, global migration ordering, shared-table schema changes).
3. **Resident supervision.** Stay alive, be the escalation point for blockers / plan approvals /
   design forks / reviews, and catch silent agent failures.
4. **Coordinator owns the run end-to-end** in coordination mode: validate → spawn → supervise →
   verify → merge → close.
5. **Token/context discipline as a first-class constraint.** Keep the coordinator lean by pushing
   every heavy operation (building, reviewing, gate-running) into disposable agents; size build
   agents to land in ~150–250k tokens; hand off cleanly (agent **and** coordinator) before
   compaction degrades them.

## Non-Goals (YAGNI)

- **No new daemon / queue service.** Herdr + a committed run manifest are sufficient.
- **No per-milestone mega-agents.** One agent per spec, issue-sized. Per-milestone agents risk
  compaction and inefficiency.
- **No merge without the coordinator's own verified gate.** Autonomous merge is gated on a
  fresh QA agent's green verdict, not an author's self-report.
- **The coordinator never hand-edits feature code.** It delegates; its hands stay on
  orchestration, approval, merge, and the manifest.
- **No modification of the stock `start` / `wrap-up` / `herdr-*` skills.** The coordinated
  variants live beside them.

## Resolved Decisions

These were settled in the design interview; they are decisions, not options.

1. **Scope = resident supervisor with an upfront readiness gate** (not a one-shot launcher, not a
   hands-off fire-and-forget). The coordinator and Ben first agree what is in the run and confirm
   every item is ready; then it spawns and supervises.
2. **Approval model = spec-gated, coordinator approves plans.** The "ready to build" bar is an
   **approved spec**. The build agent writes its own plan and escalates it to the **coordinator**
   for approval; the coordinator approves plans that stay inside the spec's locked decisions and
   only routes a genuine product/architecture fork back to **Ben**. (This replaces `start`'s
   human plan→code gate.)
3. **Spec authorship is collaborative.** Ben authors specs, often interviewing with an agent
   (possibly the coordinator itself) during the readiness phase.
4. **Granularity = one agent per spec, issue-sized.** Each agent gets its own git worktree off
   `main`, its own branch, its own PR. (Honors CLAUDE.md: never share a working tree.)
5. **Concurrency is coordinator-gated by a collision map.** Specs that are genuinely independent
   run in parallel; specs that share code / migration ordering / table schema serialize. The
   coordinator owns **merge order and conflict resolution**.
6. **Dependency chains hand off forward.** When parallel is impossible, agent A completes its spec
   work (confirmed complete with the coordinator), then A uses `herdr-handoff` to queue the next
   agent as a **fresh session**, and the coordinator **reaps** A's spent session.
7. **Communication = hybrid push + poll.** Agents **push** escalations with Herdr's
   `agent prompt` API to the coordinator's unique agent name (those messages wake the
   coordinator). The coordinator uses `agent wait`/`agent read` for agent lifecycle and output,
   and polls `pane list` only for topology or unnamed panes, to catch crashes, stalls, and
   trust-prompt hangs.
8. **Context-pressure = agent self-report.** Each agent monitors its own context usage and, at
   the threshold, messages the coordinator and begins a clean self-handoff so the next session
   resumes seamlessly. (Not coordinator-scrape.)
9. **Coordination mode = the coordinator owns it all, including autonomous merge.** Once a PR is
   green, rebased, conflict-free, and re-verified on the integrated result by a QA agent, the
   coordinator merges, closes the issue, and moves the board — then reports.
10. **Heavy verification is offloaded to ephemeral QA agents.** Never inline in the coordinator's
    context; never the build agent grading its own work. A fresh QA agent runs the gate + review
    skills + reads the diff and returns only a **compact verdict**; the coordinator consumes the
    verdict and reaps the QA agent.
11. **The coordinator self-handoff is recursive.** At its own context threshold the coordinator
    flushes the manifest, spawns a **new coordinator** via `herdr-handoff`, which re-adopts the
    live fleet and kills the old coordinator's session.
12. **Externalized state = a durable run manifest.** The coordinator's working memory lives in a
    committed ledger, not its context. GitHub remains the source of truth for spec/issue/board
    status; the manifest holds only the in-flight operational state GitHub does not track.

## Architecture

### Lifecycle

**Phase 0 — Readiness (coordinator ↔ Ben).** Agree the run's contents. For every item, confirm
an **approved spec** exists (author/interview as needed). Build the **dependency + collision
map**. From it, produce the **run manifest**: build queue, parallel groups, serialized chains,
and merge order. Nothing spawns until Ben approves the manifest.

**Phase 1 — Spawn.** For each spec cleared to start: create an isolated worktree off `main`,
write a handoff doc from the template (carrying the per-task specifics + pointing at
`coordinated-build`), and `herdr agent start` a fresh build agent into the run's Herdr tab.
Parallel-safe specs launch together; serialized specs wait for their predecessor to land.

**Phase 2 — Supervise (resident).** Hybrid push + poll. Approve in-spec plans; route real design
forks to Ben; answer blockers. Sweep pane status between pushes to catch silent failures and
trust-prompt stalls. Keep the manifest current.

**Phase 3 — Verify & merge (coordinator owns it).** On an agent's "done", spawn an ephemeral
`coordinated-qa` agent → consume its compact verdict. On green: rebase per merge order, resolve
conflicts (task the owning agent for non-trivial ones), re-verify the integrated result via a QA
agent, **merge autonomously**, close the issue, move the board, reap the agents.

**Phase 4 — Reap & report.** Kill spent sessions to free resources. Keep the manifest + GitHub
consistent. Report shipped work with verified evidence.

### Components

- **`coordinate`** (skill, trigger `/coordinate`) — the coordinator session entrypoint. Drives
  Phases 0–4. Orchestrates the `herdr-*` primitives; never hand-edits feature code.
- **`coordinated-build`** (skill) — the build-agent entrypoint, derived from `start`. Reads its
  handoff doc, writes the plan, escalates it to the coordinator for approval, builds TDD/green,
  escalates blockers/forks, self-monitors context. **Does NOT touch board/milestone/merge.**
- **`coordinated-wrap-up`** (skill) — the build-agent closeout, derived from `wrap-up`. Clean
  tree, own green check, push, open PR, **message the coordinator the PR link + verified
  evidence** — then stop. Board/merge/milestone are the coordinator's, not the agent's.
- **`coordinated-qa`** (skill) — the ephemeral QA agent. Runs `pnpm verify:foundation` +
  `pnpm audit:release-hardening` + `/code-review` + `security-review` on a PR branch and returns
  a **compact structured verdict** (green/red, blocking findings, merge-ready y/n). Built as a
  real skill from the start.
- **`relay`** (skill, shared) — context self-handoff used by **both** build agents and the
  coordinator: at the threshold, flush state (continuation doc / manifest), `herdr-handoff` a
  successor, request reap.
- **Handoff-doc template** — per-agent committed doc carrying the per-task specifics (which spec,
  which worktree/branch, coordinator label, thresholds) and pointing at the right skill.
- **Run manifest** — the coordinator's externalized memory (schema below).

### Run manifest schema (`docs/coordination/<run-id>.md`)

Committed, durable, human-readable. Holds only in-flight operational state:

- **Run id / date / coordinator label.**
- **Queue** — one row per spec: spec path, GitHub issue #, status
  (`queued` / `building` / `awaiting-plan-approval` / `blocked` / `pr-open` / `qa` / `merged`),
  agent name + current pane id, branch, PR link. Agent names are the durable routing identity;
  pane IDs are opaque runtime handles and must be resolved from fresh Herdr responses.
- **Dependency / merge order** — the edges and the resulting serialized chains + parallel groups.
- **Outstanding escalations** — blockers / forks awaiting coordinator or Ben.
- **Reaped sessions** — spent panes killed, for auditability.

### Agent compact (what every spawned agent is told)

Carried by the handoff doc + encoded in `coordinated-build`:

- Work **only** your own worktree/branch; commit green per task; `git add` only your task's files.
- Run plan → **coordinator** approval → build (not the human gate).
- Escalate to coordinator agent name `<X>` via `herdr agent prompt` (through
  `herdr-pane-message`) on:
  blocker / plan-ready / design-fork / review-needed / done.
- **Self-monitor context**; at ~70% of the window, message the coordinator, then use `relay`:
  write a continuation handoff, `herdr-handoff` your successor, and let the coordinator reap you.
- Never touch the project board, milestones, or merge — those are the coordinator's.

## Defaults (chosen in interview; configurable per run)

- **Self-handoff threshold:** ~70% of the context window.
- **Build-agent token target:** land in ~150–250k tokens.
- **Manifest location:** `docs/coordination/<run-id>.md`, committed.
- **Resident liveness:** `ScheduleWakeup` ticks between push events.
- **Skill location:** `~/Jarv1s/.claude/skills/<name>/` (project-level — tightly coupled
  to Jarv1s gates + GitHub).
- **Skill family:** `coordinate`, `coordinated-build`, `coordinated-wrap-up`, `coordinated-qa`,
  `relay`.

## Exit Criteria

- The five skills exist at the project path with correct frontmatter (name + description), each
  derived-from / consistent-with its stock counterpart where applicable.
- The handoff-doc template and manifest schema are documented and used by `coordinate`.
- A dry-run readiness pass (Phase 0) produces a valid manifest for a real set of Phase-1 specs
  without spawning.
- A single-spec end-to-end run (spawn → build → plan-approval → PR → QA verdict → merge → close →
  reap) completes with the coordinator's context staying lean (heavy work offloaded).
- The coordinator self-handoff is exercised: a new coordinator re-adopts a live fleet from the
  manifest and reaps the old session.

## Hard Invariants honored

- **Never share a working tree** — every agent in its own worktree/branch/PR.
- **Verify, never trust an agent's self-report** — merge is gated on an independent QA agent's
  verified gate, not the author's word; the coordinator re-verifies the integrated result.
- **GitHub is the source of truth** — the manifest never replaces the board/issues/milestones;
  it only holds in-flight operational state.
- **Spec before build** — the readiness gate enforces an approved spec per item before spawn.
- **Migration ordering is global** — the collision map serializes any specs that touch migration
  numbering or shared tables (per the `multi-agent-db-isolation` memory).
- **No secrets in handoff docs / manifest** — operational metadata only.
