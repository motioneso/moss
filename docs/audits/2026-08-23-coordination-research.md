# How others run fleets of coding agents — research companion to the 2026-08-23 coordination audit

Three research agents surveyed industry practice, open-source tools, and published evidence
(2025-2026 sources). This file holds the synthesis; the three full reports follow. Written in
plain English on purpose.

## The one-paragraph verdict

Everyone who made this work converged on the same shape, and it is the shape our audit pointed
at: one durable brain that holds all state, farming out small bounded tasks to fresh, disposable
workers that report back and end. What fails, everywhere, is what we had been doing: long-lived
worker sessions handing off to successors (context leaks at every hop; the largest failure study
found lost-context-at-handoff is the single biggest failure class), open-ended review loops
(evidence says value stops after 2-3 rounds), and a model session doing mechanical waiting and
routing (pure token burn; every healthy tool moved that into a plain program). Our design on
paper is right; the gap is that the mechanical parts still live in a model.

## Ranked recommendations (deduplicated across all three reports)

Already done in PR #1887: relay budget of one, QA round cap of 2, incremental QA rounds,
fixed-claims must cite the fix, Ben's messages marked trusted, event-driven waits.

1. **Coordinator daemon.** All three reports, unanimously: waiting, health checks, dispatching,
   and routing belong in a plain program that only wakes a model for judgment calls. Anthropic's
   Agent SDK is the sanctioned way; Gas Town (17.7k stars) is the working proof. This attacks
   our single largest token sink. Our own box rule already says this; the daemon just does not
   exist yet.
2. **Structured task state with generated human views.** No healthy project hand-edits a
   markdown manifest — agents mis-edit prose and two writers corrupt it. Task records as
   git-tracked structured data (like Gas Town's issue records, or Vibe Kanban's database), each
   agent updating only its own record's status; the human-readable summary is generated.
3. **Brief quality is the coordinator's highest-leverage job.** Anthropic found the whole system
   lives or dies on how precisely each task brief states objective, done-criteria, output format,
   and boundaries. Matches our own memory note that agents verify only what the brief names.
4. **Escalate-and-stop for blocked agents.** A blocked agent writes a ticket with severity and
   exits, instead of idling under a watchdog. Generalizes our needs-ben script to every blockage.
5. **Cap concurrent lanes at 3-5; phase the rest.** Beyond that the coordinator drowns in
   tracking. Cost reality check: a three-worker team burns roughly 3-4x the tokens of doing the
   work sequentially, so parallelism must be buying real wall-clock time.
6. **Dispatch policy: fleet gets well-specified work only.** Docs/maintenance PRs get accepted
   82% vs 66% for open-ended features (study of 7,156 agent PRs). Ambiguous design work stays
   with Ben plus one agent.
7. **Mechanical checks before any model review; cross-model for what remains.** Lint, typecheck,
   gate run before a QA model spawns. Measured on ~1,500 real bugs: models find more bugs in
   another model's code than their own; two models agreed on only 28% of findings.
8. **Restart over rescue.** When a lane goes sideways, delete the worktree and redispatch with a
   better brief rather than coaching the same session.
9. **Mini merge queue.** When several PRs are green at once, test them merged together before
   landing serially, so the third does not break on the first two.

## Confirmations of decisions already made

- Ben's one-session-per-unit-of-work ruling (2026-08-23) is exactly the industry consensus:
  workers are stateless and disposable; a needed handoff means the task was sized wrong.
- The injection false-positives on Ben's own messages are a documented failure class (models
  cannot tell operator words from data without help); the fix — declaring operator input trusted
  in the brief — is the recommended pattern.
- Worktree-per-lane, PR-based merges, and the idle watchdog are all industry standard. Keep.
- Skip list: swarm frameworks (Claude Flow), generic agent frameworks (LangGraph/CrewAI/AutoGen),
  commercial dashboards.

---

# Report 1 — industry practice (research-industry)

[Full text as delivered, 2026-08-23]

1. One brain holds state; workers are throwaway and narrow. Cognition (makers of Devin) wrote
the famous "Don't Build Multi-Agents" post in June 2025 arguing parallel agents lose shared
context and make conflicting decisions. Ten months later the author updated his view: the
multi-agent setups that actually work all share one shape - a single main loop that carries all
the state, plus stateless workers with a narrow scope who report back and disappear. Long-lived
worker sessions that carry their own history are the anti-pattern.
Source: https://cognition.com/blog/dont-build-multi-agents and
https://x.com/walden_yan/status/2047054554433462360

2. The coordinator's job is delegation quality, not supervision. Anthropic's research-system
team found the whole design lives or dies on how precisely the lead agent writes each task:
objective, output format, tool guidance, and clear boundaries. Vague briefs made workers
duplicate each other's searches and leave gaps. They spent weeks rewriting delegation prompts;
that was the highest-leverage work. Workers never talk to each other - all routing lives in one
place. Source: https://www.anthropic.com/engineering/built-multi-agent-research-system

