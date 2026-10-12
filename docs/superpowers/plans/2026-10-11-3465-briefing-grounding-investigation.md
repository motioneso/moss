# Briefing current-status evidence and line traceability (#3465)

Status: coordinator approved the split and slice 1 on October 11. Slice 1 builds against #3465; checked lines and history are #3466; one-sided messages are #3467. Approval requires owner-only saved evidence, reader audit and cross-user regression proof, and the kill gate below.

Branch: scheduled/3465-briefing-grounding. Base: integration/scheduled-proactive, verified at 99b83b531. Worktree: ~/Jarv1s/.claude/worktrees/sched-3465-briefing-grounding.

Part of #3465 and the approved scheduled-tasks specification, sections Background execution and permissions, Usefulness and attention, and Testing Decisions. The issue's October 11 correction governs this investigation: the bills were real historical emails, not invented records. The defect is unsupported current status and certainty.

## Investigation and observed reproduction

The original private account was not read. Reproduction uses a synthetic copy of the corrected input shape, through the actual composer and its existing recording-database harness. Source collaborators supply fixture records; the composer, signal derivation, prioritization, prompt projection, and output handling run unchanged. This is diagnostic evidence, not live UI proof.

At 2026-10-11T15:00:00Z, the seeded owner has:

| Records                                                | Dates and labels                                         | Supporting or contrary evidence                                                            |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Three invoices, old-bill-0 through old-bill-2          | September 1; fyi; awaitingJudgement true                 | September 15 due dates; distinct invoice identifiers; synthetic Alpha, Beta, Gamma senders |
| Three later confirmations, receipt-0 through receipt-2 | September 15; receipt_or_notice; awaitingJudgement false | Same account and respective threads; each says its corresponding invoice was paid in full  |
| One accepted task, task-smog                           | todo; due October 1                                      | Vehicle emissions check; no billing task                                                   |
| Commitments                                            | Empty                                                    | No current obligation record                                                               |
| One appointment                                        | October 11, 17:15Z-18:00Z                                | Saved Pacific 12-hour locale means 10:15 AM-11:00 AM                                       |

Diagnostic invocation executed before any proposed fix:

- A temporary TypeScript replay, invoked as pnpm exec tsx --tsconfig tsconfig.json /tmp/sched-3465-replay.mts, calls composeBriefing with the seeded tool results. An assertion that settled historical invoices produce zero current bill signals fails: expected 0, actual 3.
- Rechecking with the real receipt_or_notice label reproduces all three signals. A characterization check exits 0 only when the three incorrect signals, omitted receipts, and omitted email ages are all observed.
- The produced signals include billing or due-date language and still unresolved. Two additional signals say the September invoices carry timing pressure today.
- The synthesis input contains neither the payment confirmations nor the September 1 received timestamps. It does contain the appointment's 10:15 AM local time.
- A controlled model response calling the bills seriously overdue reaches summaryText unchanged. This proves the acceptance defect; it does not claim that the real model used that exact wording.
- The captured, unchanged synthetic synthesis input was passed to a real Claude CLI Haiku call, with tools and customizations disabled and no session persistence. It recommended checking whether the September invoices were paid and settling them if not, despite the supplied source set already containing the matching payment confirmations. It did not say seriously overdue. Model call succeeded; duration 6.63 seconds. This direct model replay is not a disposable-install UI proof.

A second diagnostic invokes the actual judgeEmailThread worker with one inbound pharmacy pickup notice, no owner reply, and no supporting people, task, note, or calendar context. A controlled owed:true result creates one candidate with a task action. Expected candidates: zero. Observed verdict: item, saved candidates: one. This locates the missing code guard independently of model phrasing; it does not assert that this was the historical production extraction route.

Existing regression checks observed passing: 26 tests across briefings-person-time, briefings-morning-email-sorter, and commitment-email-judgement-worker. These passes do not cover the corrected defect.

## Root causes, with current-tree evidence

