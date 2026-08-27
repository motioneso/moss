# Coordination / messaging / QA audit — 2026-08-23

Grounded on working tree at commit 54e9d9876 (branch coord-1834-relay11-handoff). The freshness
preflight fails only because this coordination branch is behind main; the skill files audited here
are NEWER than main's copies and are the live versions sessions load, so the working tree is the
right ground. Evidence: all 12 project skills + the 2 global Herdr skills, plus ~235 session
transcripts from 2026-08-16 through 2026-08-23, mined by four parallel agents with bounded reads.

## Headline

The fleet's biggest cost is not building or reviewing — it is the supervision machinery itself.
Roughly summarized: the coordinator role restarted 18-35 times per run (run 1834: 18+ successors;
run 1739: 30 handoff files; Aug 16-17 alone: ~35 restarts across two numbering schemes), one
session compacted 29 times, and 264 handoff docs were written in August. Each restart re-reads the
same multi-page briefing (found verbatim ~41 times in one two-day slice). The relay ritual now
consumes more context than it saves.

## Findings, ranked by cost

### 1. Coordinator relay treadmill (highest cost)
- Run 1834: at least 18 successive coordinators. Run 1739: 27+ handoffs overnight, files up to
  relay30. Aug 16-17: takes 4-48 plus relays 2-14 in parallel.
- Each handoff: write boot file, rewrite continuation note, successor re-reads everything,
  re-verifies locks, renames panes, reaps predecessor. 39 stray boot files sit untracked in the
  repo root right now.
- The box rule "split the task if you'd compact more than once" is violated by design: the
  coordinator can't split, so it relays forever.
- Root cause of the burn (Aug 22-23 evidence): the 300s watchdog nudge fired 242 times in two
  days, and each nudge triggers a full pane-status re-poll (5-27 identical pane-list commands per
  session). Ben already asked for 15 minutes ("that one, set it to 15 minutes permanently") — not
  yet made permanent.

### 2. Waiting is done by hand, against the standing rule
- One coordinator polled the needs-ben reply folder 23 times over ~5 hours, burned its whole
  window waiting, then relayed (session 46ddc119).
- 214 manual CI-status checks in the Aug 16-17 slice; single sessions checked the same PR up to 28
  times. Foreground sleeps everywhere (sleep 5 x99, sleep 60 x80 in one slice).
- The rule "waits are event-driven" exists; no coordinator followed it for needs-ben or CI.

### 3. QA re-review from zero after every small fix
- Night of Aug 23: PR 1878 rounds 3-6, PR 1880 rounds 2-5, PR 1877 rounds 2-3 — 10+ full fresh
  checkout + install + review cycles in ~2.5 hours for three small PRs.
- No incremental path: round N+1 never diffs against round N's reviewed commit or reuses the
  worktree.
- Verdict quality issues both directions: one RED verdict issued without running the 4 required
  browser tests (flipped GREEN on re-check); one "fixed" claim from a build lane that QA proved
  was not fixed. "Fixed" claims don't have to cite the commit/line, so QA re-reviews everything.
- Aug 18-19: rounds 4-6 referenced repeatedly; a plan review went 4 straight red rounds before
  anyone escalated.

