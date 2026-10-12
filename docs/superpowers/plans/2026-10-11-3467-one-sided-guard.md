# One-sided messages do not create commitments (#3467)

Status: original guard and outcome read approved. Rebased on integration/scheduled-proactive at 7ffd41835. Settlement and confirmation exclusion approved as c52672bbb and implemented; live GreenMail proof posted on PR #3472. See the PR for final gate and CI results.
Branch: scheduled/3467-one-sided-guard. Base: integration/scheduled-proactive.
Worktree: ~/Jarv1s/.claude/worktrees/sched-3467-one-sided-guard.
Part of #3467 and #3465. The parent issue correction and investigation govern this slice.

## Verified seams and scope

- packages/commitments/src/email-judgement-worker.ts:93 reads owner-labelled thread messages, but currently permits inbound-only notices to reach model generation and candidate persistence at line 175.
- packages/email/src/thread-provider.ts:24 derives fromIsUser from the owner's known addresses, independently of model output. Its IMAP fallback at line 45 returns a single cached message.
- packages/email/src/repository.ts:530 reads owner-filtered thread records in chronological order with a bounded limit. Missing owner messages must fail closed for new extraction.
- packages/module-registry/src/index.ts:3078 registers the older extraction worker with chat and notes providers only. No email provider is registered. Those providers currently return no boundaries (packages/chat/src/commitment-provider.ts:4 and packages/notes/src/commitment-provider.ts:4).
- packages/commitments/src/workers.ts:116 is the sole production caller of extractCommitmentsFromText. The text-only API lacks sender/owner evidence. It must not be an alternate email promotion path.
- packages/commitments/src/manifest.ts:107 owns email judgement behavior metadata.
- tests/unit/commitment-email-judgement-worker.test.ts:30 supplies recording collaborators; tests/unit/commitment-extractor.test.ts:4 covers the older text extractor.
- tests/uat/specs/1452-briefing-live-content.uat.spec.ts:19 demonstrates real model briefing generation and Today rendering. Disposable install recipe: ~/.config/moss-proof/README.md; never reuse that running instance.

No migration, source exclusion setting, chat handler, task Settings, or notification changes. Do not edit the parallel briefing builder's owned files. Existing owner-created tasks and accepted commitments remain independent briefing inputs; this change does not delete or relabel them.

## One phase

1. Add regression tests first: inbound-only pharmacy notices cannot persist a candidate even when the supplied model would answer owed:true. Known contacts, unrelated notes, unrelated tasks, multiple inbound messages, missing context and IMAP singleton records cannot substitute for owner participation. A thread with an owner message and a newer inbound request still uses the existing model judgement and saves its candidate. Existing owner-backed records remain untouched.
2. Before model generation, record no_item and return for a thread with no owner-authored message. Presence of unrelated task/context records never opens the guard. Owner-backed tasks and commitments remain actionable through their own records; do not create a second inferred email commitment merely because a task exists. Empty/newest-owner/already-judged handling remains compatible. Update ordinary worker fixtures to represent a two-sided thread.
3. Make extractCommitmentsFromText return no candidates for sourceKind email: text alone cannot establish owner participation. Test this independently of prompt wording, while retaining chat/notes extraction behavior. The caller audit found no active legacy email provider, so no registry changes are needed.
4. Update the Commitments manifest feature description to explain the rule and record the caller audit here. No public signatures change.
5. Add tests/uat/specs/3467-one-sided-guard.uat.spec.ts and blocking trigger rows for changed commitment runtime files. Use synthetic fixtures through actual storage on an own disposable install, real Claude CLI economy model, and real UI. Exercise thread judgement, verify no notice candidate is saved, retain one accepted owner-backed commitment, generate a briefing and inspect Today. Assert record identities and structural outcomes rather than exact model prose. No intercepted responses. Report code-complete, unverified if proof cannot be produced.

Determinism boundary: code decides whether email has owner participation and may enter extraction; model jobs remain (1) judge eligible threads and (2) compose the briefing from eligible records. This slice introduces no new model-authored user-data contract or automatic task creation. It does not establish the parent issue's full prose-validation guarantee.