1. Historical billing language becomes an unsupported status assertion before synthesis. In packages/briefings/src/signals.ts:272, age is computed, but it supplies no expiry or settlement check. At line 303 a keyword match creates a bill signal; line 306 labels any message older than zero days still unresolved. At line 309 deadline-shaped wording becomes timing pressure today without checking whether the deadline applies today.
2. The composer removes contrary evidence before that decision. At packages/briefings/src/compose.ts:309, only items passing isBriefingEmailItem reach deriveEmailSignals. That predicate at packages/briefings/src/morning-inputs.ts:118 accepts actionable labels or awaiting judgement, and excludes ordinary receipts. Receipt exclusion from action lists is useful; applying it before status reconciliation is the defect.
3. The writer cannot recover what was removed. packages/briefings/src/morning-inputs.ts:252 turns awaiting messages into sender/subject strings and strips their timestamps. The derived signal summaries also omit their original received dates. Later receipts are neither supplied as contrary evidence nor checked before promoting the old messages.
4. Model prose is accepted without record-level claim validation. packages/briefings/src/compose-shared.ts:766 returns result.text; packages/briefings/src/compose.ts:635 applies layout cleanup, not factual validation. Existing prompt instructions already say not to invent. Another prompt-only prohibition would leave this acceptance path intact.
5. One-sided messages have no enforceable obligation guard. packages/commitments/src/email-judgement-worker.ts:93 skips an empty thread or an owner-authored newest message, but allows an inbound-only notice. At line 170, a schema-valid owed:true result is enough to save an obligation candidate. Prompt advice at packages/commitments/src/email-judgement.ts:88 is not a runtime check.
6. General line provenance is missing. packages/briefings/src/compose.ts:642 persists counts, signals, note excerpts, editorial evidence, and freshness, but no mapping from each rendered line to its supporting and contrary records or their labels/rank. Sports/news evidence and email signal message IDs are useful existing parts, not a complete lineage record.

## Verified seams and drift

| Needed capability                                  | Evidence in this tree                                                                         | Implication                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Actor-scoped source collection                     | packages/briefings/src/compose-shared.ts:479; packages/briefings/src/jobs.ts:1                | Reuse tools, DataContextDb, and worker identity                                             |
| Email IDs, dates, labels, and awaiting flag        | packages/email/src/tools.ts:108; packages/connectors/src/source-context/email.ts:112          | Preserve structured facts before display filtering                                          |
| Public thread reader                               | packages/email/src/thread-provider.ts:20                                                      | Read thread messages through the declared module contract; verify current source grants too |
| Task/commitment/calendar records                   | packages/briefings/src/compose.ts:122; packages/briefings/src/morning-inputs.ts:48            | Ground obligation and appointment statements in actual records                              |
| Existing priority reasons and stable candidate key | packages/priority/src/types.ts:63                                                             | Retain record identity when ordering, rather than matching only titles                      |
| JSON storage on each run                           | packages/briefings/sql/0015_briefings_module.sql:58; packages/briefings/src/repository.ts:469 | Versioned evidence can live in source_metadata; no migration expected                       |
| Owner-only run lookup                              | packages/briefings/src/repository.ts:235                                                      | Use the explicit owner predicate; do not reuse share-aware listRuns for private evidence    |
| Existing read tools                                | packages/briefings/src/tools.ts:95; packages/briefings/src/manifest.ts:175                    | Extend the Briefings module; no chat request-handler edits                                  |
| Source-account grant collaborator                  | packages/briefings/src/compose-shared.ts:84                                                   | Current source access must be checked when returning trace records                          |
| Saved locale resolution                            | packages/briefings/src/repository.ts:277; packages/briefings/src/compose-shared.ts:301        | #3390 is already on this branch; do not duplicate it                                        |
| Production worker locale wiring                    | packages/module-registry/src/index.ts:2441                                                    | Existing unit proof is backed by a production caller                                        |
| Local appointment rendering                        | packages/briefings/src/morning-day.ts:21; tests/unit/briefings-person-time.test.ts:90         | Replay confirms local 12-hour input; retain 24-hour and evening checks                      |

The original time-zone premise has drifted: commit 5631088a1 already reads the owner's saved locale for schedules and briefing timestamps. Existing tests pass and the real-model replay uses local times. Output validation must preserve those formatted times and reject rewritten UTC times. No new locale setting or scheduler is proposed.

## Scope assessment and proposed split

The full issue exceeds one session. It crosses email current-status reasoning, commitment creation, both briefing writers, general provenance persistence, source-permission rechecks, and chat history discovery, followed by a real-model UI proof. The coordinator owns the split and task issue numbers. This proposal does not start a partial implementation or claim the parent issue complete.

