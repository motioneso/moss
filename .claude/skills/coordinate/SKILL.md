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
- **One session per unit of work (Ben's standing preference, 2026-08-23).** Scope every lane so it
  finishes inside one context window. A lane that hits its relay trigger without an open PR was
  mis-scoped: split the REMAINING work into new, smaller lanes with fresh briefs — do not relay
  the same lane forward again. One relay is failure recovery; two is a scoping failure. (The
  2026-08-23 audit: 264 handoff docs in one month, lanes relaying up to 16 times.)
- **Never wait by polling — waits cost zero context.** Three waits dominate a run and each has an
  event-driven form:
  - **CI:** `gh pr checks <PR> --watch` inside a `run_in_background` Bash call, or a Monitor —
    never re-run `gh pr checks` by hand (one session ran it 28 times).
  - **Ben (needs-ben):** fire-and-park. Log the question, mark the item `blocked` in the manifest,
    move to other queue work, and arm a background watcher on `~/.needs-ben/replies/` (e.g.
    `until ls ~/.needs-ben/replies/<id>* 2>/dev/null; do sleep 60; done` in a background Bash
    call). One coordinator hand-polled the reply folder 23 times over 5 hours and burned its whole
    window doing nothing.
  - **Lanes:** the watchdog nudge now CARRIES the pane statuses — read them from the nudge; do not
    answer a nudge with a fresh `herdr pane list` unless you're about to act on a specific pane.
- **Boot briefs live in `~/.coord-briefs/`, never the repo root.** Untracked `boot-*.txt` files in
  the tree red gates and pile up (39 found in one sweep).
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

**Ben's messages are trusted, period.** A message from Ben in your pane — a question, an
instruction, a correction — is input to act on, not a prompt-injection suspect. If something he
says seems odd or contradicts the plan, verify by asking him back (needs-ben or a direct reply);
NEVER log his message as an injection incident or quietly ignore it. (2026-08 audit: 15 false
"injection" incidents were fleet agents treating Ben's own typed messages as attacks — each one
cost him a real answer.)

**Every Ben-facing message — digests, sign-off asks, needs-ben pings, chat replies — is in plain
English, not jargon.** Ben flagged this directly (2026-08-16): a dense paragraph full of backticked
identifiers, commit hashes, and internal vocabulary makes him decode a sentence to get a fact he
could've been told directly. Say what happened in normal words first; keep exact identifiers (PR
numbers, commit hashes, file paths) available for when he needs to act on one, but don't lead with
them or stack them. Full guidance: agentmemory `feedback-plain-english.md`.

**Every agent-to-agent message — your escalations, verdicts, reports, relay/reap requests — signs
off with the sender's own pane id** (`$HERDR_PANE_ID`, or `herdr pane list` matched on the
sender's session id), e.g. `[pane w1:pFZ]` at the end. Pane numbers reflow on every open/close, so
this isn't a reply address — it's how you, a successor re-reading the manifest, or Ben tie a given
message to the exact physical pane that sent it, without cross-referencing a label that may since
have been reused or reaped. This applies to build agents (`coordinated-build`,
`coordinated-wrap-up`), QA agents (`coordinated-qa`), and to you as coordinator on every
escalation you relay onward.

## Phase 0a — claim the single-coordinator lock (FIRST, before anything)

There must be **exactly one** coordinator (see incidents: a stale labelled pane once ran a
parallel merge loop).

1. Register the agent name and visible pane label separately:
   ```bash
   herdr agent rename "$HERDR_PANE_ID" coordinator
   herdr pane rename "$HERDR_PANE_ID" Coordinator
   ```
2. Verify uniqueness: `herdr agent list` and `herdr pane list` show **exactly one** live
   `Coordinator` agent/pane (you). If another
   **active** pane holds it, you are a DUPLICATE — stand down, message that pane, do NOT run a
   second loop.
