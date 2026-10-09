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
  for exact pins, checks, runtime provenance and limits. The repair's final clean assembled
  tip `8fecaacae` passed full static, 258 focused units and 184 Main/chat DB regressions,
  all exit 0. #3126, #3156 and #3149 are released from that repair hold; the coordinator
  owns dispatch and records the verified frontier.
- #3155 is integrated from `8ef212857`; independent source review and scoped installed
  UI/API/worker proof cleared `cd2641479`, using unchanged image runtime `28c43f5ac`.
  See [email-access evidence](../handoffs/2026-10-08-3155-evidence.md) for current account
  filtering, public app-map recovery, negative controls, exact inputs and proof limits.
  Its final clean assembled verification passed full static, focused units and scoped
  email-access DB checks, all exit 0; builder receipts were not reused for another tip.
- #3129 is integrated from clean pushed `8dc523ece`: saved automatic-email choice,
  Alerts shell/delivery controls and source gates. Both source review axes cleared
  `bf2ad6f72`. Installed capture-off UI/API/worker proof used `fa397bcb5`; production
  runtime and UAT harness bytes remain identical through the fixture/evidence-only delta.
  See [email-choice evidence](../handoffs/2026-10-08-3129-evidence.md). Live Retry proves
  account-list recovery; grant-query Retry and useful selected delivery are not live-proven.
  Final assembled static, exact six-file units and four-file email-access DB checks are
  recorded at the merger's final commit/fingerprint; earlier receipts do not certify it.
- #3158 is integrated from clean pushed `1cad56d41`: existing Profile local notification
  defer/release and proactive quiet-end parity share a local cutoff conversion, with DST and
  UTC+14 coverage. Both independent source review axes cleared `184dfd458`. Installed
  capture-off Profile/API/worker proof used that source and harness with rebuilt image
  `sha256:a5c48383302192807318eed928c16e9dddc99ebb3f7317e7041c5133edf595e0`.
  See [quiet-window evidence](../handoffs/2026-10-08-3158-evidence.md) for exact commands,
  source pins, overnight save/reload, pre-cutoff absence, one released notification and the
  summary job's no-device completion. The briefing writer was a scripted third-party fixture;
  no real-model reply, physical device receipt or live DST transition is certified. Runtime and
  harness bytes are unchanged through the evidence-only delta. Assembled full static, the exact
  three-file 101-test unit bundle and both `test:notifications`/`test:proactive-email-access`
  DB gates have separate merger receipts at their recorded integration pin/fingerprint;
  builder receipts certify only their original inputs.
- The #3130 source-fit audit at `04bcabc42d` found the original full builder too large for one
  complete session and introduced #3158. After that prerequisite's integration, #3130 remains a
  full canonical migration/editor/writer/CAS/undo/conflict-preservation builder whose remaining
  scope must be rechecked before dispatch; #3131 still waits for #3130. Settings shell and
  email/delivery ownership transferred by #3129 remains reserved for #3130. See
  [the prerequisite plan](2026-10-08-quiet-hours-delivery-prerequisite.md).
- #3126, #3156 and #3149 are eligible after the verified repair; #3157 waits for #3156. #3127 is a scope container until both children pass its
  full acceptance; #3128 remains blocked by #3127. Use one builder
  and sequential independent reviews within available capacity; serialize heavy checks.
  All other work remains pending its verified blockers. The coordinator owns dispatch
  and tracker transitions. Draft integration PR [#3154](https://github.com/motioneso/moss/pull/3154)
  is open and remains draft during implementation. Current GitHub CI is not certified;
  the previously observed assistant-name Meetings chat CI failure was repaired in the two affected
  fixtures, with source reviews and scoped local evidence recorded in
  [the fixture repair evidence](../handoffs/2026-10-08-ci-fixture-repair-evidence.md). That evidence
  does not establish branch-wide CI readiness. At integration `46b2bad82`, run `37883965859`
  failed the Tasks quick-add browser assertion (one request expected while saving, two observed);
  the other 230 browser tests passed and one was skipped. This failure has not been locally
  reproduced or classified as preexisting/flaky. Its fresh regression-fix builder follows #3158
  integration; current CI readiness remains uncertified.
- All four migration decisions approved explicitly in this session. See
  [migration decisions](2026-10-08-scheduled-proactive-migration-decisions.md).
- Read-only exploration completed. [Dispatch seams and ownership](2026-10-08-scheduled-proactive-dispatch-seams.md)
  records session sizing, explicit shared Settings shell/Alerts/client/query/app-map/manifest
  and personal-pane ownership transfer from #3129 to #3130, and native reslices #3149–#3152
  under #3132/#3137, #3156→#3157 under #3127, and #3158→#3130. #3155, #3129 and #3158 are integrated and verified
  within their recorded source/live/assembled limits. Original downstream blockers are retained;
  #3130 is not a scope container. The current 32-node/39-edge graph is acyclic.
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