1. Current email evidence, age, and settlement. Stop keyword/age-based current obligation assertions; reconcile newer receipts before action filtering; retain dated records and decision reasons. First implementation plan below.
2. Record-validated briefing lines and owner-only history/source lookup. Consume the dated evidence from slice 1, validate rendered claims, persist the line mapping, expose it through Briefings read tools, and prove chat can explain a past run it did not start. This is the direct line-level traceability deliverable.
3. One-sided message guard. Block obligation/task promotion from inbound-only notices without independent owner-backed obligation evidence. Cover both the thread judgement and any active legacy extraction route found during that slice's caller audit. This can run independently with separate files; do not build source exclusions from #3190.

Each implementation slice needs its own real-model proof and app-map update. Slice 2 must prove the complete corrected input shape after slices 1 and 3 land. The coordinator can choose a different split or reduce scope explicitly.

## First implementation plan: current email evidence

Proposed ownership: packages/briefings/src/email-evidence.ts (new), signals.ts, morning-inputs.ts, compose.ts, compose-evening.ts, priority-consumer.ts, manifest.ts; packages/shared/src/briefing-email-evidence.ts (new) and its barrel; matching unit/integration/UAT tests. Avoid chat handlers, Settings task lists, and push delivery. A new public source reader or module-registry wiring requires a fresh cited seam check before coding.

Contracts to decide before implementation:

- BriefingEmailEvidenceV1 contains version 1, capturedAt, owner-local observation date, bounded source references, and per-message assessment: current claim supported, settled, or current status unknown. References include account and message identity, optional thread identity, receivedAt, triage label, awaiting flag, rank/reasons, and any matching contrary reference.
- assessBriefingEmailEvidence(items, now, locale) returns evidence and eligibleItems and is pure. No module-table access and no provider call. Its input includes receipts and notices before they are filtered from prose/action rows.
- Structured invoice matching requires the same account and explicit obligation identity; a matching sender or thread alone is insufficient where multiple invoices are possible. A generic later receipt cannot settle every bill from that sender. An ambiguous match remains unknown.
- Old due dates and absence of a receipt never prove a bill remains unpaid. A message can support what it reported at its received time; a current unpaid claim needs affirmative current evidence. Unknown current status must not become due, overdue, owed, or a must-do. Missing/invalid timestamps and incomplete source coverage fail closed for current-status claims.
- Age is evaluated against the owner's local observation date, preserving the original receivedAt. There is no invented seven-day freshness setting. Historical messages cannot become current obligations merely because their due date passed. Explicit owner-backed open tasks and commitments remain independently actionable.
- The email evidence assessment feeds both morning and evening signal builders and prose selection. Related older-message worth-knowing summaries also retain their dates and cannot reintroduce settled obligations.
- Persist the bounded assessment in source_metadata.emailEvidence, including why each old invoice was suppressed and the contrary receipt reference. No pg-boss content payload, new SQL table, or source-exclusion preference.
- Preserve source ID and receivedAt in priority candidates. Keep action-row deduplication behavior and existing catch-up handling.

Determinism boundary: code decides whether a current-status claim is supported and renders the evidence status and times. Model jobs are (1) select/order eligible items and (2) explain the supplied dated facts without upgrading their status. Selection must be schema-validated. Slice 2 replaces unchecked final prose with record-validated line output; slice 1 alone does not establish the complete parent guarantee.

Tests, stated as behavior:

- Three older invoices plus explicit matching newer payment confirmations produce zero current billing/timing signals. The original branch fails this case with three bill signals.
- Old invoices without a matching receipt remain unknown; a passed due date alone does not make them unpaid or seriously overdue.
- An unrelated receipt, another invoice from the same merchant, or a receipt from another account cannot incorrectly settle an obligation. Unknown cases do not become current claims either.
- Malformed dates, receipt-without-summary, duplicate records, incomplete reads, midnight across owner time zones, and ambiguous invoice identifiers retain safe statuses and diagnostic reasons.
- An accepted open overdue task remains present; settled bills are absent. Morning and evening consume the same assessment. Noise does not gain an action path.
- Saved 12-hour/24-hour locale still reaches both writers; a 17:15Z appointment renders 10:15 AM or 10:15. Check data structure and records, not exact prose.
- Evidence persistence is tied to the actual run and captures supporting/contrary references and rank. Integration tests execute as app/worker runtime roles on the isolated gate database.

Verification: scoped pnpm test:unit invocations must exit 0. Database tests only via scripts/run-gate.sh start with a scoped script, followed by one background wait --follow; expected exit 0. The complete foundation gate and CI are required for an implementation PR. Never pipe a verification command.