3. Mechanical coordination belongs in ordinary code, not in a model. Google's agent toolkit and
Addy Osmani's orchestration writeups both draw the same line: use plain deterministic code for
sequencing, loops, retries, and routing, and spend model calls only where a judgment is needed.
Every message a coordinator agent routes by hand is a paid model round trip; a coordinator that
polls or waits is pure token burn. Also: every loop needs a hard iteration cap or a stuck agent
runs forever. Source: https://addyosmani.com/agents/18-orchestrators/

4. Size every task to finish in one context window, and restart rather than salvage.
Anthropic's own Claude Code best practices are built on one constraint: performance degrades as
the window fills. Their guidance is small focused briefs, frequent checkpoints, and killing a
bad run to restart fresh instead of nursing it along. Multiple practitioner guides say the same
about parallel fleets: plan first, split by ownership boundary so no two agents touch the same
files, one worktree per agent, one PR per task.
Source: https://code.claude.com/docs/en/best-practices

5. Review is the real bottleneck, and everyone hit it. Cognition cites a Faros AI study of
10,000+ developers: high-AI-adoption teams merged 98% more PRs, but review time per PR rose 91%
and PR size grew 154% - and overall delivery didn't improve. Independent reviews of Factory.ai
say the same: an agent can open more PRs than a team can carefully read, and the danger is
plausible code with wrong error handling or tests that assert the implementation rather than
the requirement. Vendor fixes all push one way: smaller, ordered, independently checkable
changes (Devin's stacked PRs) plus an AI first-pass review before a human looks.
Sources: https://cognition.com/blog/devin-review and https://devin.ai/blog/introducing-pr-stacks

6. Keep teams small; go wider by phasing, not by adding workers. Community experience with
Claude Code agent teams converges on 3-5 workers as the sweet spot. Beyond that the lead's
context fills with tracking chatter and every broadcast hits every worker's window. If work
needs more hands, run phases: a team of three, wrap up, then another team of three. Costs are
real: a three-worker team burns roughly 3-4x the tokens of doing the work sequentially, and
Anthropic's research setup ran about 15x a normal chat.
Sources: https://code.claude.com/docs/en/agent-teams and
https://claudefa.st/blog/guide/agents/agent-teams-best-practices

7. Agents do best on well-specified maintenance work; task type dominates outcome. An academic
study of 7,156 agent PRs found documentation tasks were accepted 82% of the time versus 66% for
new features. Factory.ai reviewers conclude the tool pays off for teams with a backlog of
bounded, well-described work, and is weak at ambiguity and unstated tradeoffs. Feed the fleet
the well-specified stuff; keep judgment-heavy design with a human plus one agent.
Sources: https://arxiv.org/html/2602.08915v2 and
https://hyperdev.matsuoka.com/p/factory-ai-codedroid-promising-concept

8. Write down what keeps recurring, as reusable instructions. OpenAI runs hundreds of internal
"skills" so teams can hand Codex routine jobs (running evals, drafting docs, watching training
runs) without re-explaining. Anthropic's advice is the same: start conversational, notice which
requests repeat, then automate exactly those. Repo-level instruction files everyone maintains
together are the shared memory that keeps a fleet consistent.
Sources: https://openai.com/index/introducing-the-codex-app/ and
https://claude.com/blog/subagents-in-claude-code

What we already do: worktree per lane, one PR per task, CI merges; a single coordinator holding
state; independent QA agents; handoff docs and a run manifest; skills and repo instruction files.

What we don't, ranked: (1) mechanical routing in plain code; (2) kill relays - one task, one
session; (3) invest in brief quality; (4) cap concurrent lanes at 3-5, phase the rest; (5) bias
the fleet toward well-specified backlog work; (6) prefer restart over rescue.

# Report 2 — failure modes and economics (research-failures)

A) Findings mapped to our observed failures

1. Our failures are the documented norm. The largest study of failed multi-agent runs (1,600+
traces across 7 frameworks, NeurIPS 2025) sorted failures into bad system design, agents talking
past each other, and weak verification. Lost context at handoffs was the biggest bucket (~37%),
including "loss of conversation history, reverting to an earlier state" - exactly ours. Most
failures come from how the system is organized, not from the model being dumb.
https://arxiv.org/abs/2503.13657

2. Handoffs lose information like a game of telephone, and it compounds. Anthropic: teams with
separate plan/build/review agents "suffered lost context at each handoff and spent more tokens
coordinating than executing." At 95% retention per hop, ten hops keep ~60%. Our 264 handoff docs
a month and 18-35 coordinator restarts per run are this at scale.
https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them

3. Coding is specifically called out as a bad fit for wide parallelism - changes to one codebase
depend on each other, unlike independent research questions.
https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent

