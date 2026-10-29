# Vocci: ring commands use the normal chat input

## Controlling update — 2026-10-24

Ben subsequently clarified in the successor conversation: “I don't want to wait
for explicit send, the text should send automatiocally”. This supersedes the
explicit-Send/editable-composer requirement below for ring input. Follow the
[updated spec](../specs/2026-10-24-vocci-normal-chat-input.md) and
[bounded plan](../plans/2026-10-24-vocci-normal-chat-input.md). Existing browser
microphone input remains an editable draft. Preserve legacy pending requests,
owner/Main/privacy/selection and replay fences; no phone/production operation.
The original Start text below is retained as historical context where superseded.

## Start

Ben's new direction in the owning conversation, 2026-10-24:
“there doesn't need to be a separate pop-up section in the drawer chat for ring
commands, those should just be like normal inputs”. This is the next actionable
bounded slice after the best-effort vocabulary PR #3653. Continue the standing
committed plan → independent Standards/Spec → real UI proof → required CI → merge
cycle, with no further general go-ahead. Keep #3565/#3584 open.

1. First run `pnpm install`. Read AGENTS.md, CLAUDE.md,
   `docs/DEVELOPMENT_STANDARDS.md`, this handoff, the recovery and vocabulary-build
   continuations, approved automatic-delivery/initial-setup/Android Hardware specs,
   current voice-input design and the vocabulary evidence in full. Recheck live
   issues, predecessor merge, exact-head independent reviews and required CI.
2. Read latest private `~/.local/state/moss/vocci-recovery/runtime.md`,
   `vocabulary-build/state.md`, `copy-rollout/state.md`, `adapter-recovery/state.md`
   and `setup-style/state.md` before configured-runtime/device access. Confirm
   actual execution/install result/immutable session ID to `vocci-vocabulary-build`
   through herdr-pane-message. Remain read-only until explicit exclusive transfer;
   complete all mandatory Start reads before dependent actions. Fetch current main
   while clean; do not duplicate the session if CLI readiness times out.
3. Use graph-first discovery (bounded source fallback if unavailable), Hindsight
   and project notes to trace the actual request/receipt/admission and normal chat
   composer paths. Apply repo plan-build/design-system. Commit a bounded plan
   before product edits. The approved direction removes the separate Ring voice
   requests section and treats recognized ring text like other normal inputs.
   Existing microphone input inserts an editable draft and uses explicit Send;
   use that normal flow. Do not infer automatic sending from removal of the panel.
4. Inspect these current seams, verified at vocabulary final evidence review:
   `apps/web/src/chat/voice-requests.tsx` owns the disclosure/list/Send-to-Main UI;
   `chat-drawer.tsx` mounts it immediately above `Composer`;
   `composer.tsx` owns normal microphone insertion/review/send;
   `voice-request-link.tsx` resolves an owned receipt from a link. These are
   discovery leads, not a complete design. Trace backend send/admission and reply
   handling before deciding how editable draft text, source association, uncertain
   responses and replay protection fit together.
5. Implement one complete slice through normal input/send, app-map truthfulness
   and meaningful verification. Preserve owner/Main destination, receipt identity,
   replay/double-send prevention, privacy/selection fences, ordinary typed drafts,
   failure recovery and existing queued ring requests. Do not merely hide the list
   and make pending inputs inaccessible. Never overwrite unsent typed text or
   discard pending requests; define deterministic handling of multiple arrivals,
   busy chat, reload/remount, editing, and link navigation in the committed plan.
   Prefer canonical composer/admission seams over parallel chat mechanisms.
6. Prove actual real Settings/normal chat UI with a disposable owner and real data
   path through ring request admission, visible editable normal input and explicit
   Send/reply, including failure/retry and no duplicate dispatch. No intercepted
   Moss responses. Use verify-gate for all DB work and reserve/release devports.
   Disclose generated audio/third-party stand-ins; no production hold/sample is
   needed or authorized. Independently review immutable head/evidence, resolve
   findings, pass required exact-head CI and merge. No deployment in this slice.

## Vocabulary and production baseline

Best-effort vocabulary product head `b8593a87a` passed focused unit 403, isolated
integration 102 and six-step actual Settings/import multipart proof with disclosed
stand-in/generated audio. Final immutable review/evidence/CI/merge are recorded
on PR #3653 and in
[its evidence](../../evidence/vocci/2026-10-24-best-effort-vocabulary.md).
Verify actual PR status rather than assuming this handoff proves merge. Vocabulary
approval is resolved; do not revive the rejected strict-support policy. Vocabulary
merge does not establish production deployment.

Production copy source remains `967bee00b1aa2119bc8ea55aa4b402f48898a6ff`.
Companion 20261027 is installed; never reinstall. The physical adapter outage
passed once, marker exists; never repeat. No production or phone access occurred
in the vocabulary slice. This new UI direction authorizes no device operation,
production hold enrollment, recording/replay, deployment, reset/rebind, source
deletion, reboot, firmware or ownership write. Preserve signing/Keystore/config,
queues/exclusions/originals/completed imports/hold destinations, enabled=true,
hold=false, cleanup=false, timeout120000 and official permission handoff.

## Entire remaining queue

Carry package replacement; physical out-of-range/offline/interrupted upload;
separately opted-in production hold; reminder/endurance; other approved missing
Meeting processing; proven exact-source deletion; original-preserving enhancement;
firmware compatibility/recovery and streaming. The normal-input UI change is
independent of physical acceptance. Virtual Android stays deferred. Do not spawn
into unchanged external blockers; verify actual fresh successor execution,
installation result and immutable identity before exclusive ownership transfer.
