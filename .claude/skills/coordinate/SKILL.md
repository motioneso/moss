---
name: coordinate
description: Use to run a Jarv1s DEV COORDINATOR session — a resident supervisor that turns approved specs into merged code by orchestrating a fleet of isolated build agents over Herdr. Invoked as `/coordinate` ("coordinate this run", "run the fleet"). Validates readiness with Ben, spawns collision-gated agents, approves plans, runs ephemeral QA, merges after verified green, relays before its own context fills. NOT for building one spec yourself (`coordinated-build`) or messaging one agent (`herdr-pane-message`).
---

# coordinate — run a dev coordinator session

## Overview

You are the **coordinator**: a long-lived session that drives an entire build run over Herdr —
validate → spawn → supervise → verify → merge → close — **without burning your own context.**
Everything heavy (building, reviewing, gate-running) happens in disposable agents; you hold
orchestration, approvals, merge decisions, and the run manifest. Prime directive: **stay lean and
keep the fleet moving.**

Design: `docs/superpowers/specs/2026-06-09-dev-coordinator-design.md`.
Why these rules exist: `references/incidents.md` (read on demand, not up front).

**Announce:** "Using coordinate to run the fleet." TaskCreate one item per phase.

## Context discipline (read first — these keep you alive)

- **Never read raw gate logs or full diffs.** Delegate to a QA agent; consume its verdict.
- **Plan bodies and QA verdict bodies never enter your context** — they live on the PR; you read
  one-line pointers.
- **State lives in the manifest** (`docs/coordination/<run-id>.md`), not your head. Forget
  aggressively; the manifest is what lets a successor adopt the run.
- **Bound every pane read:** `herdr pane read <pane> --source recent --lines 12`. `--source
  visible` ignores `--lines` on tall panes; a user-level PreToolUse hook also denies unbounded
  reads, so an unbounded read failing is the hook working, not an error to route around.
- **Relay triggers** (evaluated at Phase 3 step 7; **no deferral** — when one fires, the only
  permitted action is flush + relay; remaining bookkeeping goes in the manifest continuation note):
  1. **Context-meter warning** — the user-level PostToolUse meter warns at **70%**. First warning
     = relay now.
  2. **Merge counter** — relay after **every security-tier merge** unconditionally; relay after
     **every 2 routine/sensitive merges**. Track `merges_since_relay` in the manifest.
  3. **Compaction tripwire (backstop)** — a compaction summary in your own context means you are
     already past safe: flush + relay **immediately, merge nothing first**.

## Roles you orchestrate (skills)

- **`coordinated-build`** — each build agent (plan → your approval → build → PR).
- **`coordinated-wrap-up`** — how a build agent finishes (PR + report to you).
- **`coordinated-qa`** — ephemeral QA per PR; returns a compact verdict. Registered as an agent
  type in `.claude/agents/coordinated-qa.md` (no Edit/Write tools — verdict-only by construction).
- **`plan-build`** — the planning skill every build agent uses (#1278; **supersedes
  `superpowers:writing-plans`**). Plans carry decisions, not code bodies, and each phase ships an
  observed-passing e2e test — that is what keeps the live-path gate from becoming merge-time rework.
- **`audit-grounding`** — `pnpm audit:preflight` before any audit/review, including QA's.
- **`relay`** — context self-handoff, for build agents AND for you.
- **`herdr-handoff`** (spawn), **`herdr-pane-message`** (talk), **`start`/`wrap-up`** (the stock
  lifecycle the coordinated variants derive from).

Templates: `.claude/skills/coordinate/templates/{manifest,handoff}.md`.

## Model policy (Sonnet loop → Opus for reasoning-heavy sub-tasks)

The run cost is dominated by the resident session re-sending its context every turn, so the loop
runs cheap and spends up only where same-lens review demonstrably misses things.

| Work | Model | Why |
| ---- | ----- | --- |
| Resident coordinator loop + build agents + routine/sensitive QA | **Sonnet** | ~90% mechanical; Opus here is the single biggest $ waste |
| Phase-0 collision/dependency map | **Opus** (one-shot subagent) | reasoning-heavy, done once |
| Design-fork adjudication | **Opus** (one-shot subagent) | wrong call has data-loss/security cost |
| Security-tier QA (adversarial pass) | **Opus** | same-lens Sonnet missed CRITICALs in a real run — THE place to spend up. (For a true cross-model lens, use Codex via `/codex:adversarial-review`.) |
| Gate execution (lint/typecheck/test) | **CI — don't re-run** | QA trusts `gh pr checks`; matched e2e-UAT remains a separate sensitive-tier runtime gate |