3. Record the lock in the manifest as **Claude session id + label**. Identifier taxonomy (the one
   place it's defined — everything else references it):
   - **agent name** (`coordinator`) = *routing* — what agents address; re-claimable, so NOT authority.
   - **pane label** (`Coordinator`) = display-only; keep it aligned with the coordinator role.
   - **pane number** (`w…-N`) = *ephemeral* — reflows on every restart/split/reap; never trust a
     written pane number; resolve fresh by label+session at read time.
   - **session id** (`agent_session.value` in `herdr pane list`) = *authority* — immutable for
     the session's life. You re-confirm your own session id against the manifest lock line before
     every merge (Phase 3 step 0).
4. **Turn on the idle watchdog** — it only runs while a coordinator is actually driving:
   ```bash
   systemctl --user start coordinator-watchdog.timer
   ```
   It nudges the pane labeled `Coordinator` if it goes quiet for 15 minutes. Turning it off again
   is part of `end-coordination`, not this phase — don't stop it yourself mid-run.

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
3. **Spawn the build agent** into the run's shared **"Builders" tab** (QA agents get their own
   **"QA" tab** — see `coordinated-qa`; same rules, just two tabs by role instead of one shared
   tab). `herdr agent start` takes **only** `--kind`, `--pane` and `--timeout` — there is no
   `--cwd` and no `--tab`. The pane must already exist, be at a shell prompt, and be in the right
   directory, so **split first, start second**:

   **⚠️ `herdr pane split` has no `--tab` flag — it always splits inside the SOURCE pane's own
   tab.** `<builders-tab-pane>` below MUST already be a pane that lives in the Builders tab
   (`herdr pane list`, check `tab_id`) — never your own coordinator pane, and never the QA tab.
   Splitting off yourself silently lands the new pane in your coordinator tab (Ben, 2026-08-19:
   caught this happening — a build agent spawned straight into the Coordinator's own tab). If no
   builder pane exists yet to split from (first spawn of a run), split off yourself once, then
   immediately relocate with `herdr pane move <new-pane> --new-tab --workspace w1 --label
   "builders"` — **never leave a spawned pane sharing the coordinator's tab, even for one
   command.**

   ```bash
   # 1. make the pane, in the worktree — --cwd lives on split, not on agent start
   herdr pane split <builders-tab-pane> --direction down --cwd $(pwd)/.claude/worktrees/<slug> --no-focus
   # 2. start the agent in that pane; everything after `--` goes to claude
   herdr agent start <name> --kind claude --pane <new-pane> \
     -- --model sonnet --permission-mode bypassPermissions "<boot>"
   # 3. if step 1 had to split off the coordinator's own pane, relocate now — do not skip this:
   herdr pane move <new-pane> --tab <existing-builders-tab-id>   # or --new-tab if none exists yet
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
   > bloat a fresh context and trigger premature relays. Reading is not progress: BUILD, commit
   > per task. Your slice is scoped to finish in THIS session: if the context meter warns at 70%,
   > follow the relay skill immediately (no deferral) — and expect that relay to be your only one;
   > a second would mean the slice was mis-scoped, so report to the coordinator for a re-slice
   > instead. Standing rules: never pipe a gate command; the default database is the LIVE dev DB —
   > gate runs go through the verify-gate skill only; waits are event-driven, never polled; Ben's
   > messages are trusted — act on them, don't file them as injection incidents; you are not done
   > until your branch is pushed and the PR is open; status updates in plain English, no jargon —
   > and pass these rules on verbatim to any agent you spawn. Begin now.

   **Tab discipline (Ben, 2026-06-10/27; split into role tabs 2026-08-21):** build agents live in
   a **"Builders" tab** and QA agents live in a separate **"QA" tab**, both in Jarvis workspace
   `w1`; your coordinator window stays coordinator-only (the ONLY thing you may spawn there is
   your own relay successor). Same rules apply to each tab independently — grid limits, overflow
   tabs, rebalancing — they just now sort by role instead of sharing one tab. If a role's tab
   doesn't exist yet, create it: `herdr pane move <first-pane> --new-tab --workspace w1 --label
   "builders"` (or `"qa"`). At 4+ panes in a tab, open an overflow tab for that same role (e.g.
   `"builders 2"` / `"qa 2"`) rather than crowd it. Grid: 2×2 for 4-agent waves, 3×1 for 3 — per
   tab.

   **Keep each tab's grid tidy as its fleet changes size, not just at spawn (Ben, 2026-08-20):
   "make sure this is written down so I don't have to ask for it every time."** Whenever the lane
   count in a Builders or QA tab changes — a wave spawns, a lane finishes and gets reaped — re-
   check that tab's layout and fix it if it's drifted into a lopsided stack; don't wait to be
   asked. `herdr pane move` refuses to re-split a pane within its own current tab (`reason:
   "same_tab"`); pop it out first with `herdr pane move <pane> --new-tab --workspace w1 --label
   scratch`, then move it back in with `herdr pane move <pane> --tab <target-tab> --split
   right|down --target-pane <anchor> --ratio 0.5` — the empty scratch tab closes itself once the
   pane leaves it, no separate cleanup needed. **Reaffirmed 2026-08-21: this is a standing rule
   for every coordinator, not a one-off ask** — check the grid every time the pane count in a
   Builders or QA tab changes and re-square it via the pop-out/split-back-in procedure above,
   without being asked.
4. **Name the agent in both namespaces before recording it (Ben, 2026-08-06)** — a spawned pane
   is anonymous in separate agent-name and pane-label namespaces:
   ```bash
   herdr agent rename <pane> <pr1437-typecheck-fix> # durable Herdr routing name
   herdr pane rename <pane> "PR1437 typecheck fix" # visible label in pane list/FleetView
   ```
   `herdr agent start <name>` sets the routing name at spawn, so rename immediately only when the
   start path did not set it. Name for the **work**, not the wave (`pr1437-typecheck-fix`, not
   `build-3`). Record both names in the manifest. The coordinator is the exception: every
   coordinator and coordinator successor must use the registered agent name `coordinator` and
   visible pane label `Coordinator`.
5. **Verify it started AND on the right model:** `herdr pane read <pane> --source recent
   --lines 12` — answer trust prompts with `herdr pane send-keys <pane> Enter`; confirm the pane
   says **"Sonnet"** (Opus = herdr default leaked through — respawn with `--model sonnet`).
6. **Record** label/pane/branch in the manifest; status `building`.

**Messaging agents — preferred path, and confirmation is MANDATORY, not conditional.** Every send
is a two-step action: send, then verify. A message you have not verified is not sent — treat it as
still pending, not delivered. This applies to you as coordinator and is the standard you hold
every agent you brief to as well.

1. Send: `herdr agent prompt <agent-name> "<msg>"` for named agents (the normal path), or
   `herdr pane run <pane> "<msg>"` only for an unnamed/raw terminal target.
2. **Always** verify with a bounded agent read (`herdr agent read <agent-name>
   --source recent-unwrapped --lines 12`), or a bounded pane read for raw targets — do this every
   time, not only when you suspect a problem. Read the actual result:
   - Input box empty, or your text now appears as agent output/history → delivered.
   - Your text still sitting at the prompt with a cursor → **not sent**. For raw targets, send one
     `herdr pane send-keys <pane> Enter`, then read again to confirm it cleared.
   - `❯ Press up to edit queued messages` → delivered and queued (the agent was busy); this is
     success, do not resend.
3. If step 2's second read still shows unsubmitted text, do not retry blindly — the pane may be in
   a state that doesn't accept plain Enter (a trust prompt, a different focused control). Read a
   couple more lines of context before trying again.

`send-text` is a fallback only (it leaves text unsubmitted without an explicit Enter) — never use
it as the whole send. There is no `herdr agent send`. **Never assume a message landed because the
command that sent it returned without error** — `agent prompt`/`herdr pane run` succeeding only means
the keystrokes were delivered to the terminal, not that the target processed them.

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
- **QA verdicts: `Monitor` is fine, an in-process `Agent`-tool QA agent is not.** A `Monitor`
  polling `gh pr comment`s runs as a detached background task and doesn't block you. A QA agent
  spawned via the `Agent` tool runs in-process and ties up whichever session spawned it until it
  finishes — spawn QA in its own Herdr pane instead (see Phase 3 step 1).
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
- **A dispatched `Agent()` QA/build agent that pauses on its own background work is the same failure,
  one level removed.** You get exactly one task-notification when it pauses like that — its own
  background task's completion does NOT generate a second notification. **Whenever a spawned agent's
  update is a wait declaration rather than a finished verdict, immediately schedule an active recheck**
  (`ScheduleWakeup` a few minutes out, or a bounded `SendMessage` nudge) — do not assume a second
  notification is coming.
- **On an agent relay** (its meter warned or it saw a compaction summary): it spawns its successor
  in the same worktree and asks to be reaped — confirm the successor is driving (bounded pane
  read), reap the old pane, update the manifest. If YOU spawn the successor, always pass
  `--tab w1:<agents-tab>` and `--model sonnet` — never let it land in your coordinator tab.
  Build/QA successors get a unique registered role name (`<slug>-relay<n>`). A coordinator
  successor must transition from a temporary unique name to `coordinator`: start it as
  `coordinator-next-<run>`, verify it is driving, clear the old coordinator's name, then run
  `herdr agent rename <successor-pane> coordinator` and align its pane label. Never leave two
  live agents named `coordinator`.
- Keep the manifest current after every state change — it is your memory.

## Phase 3 — verify & merge (you own it all)

When an agent reports **done** (PR open + its own green evidence — which you do NOT trust alone):

0. **Session-id authority check (before EVERY merge).** Re-read the manifest lock line; confirm
   your own `agent_session.value` matches the recorded coordinator session id. Mismatch = you are
   not authoritative — **stand down, do not merge**, message the `Coordinator` label.

1. **Spawn an ephemeral QA agent in its own Herdr pane** on the PR branch, passing the risk tier —
   never via the `Agent` tool (that runs in-process and ties up the coordinator session until it
   finishes). QA trusts CI for the mechanical gate (`gh pr checks`) and re-runs nothing unless CI
   is red — tokens go to review only.

   Spawn: `herdr pane split <agents-tab-pane> --direction down --cwd <fresh-qa-worktree>
   --no-focus` → `herdr agent start <name> --kind claude --pane <new-pane> -- --model sonnet
   --permission-mode bypassPermissions "<boot pointer>"` (`--model opus` for security tier). Boot
   the pane with:
   ```
   PR: <PR number> | Branch: <branch> | Spec: <spec-path> | Tier: <routine|sensitive|security>
   Invoke the coordinated-qa skill; its step 3b (live-path gate + e2e-UAT, every tier) and
   step 4 (tier depth) are authoritative. Post your verdict to the PR with `gh pr comment` when
   done.
   ```
   Confirm the pane says "Sonnet" (or "Opus" for security tier). Don't wait on it — check the PR's
   comments on your next pass. By tier: `routine`/`sensitive` = Sonnet QA (`/code-review` +
   exit-criteria, + invariant walk and coordinated-qa step-4 e2e-UAT gate for sensitive).
   `security` = Opus adversarial QA — must `gh pr comment` its verdict before you act.

   **Reap the QA worktree and pane the moment you've consumed its verdict** — do not wait for
   Phase 3 step 6. A QA worktree holds no work of its own (it never edits source, only reviews):
   `git worktree remove --force <qa-wt>`, delete its branch if any, close the pane. No four-gate
   check needed — that check is for build-agent worktrees which do carry unlanded work.

2. **CI waiver protocol (red checks are stop-the-line).** A PR with any red required check does
   NOT merge. Waivable **only** if: (a) proven failing on `origin/main` at the same SHA, (b)
   recorded in the manifest `ci_waivers` (check + SHA + proof), and (c) Ben-approved. A check that
   fails twice = stop-the-line: halt the lane, file a GitHub issue, escalate to Ben.

3. **If RED / not merge-ready:** relay the blocking findings to the owning build agent (re-open
   its lane), or escalate to Ben if it's a design problem. Then:
   - **The fix claim must be verifiable in one look.** The build agent's "fixed" report must cite
     the fix commit SHA and the exact file:line per finding. No citation = not fixed, send it back
     without spawning QA. (Audit 2026-08-23: a false "fixed" claim doubled a QA cycle; uncited
     claims force QA to re-review everything.)
   - **Re-QA incrementally.** Round N+1 reuses round N's QA worktree, fetches the new commits, and
     reviews only `git diff <round-N-SHA>..<new-SHA>` plus re-running the checks that were red.
     Never a fresh agent + fresh checkout + fresh install + full re-review for a small fix (one
     night burned 10+ full rounds on three small PRs this way). A full fresh review is warranted
     only if the branch was force-pushed or the diff touches files round N never reviewed.
   - **Failure budget — hard cap.** 2 red QA rounds on one lane → STOP. No round 3. Adjudicate:
     spawn one fresh Opus/Codex arbiter scoped to only the disputed findings, or put the question
     to Ben. Rounds 3-6 are agents arguing with each other at full re-review prices.

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
   Once the `CI gate` required-status-check ruleset (#895) is applied to `main`, `--auto` is safe
   to add here for `routine`/`sensitive` tiers — GitHub then holds the merge until the required
   check resolves instead of merging immediately. Until the ruleset lands, do not add it: with no
   required check configured, `--auto` would merge without waiting on anything. `security` tier is
   unaffected either way — Ben's explicit sign-off stays a separate, non-bypassable gate.

   Then GitHub bookkeeping (source of truth): close the issue, check epic exit-criteria, move the
   board item to Done, close the milestone if complete (field IDs: `start` skill's GitHub
   reference). Add the merge to Ben's standing digest.

6. **Reap — but prove the work landed first.** Before removing anything, confirm the lane's commits
   are actually on `main` (`git log origin/main --oneline | grep <sha>`, or the merged PR). Only
   then reap the build agent, remove its worktree (`git worktree remove`), and release any
   serialized successor. Manifest: `merged`. **Never delete a branch or worktree whose work you
   have not seen on `main`** — deleting unlanded work is how the 2026-07-26 cleanup lost nine
   live-verified commits.

   **Run the reap check per worktree — every time:**

   ```bash
   scripts/worktree-reapable.sh <wt>    # exit 0 = safe to remove; non-zero prints exactly why
   ```

   It runs all four gates (fully merged; no tracked modifications; no process cwd'd inside; no
   Herdr pane cwd'd inside) and prints a per-gate verdict — record its one-line output in the
   manifest so a successor can tell a passed check from a skipped one. Never hand-type the gates
   from memory (the /proc scan was the most-skipped step in the merge path). Untracked
   `node_modules` alone is not work — that is what `--force` is for. Untracked *source or docs* is
   unsaved work: the script flags it; leave the tree and escalate. A non-zero ahead-count does
   **not** prove unmerged work (a squash-merged branch still shows all its commits), so the script
   treats ahead > 0 as "keep".

   **A lane's teardown is not done when its PR is green.** Before you reap it, the lane must also
   have stopped any dev instance it started (**by explicit PID, never a name pattern**) and deleted
   any rows it seeded (by recorded id, verifying the row count). Ask for that confirmation — a lane
   that reports "CI green" has usually left a listener on `:3000` and a worktree behind.

   **Do this reap in the same pass as the merge — never "later."** A build agent's own report
   already tells you it's reapable (`coordinated-wrap-up` ends every report with "worktree
   reapable"); once step 6's four gates are clear, remove it right then, not on some future sweep.
   "Later" is how 48 worktrees piled up across one overnight run: relays and successors each
   inherited the queue but not the backlog of already-mergeable-but-unreaped trees, because nothing
   forced the reap to happen inside the merge step itself. If a relay is imminent (Context
   discipline), the manifest continuation note must explicitly list any worktree that passed its
   four-gate check but wasn't yet removed — an unreaped-but-safe worktree is state, and state that
   isn't in the manifest doesn't survive the handoff.

7. **Relay check (non-negotiable).** Increment `merges_since_relay`, then evaluate the **relay
   triggers** (Context discipline): meter warning, security merge, 2 routine/sensitive merges, or
   compaction summary → flush + self-handoff now; the successor closes the loop from the manifest
   continuation note.

## Phase 4 — reap & report

- **Close the panes you opened.** The reap half of pane hygiene is the half that gets skipped —
  Ben has raised it repeatedly. Kill spent panes, prune merged worktrees (only after Phase 3
  step 6's landed-on-`main` check), keep manifest + GitHub consistent (no drift).
- **Pane teardown is accountable.** BEFORE closing any pane, record in the manifest: what that
  agent was doing, and where its work landed (branch/PR link, or "no output — <why>"). A closed
  pane with no manifest line is unaccounted work; Ben once had to interrogate a coordinator over
  eight silently-closed panes to find out what happened to their lanes. One line per pane, written
  before the kill, not reconstructed after.
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

**When the whole run is done — the queue is empty, nothing is left building, and you are not
about to relay** — use `end-coordination` to close the run out fully, including turning the idle
watchdog back off. Phase 4 above is what you do after every merge; `end-coordination` is what you
do once, at the very end.

## Coordinator self-handoff (protect the long-lived session)

Fired by the relay triggers (Context discipline / Phase 3 step 7):

1. Flush the manifest fully (every agent's status/pane/branch/PR, merge order, ci_waivers, open
   escalations) + a one-line "mid-doing" continuation note. Commit it.
2. Use **`relay`**: spawn a new coordinator **in the SAME TAB as your own pane** (never the agents
   tab) with unattended full-access permissions:
   - Claude: `claude --model sonnet --permission-mode bypassPermissions`
   - Codex: `codex -s danger-full-access -a never` (never the default/`workspace-write` sandbox —
     it must rename/close panes, push the manifest, and run the gate unprompted)
   Start the successor with a temporary unique agent name such as
   `coordinator-next-<run>` because the current `coordinator` name is still occupied. Bootstrap =
   "you are the new coordinator for run <run-id>; read
   `docs/coordination/<run-id>.md` — the LATEST continuation note + the current fleet/merge-order
   state (skim; the manifest is long — do NOT deep-read its full history or you bloat on boot),
   invoke `coordinate`, re-adopt the live fleet (`herdr pane list` + labels), confirm you're
   driving, then close my pane."
3. Confirm the successor is driving (bounded pane read). Clear this session's registered name,
   then have the successor run `herdr agent rename "$HERDR_PANE_ID" coordinator` and
   `herdr pane rename "$HERDR_PANE_ID" Coordinator`; it reaps you after that. Resolve panes fresh
   by agent name + session id, never a written pane number.

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
| Name a lane (both namespaces) | `herdr agent rename <pane> <lowercase-work-name>` **and** `herdr pane rename <pane> "<Human Label>"` |
| Name a coordinator | `herdr agent rename "$HERDR_PANE_ID" coordinator` **and** `herdr pane rename "$HERDR_PANE_ID" Coordinator` |
| Spawn QA agent | Herdr pane, same as a build agent (never the `Agent` tool) — `--model sonnet`, opus for security tier |
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