UAT: tests/uat/specs/3465-briefing-email-evidence.uat.spec.ts, with blocking rows in .claude/skills/coordinate/uat-trigger-map.tsv for the owned briefing files. On an own disposable install, select the real economical model and saved locale through Settings, seed synthetic records through real storage paths, generate a briefing through the real UI, and assert settled invoices do not appear as obligations. Do not intercept responses. Image tag: JARVIS_IMAGE_TAG=uat-sched-3465. Claim a port through devports and release it after stopping owned server PIDs.

Kill gate after this slice: if matching receipts cannot be obtained within authorized bounded reads, or the writer still upgrades unknown status in the real UI, stop and report that evidence to the coordinator. Do not add a prompt patch or declare the full issue fixed. Coordinator decides whether the source-read slice or validated writer must land first.

## Required decisions for line traceability slice

These are design choices for coordinator review, not approved code:

- A model returning source IDs with arbitrary prose is insufficient: the right ID can accompany a false claim. Prefer model selection/ordering of code-built facts with claim kinds, validated dates/statuses, and deterministic obligation/appointment wording. Any retained free prose needs a validation design that prevents factual upgrades; a keyword blacklist does not meet the contract. This choice affects the existing narrative format and needs coordinator confirmation before coding.
- Versioned line evidence stores the final rendered line identity/text range, supporting and contrary source references, labels, observation dates, and ranking reasons. Lines must map after layout cleanup, including headline, lead, headings, and aggregate counts. Counts are derived from eligible records in code. Do not claim retroactive lineage for old runs without it: return unavailable for those runs.
- Add an explicitly owner-filtered bounded history reader to BriefingsRepository, plus briefings.listRuns and briefings.getRunEvidence read tools in tools.ts/manifest.ts. Inputs select by type/date or owned run ID; evidence can select one final line. Shared definitions and admin status grant no access to this private history/evidence path.
- Recheck each referenced source through its owning public reader and current source grants before returning private record details. Revoked, deleted, inaccessible, or disabled sources return an unavailable result without disclosing their titles/excerpts. If a public point reader is missing, name the owning module change before coding. A snapshot does not bypass source permissions.
- Owner-only API evidence endpoint, shared schemas, module features/errors/remediations, and getRunStatus compatibility must agree. Default list/run serialization must not expose new private evidence to share-aware readers.
- Tests cover foreign users, admins, shared definitions, guessed run IDs, malformed output, wrong but existing source IDs, settled obligations cited as overdue, forged counts, UTC rewrites, source deletion/revocation, and legacy evidence unavailability. Observe privacy tests failing with enforcement removed.
- Final UAT: tests/uat/specs/3465-briefing-grounding.uat.spec.ts. With a real model and real UI, generate the corrected fixture briefing, reopen its stored history, and ask Moss what a specific line was built from. Assert the returned record IDs and labels match that line, regardless of model wording. Ask about a past run without first starting it in chat. Negative actor/source-access checks use real API paths on the same disposable install.

## Status and exclusions

No migration requested or invented. No production data changed. No private source content, secrets, private hostnames, or private addresses are included in these notes. Disposable real-model proof uses the assigned image tag and a claimed development port. Verification results and teardown are recorded on the implementation PR.

The implementation PR contains slice 1 and records its verification status. The coordinator approved the proposed split and first implementation scope. No planning-only PR; the plan stays with the slice 1 implementation PR. Source exclusions (#3190), Settings tasks, notification delivery, #3321, and #3026 remain outside this work.

## Rulings ledger

- October 11: split approved; #3465 owns slice 1, #3466 waits for slices 1/3 and the factual-writing ruling, #3467 has a separate builder.
- Verified owner-only run RLS already exists in packages/briefings/sql/0085_briefing_runs_owner_only_select.sql:22. Earlier share-aware definition access does not grant run access. Reader audit and an explicit saved-evidence regression remain required. No privacy migration or duplicated serializer guard is needed.

- October 11: older nonbilling needs-reply threads remain dated reports with current status unknown, outside all current urgency and obligation ranking. Bills retain the strict age cut-off. A no_item judgement clears awaiting status but never clears actionable triage.

- Settlement requires payment confirmation in the actual subject or snippet. AI-written summaries alone cannot settle an invoice. Ambiguous invoice identifiers remain unknown.
- Saved-evidence privacy is tested through app and worker readers and the shared-definition API list/detail paths. A disposable-database negative control removes the SELECT protection, observes the privacy assertion failing, restores migration 0085 policy text, and rechecks denial. No applied migration file is edited.