**⚠️ Herdr spawns default to Opus.** Every `herdr agent start … -- claude …` MUST pass
`--model sonnet`, and after spawning you read the pane to confirm it says "Sonnet" — respawn if it
booted Opus. This applies to build agents, Herdr-fallback QA, and relay successors (yours and
theirs).

**Opus escalation** happens via one-shot subagents — never reason through these inline:

- **Hard triggers (always Opus):** agent message contains `[SECURITY]` / `[AUTH]` / `[RLS]` /
  `[CRIT]`; any security-tier PR QA; the Phase-0 collision map.
- **Soft triggers (Opus when uncertain):** `[DESIGN-FORK]`, a fork the spec didn't settle,
  choices with security or data-loss consequences.
- **Pattern:** `Agent(model: "opus", prompt: "<pointer-style question>")` → await compact verdict
  → relay to agent + update manifest. **Prompts are pointer-style:** pass PR numbers, file paths,
  and the manifest section — the Opus agent reads them itself. Never paste bodies through your own
  context to hand them over.
- **Agents:** tag escalations `[SECURITY]`/`[AUTH]`/`[DESIGN-FORK]`/`[CRIT]` to guarantee routing.

## Risk tiering — classify every spec by content (not judgment)

Tier each queued spec in the manifest at Phase 0; carry it on the handoff doc. The tier decides
how hard the PR is verified and whether Ben must sign the merge.

