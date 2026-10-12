# One scheduled owner-source read (#3151)

Status: approved by coordinator on plan ef49e0361; implementation complete; final live verification in progress. Worktree: `~/Jarv1s/.claude/worktrees/sched-3151-scheduled-read`.
Branch: scheduled/3151-scheduled-read. Base: integration/scheduled-proactive.

## Contract and scope

Save one exact Tasks status check from Main chat, using the existing responsibility record and
Settings controls. Execute one frozen Tasks read under current owner access, then persist an ordinary
sourced assistant reply. The report comes from the actual response. Ben's ruling on #3135 allows the
model to fill read-only task terms without another approval; write and delete remain refused.

This implements #3151 and the applicable creation, background execution, recovery and testing
sections of the approved scheduled-tasks spec. Recurrence, watches, other source adapters, write
authority, AI-written reports and a model tool loop stay outside this slice. Basic bounded transient
read retries remain required here by the issue; #3152 can extend reporting/recovery later.

## Verified seams

- Saved records, reserved message identity and owner-scoped reads: packages/chat/src/reminders/repository.ts:143,185.
- Transactional metadata-only enqueue and lifecycle/version checks: packages/chat/src/reminders/deliver.ts:60,76.
- Existing result persistence, arrival and outward policy: packages/chat/src/reminders/deliver.ts:106,123.
- Resume currently enqueues the reminder queue: packages/chat/src/reminders/controls.ts:72.
- Settings reads the same rows and message: packages/chat/src/reminders/settings.ts:64.
- Actor workers and retry metadata: packages/chat/src/jobs.ts:603 and packages/chat/src/reminders/deliver.ts:187.
- Session-free read gateway exists: packages/ai/src/gateway/gateway.ts:560. It resolves active tools,
  rejects effective non-reads, and executes in an actor transaction. It does not return structured
  data today; the scheduled path must preserve the validated response for deterministic reporting.
- Gateway execution transaction: packages/ai/src/gateway/gateway.ts:758. Current read execution
  has no owner-only target hook; add that hook for scheduled work before handler invocation.
- Tasks public read: packages/tasks/src/manifest.ts:512 and packages/tasks/src/tools.ts:77.
  TasksRepository.getById is owner-or-share (packages/tasks/src/repository.ts:169), so visibility
  alone cannot prove ownership. The Tasks module must own the explicit ownership predicate.
- Current enablement resolution: packages/module-registry/src/active-modules-resolver.ts:27.
  Worker composition is separate from API composition: packages/module-registry/src/index.ts:2391.
- Hidden structured generation can prepare inside a short actor transaction and run outside it:
  packages/ai/src/structured/generate-structured.ts:277; existing usage packages/chat/src/summary-job.ts:310.
- Main request interception and atomic save: packages/chat/src/live/pre-model-turn.ts:38 and
  packages/chat/src/live/persistence.ts:563. Runtime composition: packages/chat/src/live/runtime.ts:648.

These are reuse seams, not claims that scheduled-read enforcement already exists.

## Decisions

### Storage and lifecycle

Migration 0318 belongs in packages/chat/sql/0318_chat_scheduled_reads.sql. Add an owner-only
extension table with reminder_id (primary key, references chat_reminders with ON DELETE CASCADE),
owner_user_id (UUID, references users), operation (text CHECK tasks.get), item_id (UUID), and outcome (nullable text constrained to
success/refused/failed). No foreign key to another module's table. The frozen operation is always
tasks.get with exactly taskId; there is no stored arbitrary method, recipient or input.
Force RLS; insertion verifies the current actor owns the parent reminder. Worker may update outcome
only; actor cannot change operation, item_id or owner. Delete follows parent deletion. Declare the migration,
table and DB type in chat's manifest, packages/db/src/types.ts and schema catalog coverage.

Reuse reminder timing, deadline, version, reserved message, capacity, pause, resume, delete and quiet
allowance. Route enqueue by existence of the extension to a separate chat.scheduled-read queue;
an ordinary reminder worker must never turn a read check into a plain reminder. Do not change the
result origin schema. A refused or exhausted check still gets one honest normal assistant message;
Settings derives failed status/history from extension outcome while preserving its View message.

### Creation and model boundary

New packages/chat/src/scheduled-reads/request.ts resolves a bounded scheduled-check request through
the configured structured model. Its only model jobs are interpreting source selection and timing.
Use a bounded, owner-authorized Tasks candidate list from the public Tasks module; validate the
selected UUID against that list and reject ambiguous, unsupported, recurring or mutating requests.
Reuse relative/local-clock timing validation. Private candidate content stays inside actor scopes
and the model request, never in jobs. Schema descriptions and a worked example define the contract;
the boundary validator limits output to one current owned item and supported timing.

