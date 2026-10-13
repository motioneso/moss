# 3142a: bounded action agreement foundation

Parent: #3142. Build branch: `integration/scheduled-proactive`, initial pin `8c4b1aff52ee83967ab668e5d3f0a74e760e5a87`.

The user-approved stage boundary separates creation-time typed agreement and scope inspection
from unattended execution. #3142b owns effect execution, initiation recording and uncertain
outcome replay safeguards. #3142 is incomplete until that later stage and the full acceptance
proof pass. This stage does not implement background writes, deletion or action-scope editing.

## Product boundary

Use the accepted #3100 ordinary-text question and normal composer. A stated proposal names one
owned task, its exact `tasks.updateStatus` input (`taskId`, `status: done`), a one-time future
relative timing resolved to an instant, and the existing Main destination. Only a typed,
unmodified `yes` to that current question accepts it. `no`, revised or unclear replies,
replacement proposals, intervening ordinary turns and stale questions do not accept the terms.
Reload alone preserves the question and conveys no agreement.

Agreement records are separate from active tasks. There is no reminder row or queue job for them.
Settings shows accepted records under Approved changes - not active, including exact stored
scope and version. Ordinary chat explains that the agreement is saved but no change will run.
There is no Resume control or effect API for these records. Existing scheduled-read gateway
entry refuses all write operations, including this exact stored operation.

## Implementation ownership

- Chat-owned reusable proposal binder: immutable typed caller terms, owner/thread/message/version
  binding, canonical terms fingerprint, transactional consume-once acceptance.
- Bounded creation adapter: configured JSON model for candidate/time interpretation, server-owned
  operation/status, owner rechecks and ordinary-chat refusal/save paths.
- Chat migration `0322_chat_responsibility_agreements.sql`, database types and manifest ownership.
- Separate approved-scope response contract and existing Settings primitives, without new cards,
  approval buttons or task editing forms.
- Existing freshness helpers are extracted intact to keep persistence under its 1000-line cap.

The binder stores caller-validated terms without owning action semantics. #3141 suggestions and
#3144 scoped edits can reuse its proposal identity/version/fingerprint and consume-once contract;
those adapters are not implemented here. Existing live-chat outside-content rules are unchanged.
No model/source text can call the binder's acceptance directly through an assistant tool.

## Verified platform seams and decisions

Approved product/design reference: `docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md:99`
(ordinary typed agreement), `:107` (stored destination) and `:111` (local timing/authority).
The existing compact Settings index/detail mockup and shared RowIndex/SectionHead primitives
are reused; this stage adds an inert group, not a new module or approval panel.

- Actor-scoped transaction: `packages/db/src/data-context.ts:63`; acceptance and its user/assistant
  messages are written together in `packages/chat/src/live/persistence.ts:508`.
- Existing owner/surface advisory selection lock: `packages/chat/src/repository.ts:877`;
  persistence takes it before proposal/acceptance at `packages/chat/src/live/persistence.ts:545`.
- Existing completed-turn identity reaches the early command via
  `packages/chat/src/live/pre-model-turn.ts:232`; direct persistence calls get a generated identity.
- Existing Tasks public owner lookup/candidate APIs: `packages/tasks/src/tools.ts:31`.
  Current tool availability is checked via the gateway wiring in `packages/chat/src/routes.ts:462`.
- Existing background operation allowlist: `packages/ai/src/gateway/gateway.ts:574`.
  This stage adds no allowlist entry, worker handler, action execution or queue call.
- Owner Settings response: `packages/chat/src/reminders/routes.ts:51`; separate list/detail
  composition: `apps/web/src/settings/settings-scheduled-tasks-pane.tsx:22` and
  `apps/web/src/settings/approved-action-scopes.tsx:6`.
- New reload/history contract: `packages/chat/src/route-serializers.ts:157` includes scope origins.