Verification commands (unpiped; expected exit 0): pnpm test:unit tests/unit/commitment-email-judgement-worker.test.ts tests/unit/commitment-extractor.test.ts; pnpm format:check; pnpm lint; pnpm typecheck; scripts/run-gate.sh start and scripts/run-gate.sh wait --follow. Read CI after opening the PR against integration/scheduled-proactive.

Live proof: claim a devports port as sched-3467; build with JARVIS_IMAGE_TAG=uat-sched-3467; seed only synthetic records; post outcome and bounded evidence as a PR comment. Stop owned processes and release the port. Never copy the host Claude refresh token.

Kill gate: if the real briefing presents an inbound-only notice as a must-do despite no saved candidate, stop and report that remaining writer route to the coordinator. Changes in the parallel builder's files require coordinator approval. Coordinator owns the decision to expand or reslice.

## Rulings and live state

Coordinator approved the conservative guard. A colleague question triaged as needs_reply must still reach the briefing after a no_item judgement. A question missed by triage is outside this slice. QA showed the original fixture was inaccurate: both triage paths discarded needs_reply when handing mail to judgement. The gate and sorting path now preserve that category only. The composer regression consumes real applyGate output and a source snippet. No-item retention passes; item deduplication remains red until settlement is updated.

Observed red: four new guard regressions failed before the implementation. Observed green: 23 scoped worker/extractor/composer tests pass. The first full gate and disposable build failed because the new app-map description exceeded 240 characters; shortened it and restarted verification. Fast format, lint and typecheck passed before the final proof assertions were strengthened.

The final proof uses an isolated GreenMail server, following the existing #2709 UAT pattern. Four synthetic messages are delivered over SMTP: an inbound-only pharmacy notice, an owner promise and incoming reply with References headers, and a colleague question. The real mailbox connector and refresh route perform IMAP sync, triage and queued judgement. No email cache or judgement result is seeded. The fixture separately creates an owner-backed commitment as the briefing positive control, accepted by the coordinator.

Known limit: IMAP supplies each message as its own one-message thread. IMAP mail therefore never shows owner participation and never creates an inferred commitment. Grouped two-sided judgement is covered by unit tests. IMAP threading follow-up: #3470. Colleague questions labelled needs_reply must remain eligible after no_item, while item outcomes must suppress the duplicate email signal. The first fixture did not prove that production interaction; QA identified the missing category.

Live proof and full gate remain pending. Draft PR #3472 is open and the runtime branch is pushed against the unchanged integration base 99b83b531. DNS failures delayed publishing and CLI installation; failed publishing retries are spaced at least five minutes apart. The first GreenMail sync reached partial because email extraction requires an explicit model binding; the proof now configures that service through the real admin API with the discovered economy model. Keep the PR draft until real-mail proof is posted.

## QA correction and sequencing

The coordinator approved exposing the existing stored item/no_item outcome through commitments.threadJudgements and its manifest. The owner-scoped repository already stores that non-null outcome; no migration or new tool/event is needed. Missing output is unknown and must never default to no_item. Tool tests cover item, no_item and a missing value.

The coordinator will release morning-inputs.ts ownership after PR #3471 merges. Then rebase on integration/scheduled-proactive and implement outcome-aware settlement through that public tool: no_item keeps needs_reply, item suppresses duplicate email presentation, and absent or unknown outcomes remain unresolved. Do not read commitment tables from the briefing. The old gate was stopped because QA corrections invalidate its input fingerprint. Real proof is held until the settlement fix is complete, then rebuild the proof image and run the full isolated gate.

## Settlement and confirmation exclusion plan after PR #3471

PR #3471 merged at 1c66097dc. This branch is rebased onto it. The coordinator released morning-inputs.ts ownership and added Ben's confirmation ruling to PR #3472. The coordinator approved this plan as c52672bbb, including everyday confirmation shapes and action overrides.

### Settlement

Use the existing commitments.threadJudgements public read, extended with the outcome already stored by the owner-scoped repository. There is no migration, new tool, new event or direct briefing read of commitment tables. A judgement must be at least as recent as the message before it settles it. A valid no_item clears the awaiting flag but retains independently actionable triage. A valid item excludes that email from both email prose and email signals; its commitment appears once through the existing commitment read. Missing, malformed, older or outcome-less results remain unresolved; unknown never means no_item. Preserve needs_reply in both real triage paths. Preserve needs_action too where needed for Ben's explicit pay/confirm requests to survive a no_item outcome; this does not create a task or commitment.