Wire an optional request-resolution port through chat-session-ports.ts, persistence.ts, runtime.ts
and routes.ts. Call it before normal model execution only for scheduled-read intent, with the turn's
abort signal. Add a scheduled_read command in reminders/commands/types.ts and registry.ts, implemented
in commands/scheduled-read.ts. Save the extension and enqueue atomically with the real user turn.
Confirmation renders from the validated record's title and local timing, never model prose.
The explicit request is authorization under Ben's ruling; no acceptance panel is added.

### Gateway and run

Add a separate runBackgroundReadForActor entry point to the real AssistantToolGateway. It accepts
the trusted owner and frozen read operation plus run identity; it supplies no destination thread
binding and never records live-chat outside-content state. Share existing preparation, effective
risk checks, current active-module resolution, input validation and read-only services with the
existing actor-read implementation. Return validated structuredData for the report seam.

Add an optional authorizeBackgroundRead hook to ModuleAssistantToolManifest in
packages/module-sdk/src/index.ts. Background execution fails closed without it. Tasks.get supplies
the hook from packages/tasks/src/tools.ts; under the same actor transaction used for handler
execution it requires an exact taskId input and a current row owned by that actor. The gateway
checks effective read risk and the hook before invocation. Revalidate current capability and
module availability at execution, rather than trusting creation-time selection. Tests cover
revocation/disable, foreign private and shared targets, write and delete, and altered inputs.

New packages/chat/src/scheduled-reads/{repository,runner,report}.ts owns storage, the actor job and
deterministic report. The worker opens a short transaction to load current instruction/identity,
executes the frozen gateway read outside the responsibility lock, then locks/rechecks owner,
version/state/deadline before persistence. Cancellation or version changes during the read discard
the result. The reserved message ID plus row locking prevents duplicate results on replay.

Report only validated title and status with a Tasks source link, escaping source text as text;
source instructions cannot become another operation or change notification settings. On refusal,
use fixed recovery wording with no foreign title or content. Transient read failures throw for
bounded quiet retries; final exhaustion persists an actionable failure. Persistence and notification
enqueue are atomic; notification failure does not rerun the read. Worker composition constructs a
session-free real gateway using current active modules and existing read services, with no live
manager or browser dependency.

## One delivery phase and verification

Implement behavior-first tests before feature code. Exact test files:

- tests/unit/3151-scheduled-read-request.test.ts: model output boundaries, unsupported requests,
  timing, ambiguity, deterministic confirmation and cancellation.
- tests/unit/3151-background-read-gateway.test.ts: actual gateway refuses writes/deletes, disabled
  capabilities, changed input and failed ownership before calling the source handler.
- tests/integration/3151-scheduled-read.test.ts: real Tasks/worker and RLS seams, foreign shared
  target denial, current access revocation, frozen operation, metadata-only jobs, pause/delete,
  stale versions during read, duplicate jobs/results, quiet retries and exhausted failure message.
- tests/uat/specs/3151-scheduled-owner-read.uat.spec.ts and corresponding blocking rows in
  .claude/skills/coordinate/uat-trigger-map.tsv: real UI-created disposable task; real configured
  model schedules a near-future check; close/reopen, inspect and reply to sourced result; inspect
  Settings; remove the disposable source before another run and observe honest refusal. Tasks is a required core module with no disable or source-delete UI, so removal is explicit SQL fault setup on the disposable installation. Disabled-capability tests use the real resolver with an optional Tasks fixture.

Observe the security tests failing after independently removing each risk, capability and ownership
protection, then restore protections and observe green. Record exact mutation and failing assertion
on the PR. Tests assert behavior/message counts, not model wording or helper call order.

Run scoped integration checks and the full foundation gate only through scripts/run-gate.sh;
expected terminal exit 0. Run pnpm format:check, pnpm lint, pnpm check:file-size and pnpm typecheck
without pipelines; each expected exit 0. Use event-driven gate completion and bounded log reads.

Use an independent from-source disposable installation following the private proof README, claim
the port through devports, and build with JARVIS_IMAGE_TAG=uat-sched-3151. No response interception,
screenshots or personal data in evidence. Post executable assertions and bounded text on the PR.
Stop owned resources and release the port. No new UI components are planned; reuse Settings
primitives and update packages/shared/src/app-map-core.ts plus chat feature declarations for the
actual support, failure and recovery paths.