The model has exactly two jobs: select one named owned candidate, and render the owner's relative
timing in the bounded reminder form. Its prompt is under 150 words before request/candidate data.
All four output guards apply: schema field descriptions; prompt contract with worked example;
server boundary checks of exact two-field output, listed target and matching raw-request delay;
per-item agreement showing the exact proposed target/status/time before the absent approval record
becomes accepted. Record-derived ordinary replies and Settings show the persisted result. There is
no source-data before/after effect in this slice; #3142b must define that gate before execution.

Kill gate owner: Ben, after this standalone stage's live proof. Stop #3142b planning if ordinary
chat plus exact inactive Settings details do not make the proposed authority understandable, or
if any job/effect occurs from a saved agreement. A failed scope/owner/freshness boundary blocks merge.
The later execution slice is not planned in detail here.

## Verification plan

Pure behavioral tests cover exact terms, malformed/widened input, typed agreement versus revised
text, decline, cancellation, stale proposal/version/fingerprint, replay and real gateway refusal.
Database integration tests cover owner versus foreign owner/admin, source/message provenance,
immutable fields, duplicate acceptance, accepted Settings records and absence of reminder/jobs.
The required isolated database workflow is `scripts/run-gate.sh`; never a direct DB suite.

Observe key scope/freshness/source and gateway assertions fail with their enforcement removed.
Retain bounded verdicts rather than private values. Run scoped lint, root and test TypeScript,
formatting, file-size and UI audits, then the final-head full foundation gate. Independent review
and installed real UI proof remain required before merge.

Installed proof must exercise ordinary chat proposal, decline/revision, reload, current typed
agreement, Settings exact inert scope and no Resume, plus real gateway write refusal and unchanged
disposable task after the agreed time. Use executable DOM/network/database assertions and bounded
textual evidence, with no screenshots or rewritten API/Moss responses. A configured model remains
provider-agnostic; any third-party stand-in is disclosed. If an isolated installed instance or DB
gate is unavailable, report code-complete, unverified and leave merge blocked.

## Exact checks and expected exits

Run each command unpiped, recording its own exit. All expected exits are 0 for unchanged source;
mutation controls expect 1 with the intended assertion failing. TypeScript runs are serialized.

- `pnpm exec node --import tsx scripts/test-unit.ts tests/unit/3142a-agreement-terms.test.ts tests/unit/3142a-agreement-preparation.test.ts tests/unit/3142a-agreement-persistence-boundary.test.ts tests/unit/3142a-agreement-rendering.test.tsx tests/unit/3142a-background-action-refusal.test.ts tests/unit/chat-reminder-recognizer.test.ts tests/unit/chat-reminder-controls.test.ts tests/unit/3151-background-read-gateway.test.ts`
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm exec tsc --noEmit`
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm exec tsc -p tsconfig.tests.json --noEmit`
- `pnpm --filter @moss/web typecheck`
- `pnpm exec eslint <all changed TypeScript/TSX paths> --max-warnings=0`
- `pnpm exec prettier --check <all changed supported-format paths>`; SQL is reviewed without a
  nonexistent Prettier SQL parser.
- `pnpm check:file-size`, `pnpm check:design-tokens`, `pnpm check:ui-classes`
- `scripts/run-gate.sh start --gate test:integration:3142a`, then
  `scripts/run-gate.sh wait --follow` (wrapper only, disposable DB).
- `scripts/run-gate.sh start`, then `scripts/run-gate.sh wait --follow` (final full foundation gate).
- On the installed disposable proof instance with the configured real model:
  `MOSS_UAT_CAPTURE_OFF=1 pnpm test:uat 3142a-bounded-action-agreement.uat.spec.ts`.
  The isolated installed harness owns teardown of its database; the test closes its replacement page.

Compiler OOMs, unavailable Docker and unrun installed proof are reported as failed/blocked checks,
not replaced with narrowed green claims. Publication may be a reviewed draft; merge remains blocked
until final-head isolated foundation/CI and real installed UI proof pass.