### How code identifies a no-action confirmation

Add one bounded source-text predicate beside the existing email evidence assessment and apply it before any Today email selection. Read the original subject and snippet only. Do not use model summaries, generated prose, confidence, or a receipt label as proof that no action is required. Match explicit completed-transaction or delivery phrases: order confirmed/received, shipment sent/dispatched/delivered, booking or reservation confirmed, payment received/successful, and an order/payment receipt. Use whole-word patterns and normalized case/spacing.

An explicit request overrides the confirmation match: reply/respond, please confirm/review/pay, an owner-directed question, payment due or unpaid, failed/pending transactions, or an instruction with a deadline. Existing needs_reply or needs_action triage also protects the message from exclusion; those labels may keep mail, but cannot by themselves prove no action is required. For example, an order receipt is excluded, while "Booking confirmed; please reply to confirm your arrival time" stays eligible. A bare mention of order, payment or booking is insufficient. Missing source text, ambiguous wording and unfamiliar confirmation forms remain eligible under the existing rules; this conservative limit avoids hiding an actual request.

Reconcile payment evidence using all fetched messages first, preserving PR #3471's receipt evidence. Then exclude recognized no-action confirmations from eligible Today items regardless of pending judgement, fyi classification, or unknown judgement outcome. Apply the same predicate at the morning list boundary so neither may-need-you nor worth-knowing can reintroduce them. Keep evidence records; do not delete mailbox data. Confirmation exclusion is code, not a prompt instruction. Update the owning app-map metadata in the same PR.

### Tests that fail before the change

- The existing real-triage composer item case fails because one thread appears as both reply-needed mail and a commitment. Add valid no_item, missing/unknown outcome and older judgement cases to prove question retention and safe settlement.
- Parameterized order, shipping, booking and payment confirmations fail because pending confirmations can enter may-need-you and fyi confirmations can enter worth-knowing. Cover pending mail before judgement and unknown outcomes, without relying on model labels.
- A reply-needed booking confirmation, and a confirmation asking the owner to pay by a date, remain eligible after no_item. Cover both real triage producers and original source snippets.
- Missing/ambiguous source text stays under existing eligibility rules. A later payment receipt still settles the matching earlier invoice through PR #3471's evidence assessment even though the receipt itself never appears on Today.

### Live proof and checks

Rebuild the disposable image. Deliver five real SMTP messages to isolated GreenMail: inbound pharmacy notice, owner promise plus incoming reply, colleague question, and an order confirmation with no action. Connect through the real IMAP connector, bind the real economy model for triage, and run real sync and queued judgement. Inspect persisted outcomes and zero inferred candidates. Retain the separate owner-backed design-draft commitment because IMAP threading remains limited under #3470. Generate a real briefing and open it from Today: the owner-backed commitment and needs-reply colleague question are visible, the confirmation reaches neither email list nor the briefing, and the pharmacy notice is not a must-do. Unit tests prove grouped two-sided commitment deduplication; no fabricated cache or judgement results and no intercepted responses. Post bounded evidence on draft PR #3472, then run the scoped tests, fast checks and a fresh full isolated gate and read CI.

The existing kill gate stays in force: if the pharmacy notice becomes a must-do through briefing email signals despite no candidate, stop and report that classified route for a coordinator ruling. Do not claim live verification until this proof is posted. Chat and notes extraction remain unchanged.

## QA corrections on October 12

Pending first-pass decisions retain their reply or action category and are reused without another model call. Ten cached questions reproduced eight unwanted calls before the fix. Confirmation overrides now keep collection instructions, signature and delivery scheduling requests, due payments and requests for a receipt eligible; ambiguous wording stays eligible.

The existing email read settles answered conversations from the newest cached sender, using the existing owner-address inference and thread reads. This happens before queued judgement and covers older unresolved questions too. Read-time settlement changes no stored email; the judgement worker records no item for the newest owner reply. No tool, event or storage was added.

The cache-reuse, confirmation and worker tests failed first. An isolated database test also failed before read-time settlement and now checks that an older answered question leaves both Today lists before and after judgement. Final verification includes the full gate plus browser specs 3467, 1452, 2956 and 3465.