Kill gate: if the real worker cannot invoke the existing gateway without replacing it, or the
near-future UI proof cannot demonstrate a sourced result within this slice, stop and ask the
coordinator to reslice; never expand into a workflow engine. Coordinator owns that decision.

Finish by rebasing on origin/integration/scheduled-proactive, pushing, opening a PR with Part of
#3151 and Release note Category: N/A, reading CI, posting live evidence and reporting ready for
review. No board, milestone, issue closing or merge operations.

## Rulings and live state

- Migration 0318 assigned by brief; 0317 belongs to #3135.
- Ben's #3135 ruling permits direct save of model-filled read-only terms.
- Existing reminder queue resumes ordinary reminders; extension routing is required for this slice.
- Feature implementation is present; targeted integration checks pass, and live proof is being diagnosed before closeout.

## Approval notes

All reminder enqueues use the shared extension-aware function, including future time edits from #3135. If that lane merges first, route its enqueue through the same function and refuse text edits on read checks. The recognizer leaves everyday oven, grammar and workload chat alone without a model call. The stored operation is explicit and constrained to tasks.get. Live proof uses the sanctioned Codex CLI subscription and cheapest configured model, per coordinator ruling.

## Verification state

- Focused request/gateway unit checks: 26 passed.
- Targeted integration gate: 88 passed, including the registered queue worker with the real worker role, production built-in module resolver, and notification enqueue.
- Security mutations were observed failing: operation allowlist (3 failures), effective read risk/plan (2), explicit Tasks ownership (foreign shared source returned success), and the real module resolver's per-user deny check (disabled source returned success). All protections were restored.
- First disposable UI run used Codex gpt-6-luna, created the source task, saved the check and reached Settings. It timed out waiting for the sourced report. The instrumented reproduction captures job state/output and reserved-message state before teardown.
- The second live run delivered the current done status, then failed because the markdown URL filter removed the relative Tasks link. Successful scheduled reports now carry a server-authored source marker through persistence, live arrival and history. Their bodies render as plain text with a fixed /tasks link; the general URL filter is unchanged. A task title containing markdown, javascript: and a bare HTTPS URL produces no links. Removing this renderer made the security assertion fail; the protection is restored.
- The first missing report remains unexplained. Relative due time is an exact database interval; queue start-after uses the same timestamp and pickup polls every second. Normal rounding and polling do not explain a 120-second wait. The installed pg-boss backoff adds randomized delays of 15-30 and 30-60 seconds for two transient retries. A 45-second request can therefore reach 90-135 seconds before source latency and polling, exceeding the 120-second assertion in the worst case. There is no retained job evidence proving retries happened on the first run. The live harness captures due time, pickup, completion, retry count, reserved message and thread on success or failure.
- Final acceptance requires three consecutive clean runs of the complete live spec using Codex. The full foundation gate and those live receipts are recorded on the PR; no pending run is claimed as green here.

## Stream delivery diagnosis (#3492)

The third instrumented run persisted the successful result in Main about 46 seconds after saving, with zero retries, but the browser missed it while chat startup delayed its subscription. A held-startup regression reproduced that gap. The shared fix subscribes and flushes first, then warms the agent asynchronously; every stream open reads back unseen background messages and the existing message-id merge drops duplicates. Both plain reminders and scheduled reports have held-startup and first-open recovery regressions. This fix is a separate commit in this integration PR, Part of #3492. Main has the same wait at packages/chat/src/live-routes.ts:544, before subscription at :562, but lacks the background-delivery path; the coordinator ruled against prerequisite backports or a separate main PR. #3492 closes with #3154. The first uninstrumented failure remains unexplained and is retained in the proof.

The first post-fix full run passed source delivery, app link, reload, reply and Settings history. It then exposed a harness race: the existing confirmation was counted before history loaded (zero), so two visible confirmations after the next save failed an expectation of one. Wait for the existing confirmation before taking that count; keep this failed run in the proof and restart the three-clean-run sequence. Job capture also names its queue to distinguish the source job from notification work.

Further live coverage clarified that View message opens a result-only dialog, not chat history. The proof now clicks its real Open chat action before counting save confirmations. That dialog also needs the worker-success source marker in its Settings DTO/schema and renderer; only a recorded successful read supplies it. The marker mapping regression failed before the fix. One separate asset-import failure (server returned HTTP 200) is not reproduced yet; passive asset request-failure capture remains in the harness.
