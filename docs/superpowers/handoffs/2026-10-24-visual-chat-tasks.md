# Visual chat: read-only Tasks summary, then the remaining roadmap

Assignment: [#3659](https://github.com/motioneso/moss/issues/3659), part of #3583.
Weather #3648 merged as `d42c7b82688824d20ae00baf4d1f7b5fed4efb04`, closing #3639
(Done on project 2). [Final verification receipt](https://github.com/motioneso/moss/pull/3648#issuecomment-6387193574).
Worktree: `~/Jarv1s/.claude/worktrees/visual-chat-tasks`; branch `feat/visual-chat-tasks`.
This committed handoff must be included in the Tasks product PR.

## Authority and scope

Ben authorized the sequential visual-chat chain: implement one bounded approved slice,
obtain independent Standards and Spec review, fix findings, verify, gated squash merge,
then launch and verify its fresh successor. Routine implementation decisions need no
new approval. Genuine acceptance failures retain the decision gate below.

Later authority clarification from Ben (2026-10-24): “can we not fix them?” and
“yea no such thing as blockers if they can be fixed.” Fixable acceptance failures
are work to diagnose, repair, independently review and verify autonomously under
the existing gated merge/next authorization. Do not require another approval for
each repair. Retain failed attempts and require every unchanged gate before rollout.
This supersedes repeated decision holds for fixable failures in the original gate
below; it does not waive any acceptance requirement.
[Recorded decision](https://github.com/motioneso/moss/issues/3583#issuecomment-6388175847).

Deliver a read-only Tasks summary answering ordinary questions such as “What needs
doing today?” from actor-authorized data. Show stable task identity, title, actual
due/overdue and completion state, optional supported priority, actor time zone,
source time and honest coverage. Keep reminders as an explicit remaining follow-on;
this slice does not complete the combined Tasks/reminders family or the catalog.
No completion checkbox, action, navigation control, writer or new subscription.

## Start

1. Run `pnpm install --frozen-lockfile` first. Stay in the isolated worktree and
   branch named above. Other agents work in this repository; accommodate their edits. Set session title and durable routing name to `visual-chat-tasks`.
2. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md` and
   `.claude/skills/plan-build/SKILL.md` in full. Read the full approved visual-chat
   spec and staged plan below, the target board and runtime evaluation. Apply the
   repository design-system skill before UI work and verify-gate before DB/full tests.
3. Search Hindsight and check remembered decisions against current graph/source.
   Check fresh main, open PRs and live #3583 for overlap. Create or verify a task-type
   issue on project 2 and set it In progress. Keep the umbrella open and its unsupported
   provider/lifecycle acceptance unchecked. Check Weather's actual decision and receipts.
4. Prove the actor-scoped read and public visual seams; commit/push a bounded task-linked
   plan before production code. Name read-only semantics, due-date/time-zone behavior,
   completion/recurrence/coverage limits, model/host ownership and installed acceptance.
5. Include this inherited handoff and the committed implementation plan in the product PR.
   Implement this slice, maintain the app map, then obtain independent exact-head
   Standards and Spec reviews, fix all actionable findings and repeat affected checks.
6. Verify exact-head full local gate through the documented detached waiter, fresh CI
   including browsers and real installed acceptance. Record all failures and final proof
   on the PR, fill Release note, and squash merge with `--match-head-commit` only when
   every required gate passes. Use no admin override or branch deletion.
7. Verify landing and tracking, then apply herdr-handoff: commit/push the next handoff
   on its fresh base, launch a fresh isolated named unattended session, and verify it
   actually executes Start. Record durable name plus immutable session ID. A document
   alone does not finish this assignment.

## Weather evidence to carry forward

Weather's passing installed receipt is
https://github.com/motioneso/moss/pull/3648#issuecomment-6385973546.
It covers discovered Codex economy `gpt-6-luna`, 20/20 exact-source cards and
manually useful complete replies, four prose controls, novel composition, Sports
preservation, immutable reload, drawer/390px and themes. Later documentation-only
heads reuse that evidence with explicit scope and independent review. Both independent reviewers approved
exact final head `bf7948a2f067e12638d9fedcd6347073b013becc` with zero blocking findings.
Its full isolated local gate and authoritative detached waiter exited 0: 1,569 unit files /
18,664 tests passed / three skipped; 14 seed files / 35 tests passed; 394 integration files
passed / one skipped / 4,093 tests passed / three skipped. Fresh exact-head CI passed
19 checks with three intentional skips, including both browser shards. The gate database
and owned mail fixture were removed and their ports released. The final receipt above
records the exact identity and completed checks.

Keep run 9's actual saved-unit/invented-sample failures and run 10's 1/20 visual
failure disclosed. Run 10's cause remains unresolved. Run 11's history records actual
Weather reads and presentations, but its private Codex scan captured zero JSONLs.
Ben explicitly approved the combined unchanged gated continuation after disclosure:
https://github.com/motioneso/moss/pull/3648#issuecomment-6386051514.
This decision preserves every gate and failed attempt; it does not change source,
renderer, model-selection, prompts, thresholds or release scope. The broader
provider/side-chat/deletion matrix remains open on #3583.

## Source and ownership traps

- `TasksRepository.listFiltered` currently invokes `rollForwardOwnedSeries` before
  reading. It mutates recurrence and cannot be described as a strictly read-only source.
  Preserve this existing consumer behavior; design an explicit module-owned public
  read seam for this slice and prove it performs no writes or reconciliation.
- `listOwnedReadCandidates` currently returns only id/title, is owned-only and bounded
  at 100. It cannot prove due/status/priority or visible shared-task coverage. Establish
  actual ownership/sharing and bounded query semantics through the existing access layer.
- Report persisted recurrence state truthfully. Distinguish date-only due dates from
  timestamp instants and use actor-local day boundaries. Source coverage and truncation
  belong to the module; an empty bounded result is not proof of an empty whole account.
- The host/modules own identities, numbers, source/status/timestamps and fallback. The
  model chooses presentation and writes concise grounded interpretation. Use current-turn
  snapshots and immutable saved envelopes; history performs no source read.
- Use public module contracts and lazy module-owned cards, with general primitives in
  `packages/ui`. Core chat gets no Tasks-specific imports or module-name branches.

## Required evidence and decision gate

Deterministic tests must distinguish owner/shared/denied access, due/today/overdue/completed,
no-date, local-day/DST boundaries, recurrence persisted-state semantics, empty/partial/
truncated coverage, no writes, malformed/forged snapshots, and source-grounded fallback.
Prove any new claimed boundary with the prescribed negative control. Preserve Weather,
Sports, user-data composition, lifecycle/thread isolation and text-only destinations.

Installed acceptance uses real signup/sign-in, real Tasks UI to create known fixtures,
the discovered configured economy model and actual authorized reads. Fix twenty ordinary
prompts before the run, require at least 19/20 first-attempt intended visuals and useful
text in all twenty, and retain every failed attempt. Manually assess every full answer, including due/status/time-zone semantics and explicit source timestamps. Freeze the candidate before installed acceptance; record receipts externally so evidence updates alone do not force repeated product runs.
No intercepted/faked app responses. Include prose controls, a novel composition, prior
domain preservation, immutable reload, drawer/390px and themes. Measure latency, output,
available usage and controlled bundle delta with explicit limits on token-cost claims.

If actual runtime, coverage, engine reliability or data/action acceptance fails, post a
measured recommendation on #3583 and obtain Ben's actual decision before dependent
rollout. Continue independent work where possible. The renderer, prompts, 19/20 threshold
and useful-text requirement cannot be silently waived or a retry relabeled first attempt.

## Continuation and references

After this verified merge, select a bounded remaining read-only slice from reminders,
planning, money, comparisons and recommendations using current seams and overlap. Then
deliver conversational choices/sliders with explicit Apply and registered navigation,
existing action integration with host-authored outcomes, and full eight-family acceptance.
Each slice repeats independent review/fix/verify/merge/verified fresh successor. Stop only
when all approved evidence is complete or a genuine recorded Ben decision blocks rollout.

Read `docs/superpowers/specs/2026-10-23-visual-chat-replies.md`,
`docs/superpowers/plans/2026-10-23-visual-chat-replies.md`,
`docs/superpowers/specs/visual-chat-replies/targets.html`,
`docs/research/2026-10-23-visual-chat-runtime-evaluation.md`, and
`docs/agents/herdr-pane-message.md`. Weather's handoff/plan and final PR receipt preserve
its failed runs and bounded configured-engine evidence. Use `~/Jarv1s` in documents,
claim dev ports through devports, clean owned resources and leave a clean committed tree.
