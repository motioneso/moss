# One-sided messages do not create commitments (#3467)

Status: coordinator approved db7fd67e5, including the conservative no-duplicate rule. Implementation and verification in progress.
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

Coordinator approved the conservative guard. A colleague question triaged as needs_reply must still reach the briefing after a no_item judgement. A question missed by triage is outside this slice. The existing settleJudgedEmail path clears awaitingJudgement after any judgement; an actionable needs_reply label remains independently eligible. Keep this interaction in the PR body and leave morning-inputs.ts with sched-3465.

Observed red: four new guard regressions failed before the implementation. Observed green: 23 scoped worker/extractor/composer tests pass. The first full gate and disposable build failed because the new app-map description exceeded 240 characters; shortened it and restarted verification. Live fixture uses owner-scoped repositories in an ephemeral stack, invokes the actual judgement with cached thread records, and asserts original triage is preserved. The guard correctly skips the model for inbound-only threads; final briefing generation uses real Claude at economy tier.
