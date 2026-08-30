# Code with Claude 2026 - notes review for our fleet

Date: 2026-08-23. Grounded on github.com/PiLastDigit/Code-With-Claude as of today
(51 stars, last updated 2026-08-23). The repo holds full machine transcripts of all 19
talks from Anthropic's "Code with Claude" event in San Francisco, each with an
AI-generated summary block. We read all 19 (four in skim mode after checking their
summaries). Written in plain English on purpose; exact names appear only where
someone would act on them.

## Verdict

Worth the time it took to mine it, and the mining is now done - Ben does not need to
read the transcripts himself. The big win is not one new trick; it is that several
large shops (GitHub, Datadog, Replit, Cursor, Bun) independently converged on the
same design we already run, and each has one or two refinements we lack. The eight
findings below are the refinements worth acting on.

## Top findings we should act on

1. **Check that our repeated prompts are actually being cached.** (GitHub talk, and
   the Claude Platform talk.) Cached input is 90 percent cheaper and does not count
   against rate limits. GitHub treats a cache hit rate below the mid-90s as a bug.
   The killer detail: anything that changes per run (IDs, dates, task JSON) placed
   early in a prompt silently ruins caching for everything after it. Our daemon's
   one-shot judgment calls and spawn prompts likely put the task record first.
   Change: shared instruction text goes first and stays byte-identical; per-task
   content goes last. Then look at the usage dashboard and confirm the hit rate.

2. **Require a test that fails on old code and passes on the branch, for bug
   fixes.** (Bun live-coding talk.) Their bot cannot open a PR without that
   before/after proof, which makes review mechanical. We should add it as a required
   artifact in bug-fix task records, alongside the live-path proof we already
   require.

3. **Cheap model builds, expensive model advises.** (Keynote, GitHub, and the
   Platform talk all pushed this.) Run routine build lanes on a cheaper model with an
   explicit "when stuck on a design decision, make one call to the big model" escape
   hatch. One customer claims near-frontier quality at a fifth of the cost. Related
   dial from the "thinking lever" talk: effort levels - verification and QA never run
   below high effort (low effort provably makes the model cut corners), but quick
   daemon-side judgments can be a big model on low effort, which beats a small model
   trying hard.

4. **Give every task record a done-rubric the QA agent grades against.** (Keynote,
   Managed Agents, and Asana talks.) Instead of prose acceptance criteria that QA
   rediscovers, the task carries a numbered plain-English checklist ("open the page,
   log in, click the toggle, expect X") and QA scores each step pass/fail. Replit's
   grader works exactly this way and knows nothing about the implementation. This
   also matches our existing memory note that briefs must carry the gate.

5. **Mine our own transcripts for lessons on a schedule ("dreaming").** (Keynote and
   the memory talk.) An out-of-band batch job reads recent lane transcripts and task
   records, finds repeated mistakes across agents that no single agent could see,
   dedups and stales-out old memory, and writes lessons down. We save memory ad hoc;
   the delta is a scheduled job plus Replit's trick of clustering failure summaries
   semantically (grep misses patterns because agent failures never look textually
   alike). At our scale one big-model call over the pile of recent failure notes
   would do.

6. **Add a one-line "report what was broken or confusing" duty to every spawn
   brief.** (Cursor talk - their strongest idea.) Every agent that hits broken
   tooling, a missing permission, or a misleading instruction files that in its final
   report instead of grinding through; the coordinator routes those into memory or
   issues. A cheap standing self-improvement loop we do not run today.

7. **Enforce role limits in machinery, not prose.** (Datadog talk.) Their rule
   tables say which agent role may perform which state transition, checked in code.
   We already saw a build lane merge its own PR because the limit lived only in the
   brief. Where possible, move "QA cannot edit, build cannot merge" into tool
   allowlists, branch protection, and daemon-side checks on task-state transitions.

8. **On every model upgrade, subtract instead of add.** (Capability curve talk,
   Vercel fireside, and the toolkit talk.) Scaffolding built to compensate for model
   weaknesses - retry loops, over-detailed brief rules, conservative relay caps - has
   a half-life of months. Keep a small eval set built from our own past task records
   (including a few known stalls), rerun it on each model bump, and delete rules and
   caps the new model no longer needs. Vercel deleted an entire correction pipeline
   this way.

## Smaller items worth a look

- New Claude Code feature to trial on one lane: auto mode, where a classifier
  approves safe tool calls and blocks destructive-looking ones. Could kill the class
  of stall where a headless agent sits on a permission prompt. (What's-new talk.)
- A "babysit this PR to green" standing task (watch CI, fix review comments and
  flakes, fix flake root causes) could replace several relay hops per PR. (Keynote.)
- A repro-first lane for bug issues: a small agent turns the issue into a failing
  test plus environment notes before any build agent spawns. Better briefs for free.
  (Bun talk.)
- Measure survival: how much of a merged diff still exists 30 days later beats
  counting merged PRs as the fleet health metric. (GitHub talk.)
- Flag lanes whose token spend or wall time is an outlier for their task size - an
  early warning before the relay cap trips. (Replit talk.)
- Give agents a scratch area and a wrap-up rule that promotes reusable scripts and
  deletes the rest. The pile of boot-*.txt files at our repo root is exactly the
  failure Datadog described. (Datadog talk.)
- Settle design forks by spawning two build agents with competing approaches and
  comparing real diffs, instead of a long planning discussion. (AI-native org talk.)
- Give agents a start/wait-until-ready/make-test-user script set so they stop
  reinventing sleep loops - directly cuts the polling waste our context rules target.
  (Cursor talk.)
- Split memory into a read-only rulings store agents cite but never edit, and a
  scratch store they write freely; only consolidation touches the stable set. Record
  which session wrote each entry. (Memory talk.)
- Compaction is not only a failure sign: deliberately compacting to a smaller
  working context can be cheaper, faster, and smarter for long single-thread runs.
  Nuance to our "scope to one window" rule, not a replacement. (Platform talk.)
- QA driving a real browser is now first-class: native-resolution screenshots with
  exact click coordinates, and a Claude Code session can drive Chrome directly.
  Relevant to the live-path gate. (Toolkit talk.)

## Things we already do (confirmed coverage)

Commander daemon with disposable single-context agents; briefs carrying the
verification gate; live end-to-end proof before merge; spawn budgets and relay caps;
worktree isolation; file-based memory the model manages itself (the memory talk says
Anthropic's own managed memory converged on exactly this shape); "verification is
the bottleneck, invest there"; long-lived loops in code not sessions; correcting the
same agent mistake twice means it goes in the project instructions; keeping the
human for genuinely ambiguous tradeoffs only. Nothing in the 19 talks contradicts
our current design.

## The companion repo

The README points at a second repo, TRIP-workflow, billed as the distilled essence.
It is a three-command solo-developer workflow (plan, implement, release). Nothing in
it for a multi-agent fleet; skip it.

## Talks with nothing for us

Talk 2 (Dario and Daniela fireside - company vision) and talk 15 (Google Cloud
integration walkthrough). Talks 6 and 12 are about Anthropic-hosted Managed Agents,
which is the rented version of what we run ourselves; only their rubric-grading and
memory ideas transfer, captured above.