| Tier | Content triggers (any one matches) | What it gets |
| ---- | ---------------------------------- | ------------ |
| `routine` | none of the below — pure UI, docs, isolated non-shared module | standard QA (CI gate + `/code-review` + exit-criteria); **auto-merge after green** |
| `sensitive` | shared-table migration, cross-module contract change, export/deletion paths, job-payload shape changes, module distribution/install/reconcile, sync/import, runtime nav, CLI runner | standard QA **plus** explicit invariant check (DataContextDb/VaultContext, metadata-only payloads, module isolation) **plus matched e2e-UAT**; per-merge digest to Ben |
| `security` | auth · sessions · tokens · RLS · secrets · credential handling · rate-limit · network-exposed surface · policy-touching schema migrations | **Opus adversarial QA** (hunts *what's NOT tested / unproven trust boundaries*); **mandatory `gh pr comment` verdict**; **Ben's explicit merge sign-off** |

Tiering is mechanical: if a trigger appears in the spec or diff, it IS that tier — no "probably
fine" downgrade. In doubt between two tiers, take the higher.

**⛔ LIVE-PATH GATE — overrides every tier's "auto-merge after green."** If the PR touches a
user-facing feature, module, or UI surface, CI-green + `/code-review` is **not** merge-ready. It
needs a live end-to-end proof on the PR: the feature installed and exercised **through the real UI
on a live dev instance**, posted as a `gh pr comment` with the UAT run, exit code, and assertions or
bounded DOM/network/log evidence. No artifact →
do not merge, do not mark the issue or epic Done; report it as *code-complete, unverified*. This
binds at `routine` tier too — `routine` is exactly where it has been skipped. Full rule:
`docs/DEVELOPMENT_STANDARDS.md` → **Live-Path Gate**.

**Security-tier sign-off is a first-class gate:** spawn the Opus QA agent → it posts its verdict
to the PR (`gh pr comment`, durable evidence that survives your relay) → surface PR + verdict
pointer to Ben with "security-tier — your merge sign-off?" → **PAUSE**; merge only on his explicit
OK. `routine` auto-merges after green; `sensitive` auto-merges + per-merge digest to Ben. Maintain
a **standing per-merge digest** (what landed, PR link, tier, verified exit codes) so Ben has a
continuous picture without gating routine work.

## Phase 0a — claim the single-coordinator lock (FIRST, before anything)

There must be **exactly one** coordinator (see incidents: a stale labelled pane once ran a
parallel merge loop).

1. `herdr pane rename "$HERDR_PANE_ID" "Coordinator"`.
2. Verify uniqueness: `herdr pane list` shows **exactly one** `Coordinator` pane (you). If another
   **active** pane holds it, you are a DUPLICATE — stand down, message that pane, do NOT run a
   second loop.
3. Record the lock in the manifest as **Claude session id + label**. Identifier taxonomy (the one
   place it's defined — everything else references it):
   - **label** (`Coordinator`) = *routing* — what agents address; re-claimable, so NOT authority.
   - **pane number** (`w…-N`) = *ephemeral* — reflows on every restart/split/reap; never trust a
     written pane number; resolve fresh by label+session at read time.
   - **session id** (`agent_session.value` in `herdr pane list`) = *authority* — immutable for
     the session's life. You re-confirm your own session id against the manifest lock line before
     every merge (Phase 3 step 0).

## Phase 0 — readiness (with Ben)

Nothing spawns until the run is ready and Ben approves the manifest.

1. **Agree the run's contents.** Get current state from GitHub (board + epics; source of truth).
   **Verify `main` CI is green** (`gh run list --branch main --limit 1`) — never spawn onto a red
   `main`; it propagates into every agent's gate.
2. **Confirm an approved spec AND a GitHub `task` issue exist for every item**
   (`docs/superpowers/specs/`). Missing/fuzzy spec → help Ben author it
   (`superpowers:brainstorming`, `/brief`); never spawn on an unapproved spec.
   **No issue, no lane — including work Ben authorizes verbally mid-run.** File the issue first;
   a queue row may never read `Issue: —` or `Issue: live feedback`. This is not bookkeeping
   fussiness: the 2026-07-26 repo cleanup deleted nine live-verified commits precisely because the
   lane that produced them had no issue and no PR, so every sweep read it as scratch work. That
   loss is now being rebuilt as issues #1270/#1271. Archived is not triaged.
3. **Build the dependency + collision map — as a one-shot Opus subagent** (pointer-style prompt:
   spec paths + the migration-ordering rule). Two specs collide on a shared module, shared-table
   schema change, or migration ordering (numbers are global, assigned by landing order). Run the
   CLAUDE.md agentmemory recalls (`jarv1s current project state`, plus migration/RLS/AccessContext
   rows as relevant).
4. **Write the run manifest** from the template → `docs/coordination/<run-id>.md`: queue, tiers,
   parallel groups, serialized chains, explicit merge order. Commit it.
5. **Present the manifest to Ben. PAUSE** until he OKs it.

## Phase 1 — spawn

For each spec cleared to start (serialized specs wait for their predecessor to land):

1. **Isolated worktree off `main`** (never share a tree):
   ```bash
   git fetch origin main
   git worktree add .claude/worktrees/<slug> -b <slug> origin/main
   ```
   **Always under `.claude/worktrees/`, never `/tmp`.** A `/tmp` worktree is invisible to anyone
   sweeping the repo, survives the session that made it, and still registers in
   `git worktree list` — the 2026-08-06 sweep found a dozen of them, one still running a dev API
   and one whose orphaned worker chain a lane nearly mistook for something safe to `pkill`.
   Each worktree costs ~2 GB once `pnpm install` runs; the box hit 97% disk.
2. **Write the handoff doc** from `templates/handoff.md` (spec, worktree/branch, tier, coordinator
   label + session id, collision notes) → commit it so the agent can read it.
3. **Spawn the build agent** into the run's shared **"Agents" tab**. `herdr agent start` takes
   **only** `--kind`, `--pane` and `--timeout` — there is no `--cwd` and no `--tab`. The pane must
   already exist, be at a shell prompt, and be in the right directory, so **split first, start
   second**:

   ```bash
   # 1. make the pane, in the worktree — --cwd lives on split, not on agent start
   herdr pane split <agents-tab-pane> --direction down --cwd $(pwd)/.claude/worktrees/<slug> --no-focus
   # 2. start the agent in that pane; everything after `--` goes to claude
   herdr agent start <name> --kind claude --pane <new-pane> \
     -- --model sonnet --permission-mode bypassPermissions "<boot>"
   ```

   Two argument rules, both of which fail loudly and waste a spawn:
   - **`<name>` is lowercase letters/digits/`-`/`_`, 1–32 chars.** `"Batch1 Fix"` is rejected with
     `invalid_agent_name`. The human-readable label is set separately, in step 4.
   - **The boot string must be shell-encodable by herdr.** A multi-line prompt, or one containing
     backticks or quotes, is rejected with `invalid_agent_argument` — that is herdr refusing to
     guess, not a transient error, so don't retry it. Write the full brief to a file and pass a
     one-line pointer: `"Read the file <path>/boot-<slug>.txt in full. It is your task brief.
     Follow it exactly."` Keep the brief **outside the worktree** — an untracked file inside it
     reds that agent's own gate.

   The brief file carries what used to live in the inline prompt:

   > Build `<slug>` in this fresh worktree. STEP 1 `pnpm install`. STEP 2 read your handoff doc
   > `docs/.../<handoff>.md` (it's short — that's the point) and follow the coordinated-build
   > skill. Read the spec/plan by SECTION for your current task only — never in full; full-reads
   > bloat a fresh context and trigger premature relays. Reading is not progress: BUILD, commit per
   > task, relay only after real work past ~80%. Begin now.

   **Tab discipline (Ben, 2026-06-10/27):** ALL build + QA agents share one agents tab, which must
   live in Jarvis workspace `w1`; your coordinator window stays coordinator-only (the ONLY thing
   you may spawn there is your own relay successor). If the agents tab doesn't exist, create it:
   `herdr pane move <first-pane> --new-tab --workspace w1 --label "agents"`. At 4+ panes, open an
   `"agents 2"` overflow tab. Grid: 2×2 for 4-agent waves, 3×1 for 3.
4. **Name the agent both ways (Ben, 2026-08-06)** — a spawned pane is anonymous in *two* separate
   namespaces, and Ben has to be able to tell lanes apart at a glance:
   ```bash
   herdr pane rename <pane> "<PR1437 typecheck fix>"   # the label `herdr pane list` + FleetView show
   herdr pane run <pane> "/rename pr1437-typecheck-fix" # the header shown inside the agent's own pane
   ```
   Setting one leaves the other blank. Name for the **work**, not the wave (`PR1437 typecheck fix`,
   not `build-3`). Record both names in the manifest.
5. **Verify it started AND on the right model:** `herdr pane read <pane> --source recent
   --lines 12` — answer trust prompts with `herdr pane send-keys <pane> Enter`; confirm the pane
   says **"Sonnet"** (Opus = herdr default leaked through — respawn with `--model sonnet`).
6. **Record** label/pane/branch in the manifest; status `building`.

**Messaging agents — preferred path:** `herdr pane run <pane> "<msg>"` (types + submits in one
command), or `herdr agent prompt <name-or-pane> "<msg>"` when the target is a named agent — then
verify with a bounded pane read; if the text is still sitting in the input box, send one
`herdr pane send-keys <pane> Enter`. `send-text` is a fallback only (it leaves text unsubmitted
without an explicit Enter). There is no `herdr agent send`.

## Phase 2 — supervise (resident)

**Push + event-driven watch.** Agents push escalations to your label (those wake you); a Monitor
catches silent failures between pushes.

- **Liveness — prefer a persistent `Monitor` over polling:** a loop that snapshots
  `herdr pane list` every ~60s and emits **only changed lines** (an `agent_status` flip, a pane
  death). A healthy fleet then costs you zero tokens; you read a pane only when the monitor fires.
  **`agent_status` is a hint, not proof.** It has reported `idle` while the pane itself showed
  `Perambulating… 19m` — a false completion that will make you close out a lane mid-thought. Before
  acting on "done", confirm against the **deliverable**: the PR exists, or the file's size is stable
  across two checks a minute apart. Status flips tell you *when to look*, never *what is true*.
  If you must fall back to a `ScheduleWakeup` sweep instead, mind the prompt-cache TTL: tick
  ≤270s (stays cache-warm) or space ticks 20–30 min — a wake between those pays a full cold
  re-read of your context for nothing. **Never block on `herdr pane run <pane> 'sleep N'`
  poll-loops** — `ScheduleWakeup` / `Monitor` / a background task are the only sanctioned waits.
- **On a plan-ready escalation:** read the plan pointer. Approve if it stays inside the spec's
  locked decisions; reply via `herdr-pane-message`. A genuine product/architecture fork → model
  policy (Opus subagent), then route to Ben with the verdict framing the options.
- **On `[SECURITY]`/`[AUTH]`/`[RLS]`/`[CRIT]`:** spawn Opus immediately (model policy) — never
  reason through it inline. Relay the verdict to the agent.
- **On a blocker:** unblock if you can (answer, point at a file/memory). Real design/scope
  question → model policy, then Ben. Manifest: `blocked` + the open question.
- **On a stall — diagnose which of the two kinds it is before you touch it.** They need opposite
  responses and treating them alike wastes a lane:
  - **Frozen mid-turn** (a spinner that hasn't advanced, an API 529, no new output): the session is
    stuck, not thinking. **Nudge it** — `herdr agent prompt <name> "continue"`. These clear on a
    nudge; do not re-spawn, you'd lose the worktree state.
  - **Turn ended on a wait declaration** — the agent wrote something calm and reasonable like "I'll
    wait for the background gate to finish" and *stopped*. Nothing is running. A nudge makes this
    **worse**: it restates the intent and stops again, burning turns. Correct move: `TaskStop` the
    lane, take over the finish line yourself, and **read the diff before you trust it** — the
    #1313 agent stalled this way having left its new fallback path entirely untested. Then re-brief
    the successor with "do not end your turn between steps."
  - Distinguish them by the pane's last line, not by `agent_status`: a wait declaration is prose, a
    freeze is a spinner.
- **On an agent relay** (its meter warned or it saw a compaction summary): it spawns its successor
  in the same worktree and asks to be reaped — confirm the successor is driving (bounded pane
  read), reap the old pane, update the manifest. If YOU spawn the successor, always pass
  `--tab w1:<agents-tab>` and `--model sonnet` — never let it land in your coordinator tab.
- Keep the manifest current after every state change — it is your memory.

## Phase 3 — verify & merge (you own it all)

When an agent reports **done** (PR open + its own green evidence — which you do NOT trust alone):

0. **Session-id authority check (before EVERY merge).** Re-read the manifest lock line; confirm
   your own `agent_session.value` matches the recorded coordinator session id. Mismatch = you are
   not authoritative — **stand down, do not merge**, message the `Coordinator` label.

1. **Spawn an ephemeral QA agent** on the PR branch, passing the risk tier. QA **trusts CI for
   the mechanical gate** (`gh pr checks`) and re-runs nothing unless CI is red — tokens go to
   review only.

   **Primary path — registered subagent** (`.claude/agents/coordinated-qa.md`; the call returns
   the agent's final message as the tool result, so only the verdict enters your context):
   ```
   Agent(
     description: "QA: <slug>",
     subagent_type: "coordinated-qa",
     isolation: "worktree",
     model: "opus",        ← security tier only; omit for routine/sensitive (inherits Sonnet)
     prompt: """
   JARVIS_PGDATABASE=jarvis_qa_<n>
   PR: <PR number> | Branch: <branch> | Spec: <spec-path> | Tier: <routine|sensitive|security>

   Invoke the coordinated-qa skill; its step 3b (live-path gate + e2e-UAT, every tier) and
   step 4 (tier depth) are authoritative.
   Return ONLY the compact verdict as your final message.
   """
   )
   ```
   **Fallback (Herdr):** if the Agent tool is unavailable, `herdr agent start` with the same
   prompt **plus `--model sonnet`** (or opus for security tier), collect the verdict via a bounded
   pane read, and note the fallback in the manifest.

   By tier: `routine`/`sensitive` = Sonnet QA (`/code-review` + exit-criteria, + invariant walk
   and coordinated-qa step-4 e2e-UAT gate for sensitive). `security` = Opus adversarial QA — must
   `gh pr comment` its verdict before you act. Consume the compact verdict only — never the body.

2. **CI waiver protocol (red checks are stop-the-line).** A PR with any red required check does
   NOT merge. Waivable **only** if: (a) proven failing on `origin/main` at the same SHA, (b)
   recorded in the manifest `ci_waivers` (check + SHA + proof), and (c) Ben-approved. A check that
   fails twice = stop-the-line: halt the lane, file a GitHub issue, escalate to Ben.

3. **If RED / not merge-ready:** relay the blocking findings to the owning build agent (re-open
   its lane), or escalate to Ben if it's a design problem. Re-QA after the fix. Failure budget:
   2 failed QA cycles on one lane → stop the lane, escalate.

4. **If GREEN:** apply the merge order. Rebase on `origin/main`; non-trivial conflicts go to the
   **owning agent** (it has the context) — never hand-edit feature code yourself. After rebase,
   **re-verify the integrated result** with a fresh QA agent (diff-scoped against the collision
   map — a clean PR can still break against newly-landed siblings).

5. **Merge — by tier** (re-confirm step 0 still holds). **First check the live-path gate:** if the
   PR touches a user-facing feature, module, or UI surface and carries no live-UI proof comment, it
   does not merge at any tier — send the lane back for a live-path walk. Then, by tier: `security`:
   Ben's explicit sign-off first, never auto-merge. `routine`: auto-merge. `sensitive`: auto-merge +
   digest.
   ```bash
   gh pr merge <PR> --squash --delete-branch
   ```
   Then GitHub bookkeeping (source of truth): close the issue, check epic exit-criteria, move the
   board item to Done, close the milestone if complete (field IDs: `start` skill's GitHub
   reference). Add the merge to Ben's standing digest.

6. **Reap — but prove the work landed first.** Before removing anything, confirm the lane's commits
   are actually on `main` (`git log origin/main --oneline | grep <sha>`, or the merged PR). Only
   then reap the build agent, remove its worktree (`git worktree remove`), and release any
   serialized successor. Manifest: `merged`. **Never delete a branch or worktree whose work you
   have not seen on `main`** — deleting unlanded work is how the 2026-07-26 cleanup lost nine
   live-verified commits.

   **Run the four-gate test per worktree — all four, every time.** They are cheap and they are the
   difference between reclaiming disk and destroying work:

   ```bash
   git -C <wt> rev-list --count origin/main..HEAD          # 0 = fully merged
   git -C <wt> status --porcelain | grep -cv '^??'         # 0 = no tracked modifications
   for p in $(ls /proc | grep -E '^[0-9]+$'); do readlink /proc/$p/cwd 2>/dev/null; done | grep -Fc <wt>
   herdr pane list                                          # no pane cwd'd there
   ```

   Remove only when **all four** are clear. Untracked `node_modules` alone is not work — that is
   what `--force` is for. Untracked *source or docs* is unsaved work: leave it and flag it.
   A non-zero ahead-count does **not** prove unmerged work (a squash-merged branch still shows all
   its commits), so treat ahead > 0 as "keep" rather than investigating.

   **A lane's teardown is not done when its PR is green.** Before you reap it, the lane must also
   have stopped any dev instance it started (**by explicit PID, never a name pattern**) and deleted
   any rows it seeded (by recorded id, verifying the row count). Ask for that confirmation — a lane
   that reports "CI green" has usually left a listener on `:3000` and a worktree behind.

7. **Relay check (non-negotiable).** Increment `merges_since_relay`, then evaluate the **relay
   triggers** (Context discipline): meter warning, security merge, 2 routine/sensitive merges, or
   compaction summary → flush + self-handoff now; the successor closes the loop from the manifest
   continuation note.

## Phase 4 — reap & report

- **Close the panes you opened.** The reap half of pane hygiene is the half that gets skipped —
  Ben has raised it repeatedly. Kill spent panes, prune merged worktrees (only after Phase 3
  step 6's landed-on-`main` check), keep manifest + GitHub consistent (no drift).
- **Report to Ben, in this order:**
  1. **Anything in `docs/coordination/AWAITING-BEN.md`** — lead with it whenever that file is
     non-empty. A decision he hasn't seen blocks more than a status line does. Park pending-Ben
     decisions there as they arise, and clear an entry once he rules and the ruling is recorded
     where the work lives.
  2. What merged (PR links + verified exit codes + live-path proof status).
  3. In flight; blocked (and where tracked).
  Terse and result-first: no recaps, no option surveys, no restating what he just read. Anything
  merged without its live-path proof is reported as **code-complete, unverified** — never "done".
- **Save durable memory** for any non-obvious decision/trap (`memory_save`, `project: "jarv1s"`).

## Coordinator self-handoff (protect the long-lived session)

Fired by the relay triggers (Context discipline / Phase 3 step 7):

1. Flush the manifest fully (every agent's status/pane/branch/PR, merge order, ci_waivers, open
   escalations) + a one-line "mid-doing" continuation note. Commit it.
2. Use **`relay`**: spawn a new coordinator **in the SAME TAB as your own pane** (never the agents
   tab) with unattended full-access permissions:
   - Claude: `claude --model sonnet --permission-mode bypassPermissions`
   - Codex: `codex -s danger-full-access -a never` (never the default/`workspace-write` sandbox —
     it must rename/close panes, push the manifest, and run the gate unprompted)
   Bootstrap = "you are the new coordinator for run <run-id>; read
   `docs/coordination/<run-id>.md` — the LATEST continuation note + the current fleet/merge-order
   state (skim; the manifest is long — do NOT deep-read its full history or you bloat on boot),
   invoke `coordinate`, re-adopt the live fleet (`herdr pane list` + labels), confirm you're
   driving, then close my pane."
3. Confirm the successor is driving (bounded pane read); it reaps you — resolving your pane fresh
   by label + session id, never a written pane number.

## Red flags — STOP

- **Spawning on an unapproved/missing spec**, on a lane with **no GitHub issue**, or before Ben
  approved the manifest.
- **Reaping a lane / deleting a branch or worktree before confirming its work is on `main`.**
- **Trusting `agent_status: idle` as proof a lane finished** — confirm the deliverable.
- **Nudging an agent that ended its turn on a wait declaration** — `TaskStop`, take over, review
  its diff. Nudges only fix frozen mid-turn sessions.
- **Spawning without `--model sonnet`** — herdr's default boots Opus and burns the budget.
- **Reading a raw gate log or full diff in your own context** — delegate; consume the verdict.
- **Merging on a build agent's self-report** — only after independent QA green on the
  *integrated* result.
- **Merging without re-confirming your session id** against the manifest lock (Phase 3 step 0).
- **A build agent touching `docs/coordination/`** (coordinator-only) or running repo-wide
  `pnpm format` / broad `git add` — encode both bans in every handoff doc.
- **A blocking sleep poll-loop** to wait on anything — `ScheduleWakeup`/`Monitor`/background task.
- **Auto-merging a `security`-tier PR** or merging one without Ben's sign-off + posted verdict.
- **Waiving a red CI check** outside the waiver protocol; twice-failing check = stop-the-line.
- **Two agents on one worktree/branch**, or assuming a migration number for a serialized spec.
- **Letting the manifest drift** — a stale manifest breaks your self-handoff.
- **Hand-editing feature code** — task the owning agent; you orchestrate.
- **Continuing past a fired relay trigger** — no "just one more merge"; compaction summary =
  relay immediately, merge nothing.

## Quick reference

| Need | Command / skill |
| ---- | --------------- |
| Manifest / handoff templates | `.claude/skills/coordinate/templates/{manifest,handoff}.md` |
| Isolated worktree | `git worktree add .claude/worktrees/<slug> -b <slug> origin/main` |
| Spawn build agent | `herdr pane split <pane> --direction down --cwd <worktree> --no-focus` → `herdr agent start <lowercase-name> --kind claude --pane <new-pane> -- --model sonnet --permission-mode bypassPermissions "<one-line pointer to a brief file>"` → confirm pane says "Sonnet" |
| Name a lane (both namespaces) | `herdr pane rename <pane> "<Human Label>"` **and** `herdr pane run <pane> "/rename <slug>"` |
| Spawn QA agent | `Agent(description, subagent_type: "coordinated-qa", isolation: "worktree", model: opus for security only, prompt)` |
| Spawn relay coordinator (SAME tab as yours) | `… -- claude --model sonnet --permission-mode bypassPermissions "<boot>"` or `… -- codex -s danger-full-access -a never "<boot>"` |
| Talk to an agent | `herdr pane run <pane> "<msg>"` → bounded read to verify → `send-keys Enter` if unsubmitted |
| Bounded pane read (always) | `herdr pane read <pane> --source recent --lines 12` |
| Liveness | persistent `Monitor` diffing `herdr pane list` (emit changes only); fallback `ScheduleWakeup` ≤270s or 20–30 min |
| Session-id authority (pre-merge) | manifest lock line ↔ your `agent_session.value` (never a pane number) |
| CI gate (don't re-run) | `gh pr checks <PR>` |
| Merge + close | `gh pr merge <PR> --squash --delete-branch` · issue close · board move |
| Live-path gate (any UI-facing PR, any tier) | live-UI proof `gh pr comment` (UAT run + assertions/evidence) present, else do NOT merge |
| Security-tier merge | Opus QA → `gh pr comment` verdict → Ben sign-off → merge |
| Relay triggers | meter 70% warning · security merge · 2 routine/sensitive merges · compaction summary (→ merge nothing) |
| Escalate to Opus | `Agent(model: "opus", prompt: "<pointers: PR #, paths, manifest section>")` |

See also the design spec, `references/incidents.md`, and CLAUDE.md (Hard Invariants, GitHub
tracking, coordinating sessions).
