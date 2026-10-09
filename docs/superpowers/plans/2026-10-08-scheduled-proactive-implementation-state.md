# Scheduled/proactive implementation state

Parent: #3096. Tickets: #3125–#3148. Integration branch: `integration/scheduled-proactive`.
Base: current main `2c81aa484`; documentation-only carry from open PR #3097 at `7b422e3ff`.
Runtime baseline and throwaway prototypes were not merged.

## Current state

- Original native graph verified: 24 open subissues, 28 blocking edges; initial frontier
  #3125, #3129 and #3130. Ticket bodies and graph snapshot are stored outside the repo.
- #3125 is integrated from `9bee2d414`: stable owner Main designation,
  preserved eligible history and cold/warm startup binding. Independent source review
  cleared runtime `50c8f807b`; real configured-model UI proof used that unchanged runtime
  with harness `7f0fa2877`. See [ticket evidence](../handoffs/2026-10-08-3125-evidence.md)
  for actual check inputs, security negative control, live assertions and limits. That proof
  remains valid for its recorded scenarios and is preserved unchanged.
- The subsequent Main reopen/next-turn repair is integrated from `7670bf803`. Independent
  source reviews and fresh scripted plus configured-model installed proof cleared runtime
  and harness `01a014e1c3`, including immediate warm reopen, resume-before-turn ordering,
  Main continuation and caller cancellation. See the [repair supplement](../handoffs/2026-10-08-3125-main-reopen-repair-evidence.md)
  for exact pins, checks, runtime provenance and limits. Chat descendants (#3126, #3127 and
  #3149) are released from this repair hold only after final assembled static, focused
  units and Main-chat DB regressions pass; the coordinator records that verified frontier.
- #3155 is integrated from `8ef212857`; independent source review and scoped installed
  UI/API/worker proof cleared `cd2641479`, using unchanged image runtime `28c43f5ac`.
  See [email-access evidence](../handoffs/2026-10-08-3155-evidence.md) for current account
  filtering, public app-map recovery, negative controls, exact inputs and proof limits.
  The merger returns a verified integration receipt only after assembled static, focused
  unit and email-access DB checks pass; builder receipts do not certify a different tip.
- Unblocked Settings frontier: #3129 and #3130. After the repair's assembled checks pass,
  #3126, #3127 and #3149 rejoin the eligible frontier. Use one builder
  and sequential independent reviews within available capacity; serialize heavy checks.
  All other work remains pending its verified blockers. The coordinator owns dispatch
  and tracker transitions. Draft integration PR [#3154](https://github.com/motioneso/moss/pull/3154)
  is open and remains draft during implementation. Current GitHub CI is not certified;
  the previously observed Meetings CI failure remains pending coordinator disposition.
  Scoped repair verification does not establish branch-wide readiness.
- All four migration decisions approved explicitly in this session. See
  [migration decisions](2026-10-08-scheduled-proactive-migration-decisions.md).
- Read-only exploration completed. [Dispatch seams and ownership](2026-10-08-scheduled-proactive-dispatch-seams.md)
  records session sizing, Settings coordination and native reslices #3149–#3152 under
  #3132/#3137, plus integrated prerequisite #3155 under #3129. #3129 is now unblocked for
  its full saved-choice/Settings outcome. Original downstream blockers are retained.
- Each ticket uses a fresh TDD implementer, isolated worktree/branch from the integration
  tip, required checks and independent review, real UI/worker demonstration, evidence
  and truthful app-map updates. DB checks use `verify-gate`.
- A merger agent integrates verified tickets. The coordinator opens the draft integration PR;
  final two-axis code review and fixes, then ready for Ben. Never auto-merge or deploy.

## Decisions

Approved existing UI/API/worker verification seams remain in the reconciled spec; no renewed
interview or routine-engineering approval.

Main-chat migration approved by Ben: designate the owner's most recently active persistent
drawer conversation once (`last_active_at` descending, ID ascending for ties), retain other
eligible transcripts as side chats, exclude incognito/module/shared foreign conversations,
and create Main only when none qualifies. Later activity never changes Main. Current-source
eligibility: `owner_user_id = actor`, `surface = 'drawer'`, `incognito = false`.
All remaining migration recommendations were then explicitly approved as recorded in the
migration-decisions document. No migration decision is pending.

## Resources

Worktree: `~/Jarv1s-scheduled-integration`. External state/research:
`/tmp/moss-scheduled-implementation/`. No feature server or browser started.
