# Scheduled/proactive implementation state

Parent: #3096. Tickets: #3125–#3148. Integration branch: `integration/scheduled-proactive`.
Base: current main `2c81aa484`; documentation-only carry from open PR #3097 at `7b422e3ff`.
Runtime baseline and throwaway prototypes were not merged.

## Current state

- Native tracker graph verified: 24 open subissues, 28 blocking edges; initial frontier
  #3125, #3129 and #3130. Ticket bodies and graph snapshot are stored outside the repo.
- Start #3125 before expanding concurrent implementation. Fresh implementer dispatch next.
- All four migration decisions approved explicitly in this session. See
  [migration decisions](2026-10-08-scheduled-proactive-migration-decisions.md).
- Read-only exploration is revalidating migration/Settings seams and session fit for
  #3127, #3128, #3132, #3137 and #3142 before dispatch.
- Each ticket uses a fresh TDD implementer, isolated worktree/branch from the integration
  tip, required checks and independent review, real UI/worker demonstration, evidence
  and truthful app-map updates. DB checks use `verify-gate`.
- A merger agent integrates verified tickets. Draft integration PR after first integration;
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