### 4. Messaging between agents is fragile (worst in Aug 16-17, improved since)
- Messages are typed into terminal panes and silently fail to send. Ben personally intervened at
  least 4 times ("your renames werent going through. I hit enter on them"; "did you get my approve
  for whatever?").
- The known failure ("text left sitting in the input box") is papered over with a warning that
  appeared 116 times in one slice instead of being fixed with delivery confirmation.
- The mandatory verify-the-send step in the global herdr-pane-message skill uses a read form
  (`--source visible`) that a user-level hook denies — the step agents must never skip is the step
  that gets blocked. herdr-handoff has the same problem, never passes `--model sonnet` (so relays
  boot on the expensive model by default), and never sets the durable routing name that
  coordinated-build requires before it will send anything.
- The coordinator relay window leaves ZERO agents named "coordinator"; coordinated-build tells
  lanes to halt in that case and also to never halt. Deadlock by rule.

### 5. Trust and safety noise
- Aug 16-17: agents repeatedly treated Ben's own messages as prompt-injection attacks — 15 false
  "security incidents" logged, real approvals ignored, each logged incident feeding the next
  agent's paranoia until Ben broke the loop manually ("Knock it off"). Ben asked for those
  incident logs to be scrubbed; verify that happened.
- Two genuine injection-looking payloads WERE caught and refused in coordinator transcripts
  (Aug 18-19) — vigilance is warranted, but the trusted-channel question (Ben's messages are
  trusted, period) needs to be written down.

### 6. First-time traps tax every new agent
- 15 different agents each tripped the "don't pipe the verification gate" hook exactly once.
  Nobody trips it twice; every new spawn pays once because briefs don't carry the warning.
- One agent nearly ran the full gate against the live dev database believing it was throwaway;
  Ben had to intervene.

### 7. Skill-file drift and contradictions (full detail from the skills review)
- verify-gate — the skill CLAUDE.md makes mandatory — teaches a hand-rolled procedure that
  coordinated-wrap-up explicitly bans, and never mentions scripts/run-gate.sh or how to wait for
  completion (the hole behind the 19-hour dead-gate incident).
- Relay trigger contradiction: coordinate's boot brief says relay "after real work past ~80%";
  relay and coordinated-build say 70% at first warning.
- The registered coordinated-qa agent definition is stale vs the skill: it applies the live
  end-to-end check only to "sensitive tier" — an agent following its own system prompt skips the
  live-path gate on routine PRs.
- start names superpowers:writing-plans as the planning skill; plan-build exists specifically to
  override it (with a six-round incident on record). start also says `git checkout -b` in the
  shared tree, which the rest of the family treats as unsafe.
- coordinated-wrap-up declares the worktree reapable BEFORE QA runs, so red findings go back to a
  lane that may already be reaped; teardown is ordered after the report that asserts teardown
  happened.
- The live-path rule is copied in six places (already drifted in step numbering); the gate recipe
  exists in four variants; the four-gate reap check is duplicated with one copy quietly weakened.
- No skill covers: coordinator death (watchdog only nudges a pane that exists), a crashed build
  pane, QA reporting to a reaped lane, dev-instance contention (several lanes hitting one live
  database, no owner for :3000), or any relay-depth / elapsed-time budget (branches reached
  relay11 with no rule firing).
- relay has no depth cap or counter; nothing surfaces "this lane has relayed N times with no PR".
- audit-grounding tells auditors to make a /tmp worktree — banned by coordinate after a real
  incident — and never says to clean it up.
- Housekeeping: no skill owns run-end cleanup; Ben asked for one ("We should maybe create a skill
  for end of runs to do good clean housekeeping"). The 39 stray files in repo root are the symptom.

### 8. Cross-lane environment interference
- Disk filled (100 GB of stale Docker images) and stalled the whole fleet.
- One lane silently recreated the shared dev admin login overnight, breaking login for others.
- A coordinator closed 8 panes including a mid-QA one with no record of what each was doing; Ben
  had to interrogate it to reconstruct.

## Recommended fixes, in order of leverage

1. **Move the coordinator's waiting loop into code.** The watch-CI / watch-panes / watch-replies
   loop belongs in a script or daemon (the box rules already say so); spawn short model sessions
   only when a decision is needed. This attacks findings 1 and 2 at the root. Interim quick wins:
   set the watchdog to 15 minutes permanently (Ben already ruled), make the nudge carry the pane
   status so the coordinator doesn't re-poll, and make needs-ben fire-and-park with a file watcher.
2. **Fix the two global Herdr skills** (herdr-pane-message, herdr-handoff): verify reads use
   `--source recent --lines N`, spawns pass `--model sonnet`, naming step includes
   `herdr agent rename`, drop the stale bootstrap example. A few line edits that repair messaging
   and cost policy fleet-wide. Add a delivery-confirmation step that actually passes the hook.
3. **Incremental QA re-checks + a round cap.** Round N+1 diffs against round N's commit in the
   same worktree; build lanes must cite commit + file:line for every "fixed" claim; after 2 red
   rounds, adjudicate (third party or Ben) instead of rounds 3-6.
4. **One gate procedure.** Rewrite verify-gate as a thin wrapper around scripts/run-gate.sh; make
   wrap-up, coordinated-wrap-up, coordinated-qa and start invoke it instead of restating it.
5. **Define the lane lifecycle.** A lane owns its branch until merge or explicit re-assignment;
   teardown before the report; a coordinator-relay blackout rule (retry window, then park) so
   lanes stop hitting the halt/never-halt deadlock; relay-depth budget (e.g. 3 relays without a PR
   forces rescope); pane teardown requires recording where each closed agent's work landed.
6. **Turn skipped checks into artifacts.** Manifest columns for model-confirmed, live-path proof,
   teardown, relay count; replace the hand-typed four-gate reap check with a script that exits 0/1.
7. **Standing brief additions** (one paragraph in every spawn brief): never pipe the gate; the
   gate DB is the LIVE dev database; waits are event-driven; Ben's messages are trusted; push on
   green — a lane isn't done until its branch is pushed and the PR is open.
8. **Housekeeping skill for run end** (Ben requested): boot/QA briefs live in ~/.coord-briefs, not
   repo root; end-coordination gets a "park the run" path so an unanswered question doesn't force
   a resident coordinator to idle forever.
9. **Align the coordinated-qa agent definition with the skill** (live check on every tier) and
   point start at plan-build. Small edits, real safety holes.

## Evidence pointers
- Worst sessions: 11cf8264 (29 compactions), 26201b49 (15 compactions, 9.8MB), 46ddc119 (5-hour
  needs-ben poll), c1b72fb7 (8-pane closure), 13481d2f (injection paranoia).
- Repo: 39 untracked boot-*.txt files; docs/superpowers/handoffs has 264 August docs, lanes with
  5-16 relays (worst: 1533 chat-surface x16, 1754 build-agent-runner x9).