4. The token bill matches ours: ~15x a chat for Anthropic's research fleet; controlled coding
experiments find ~3x a single agent for the same quality - the extra is coordination.
https://medium.com/@jainashish.079/single-agent-vs-multi-agent-coding-a-controlled-experiment-with-real-metrics-b8c4027e410f

5. Review loops past 2-5 rounds are oscillation, not thoroughness: without ground truth, models
defend wrong answers and "fixes" start damaging correct code while confidence rises.
https://agentpatterns.ai/code-review/agent-self-review-loop/ and
https://arxiv.org/html/2510.16062v1

6. Flagging the operator's messages as injection is a known false-positive class - models can't
tell trusted operator words from data; generic detectors misfire on developer content because it
is full of imperative language.
https://medium.com/@cbchhaya/making-prompt-injection-harder-against-ai-coding-agents-f4719c083a5c

7. Long contexts degrade before they overflow; a coordinator run to exhaustion is impaired
before it restarts. Errors compound: 95% per-step reliability over 20 steps is ~36% end to end.
https://arize.com/blog/context-management-in-agent-harnesses/

8. Adding a delegation layer can make things worse: one study found inserting a routing agent
dropped win rate from 81.5% to 63%.
https://github.com/mareurs/codescout/blob/master/docs/research/multi-agent-context-loss.md

B) Countermeasures by evidence strength

Strong: hard caps on review rounds (2-3) then ship with remaining issues listed; mechanical
checks before model review; cross-model review (each model finds more real bugs in the other's
code; only 28% overlap in findings - https://www.greptile.com/blog/model-inversion); one main
loop carries state, helpers stateless/narrow/disposable.

Moderate: state in files not transcripts; keep noise (verbose test output) out of context;
per-run budget caps and circuit breakers; mark the operator-trust boundary structurally
(https://www.vectra.ai/topics/prompt-injection).

Weak/mixed: arbiter models (self-preference bias - helps mainly as a different model with a
binding one-shot ruling, https://arxiv.org/pdf/2410.21819); full debate/voting schemes.

C) Are we overcomplicating? Probably, in one specific way: the winning shape is a hub with short
spokes. What fails is what our audit describes - a coordinator that itself runs out of memory,
peer-to-peer handoffs, open-ended review dialogues. Our box rules already prescribe the right
shape; the gap is enforcement, not design.

# Report 3 — tools and frameworks (research-frameworks)

Most relevant tools:
1. Gas Town (github.com/steveyegge/gastown, ~17.7k stars, active): closest to our setup but the
mechanical parts are a plain Go daemon; task state is structured data checked into git; blocked
workers file an escalation ticket and stop; merging is a queue that batch-tests branches and
bisects out the bad one. Author's warning: token-hungry at 20-30 agents ($100/hour reports).
2. Vibe Kanban (github.com/BloopAI/vibe-kanban, ~27.9k stars, sunsetting): kanban card = task;
dragging dispatches an agent into a worktree; board generated from a database, never hand-edited.
3. Claude Code agent teams (code.claude.com/docs/en/agent-teams): under-used shared task list -
agents claim/complete tasks by state change, no coordinator relaying.
4. Claude Agent SDK: the sanctioned way to build a coordinator daemon (a program owns the loop,
invokes a model only for judgment). Caveat: a program-driven session can spawn only ordinary
subagents, not interactive teammates.
5. Microsoft Conductor (github.com/microsoft/conductor, ~400 stars, Microsoft-backed, active):
orchestration loop deliberately contains no model at all; YAML workflows. Early but the stance
is the point.
6. Claude Squad (github.com/smtg-ai/claude-squad, ~8.4k stars): manual version of what we built;
confirms worktree-per-lane is the standard answer.
7. OpenHands (github.com/All-Hands-AI/OpenHands, ~84.9k stars): append-only event log makes runs
replayable and crashed agents resumable; sub-agents get minimum context, never the parent's full
history.
8. Claude Flow (~69k stars): swarm framing; widely regarded as over-engineered for one repo. Skim,
don't adopt.
9. Aider architect mode: one stealable idea - split planner model from cheap editor model.

Recurring design decisions: (A) orchestration loop is code, model only judges; (B) shared state
is structured data with generated human views; (C) agents claim tasks and signal state, nobody
polls; (D) one agent = one task = one context window, enforced by task size at dispatch.

Copy, in order: (1) coordinator daemon; (2) structured task records + generated summary;
(3) escalate-and-stop for blocked agents; (4) mini merge queue. Keep: worktrees, PR merges,
watchdog, one-session rule. Skip: swarm and generic agent frameworks, commercial dashboards.

Sources: see per-item links above, plus
https://re-cinq.com/blog/multi-agent-orchestration-bmad-claude-flow-gastown
https://www.augmentcode.com/tools/open-source-agent-orchestrators
https://www.mindstudio.ai/blog/claude-code-agent-teams-shared-task-list
https://arxiv.org/pdf/2606.00953 (task-partitioning research)
