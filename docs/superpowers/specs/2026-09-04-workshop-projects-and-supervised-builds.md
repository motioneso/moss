# Workshop projects and supervised builds

Date: 2026-09-04. Tracking: [#2023](https://github.com/motioneso/moss/issues/2023).
Product design and prototype approved by Ben in this conversation (“yea that looks good”).
This implementation contract records that direction and the engineering work needed to deliver it.
Status after adversarial review: product design approved; **not yet build-ready**. Confinement
requires a deployment-backed prerequisite design, and the missing loading/error mockups require
review. The bounded tasks below replace the earlier five oversized execution slices. No production
implementation or live proof completed. See the [review response](../../reviews/2026-09-04-workshop-spec-review-response.md).

Ben reports Fable agrees with that response and has requested the
[build plan](../plans/2026-09-04-workshop-projects-and-supervised-builds.md). Its first phase covers
the prerequisite evidence and supplementary design review; the remaining scope is mapped with
dependencies, with detailed execution plans following the first phase’s go/no-go decision.

## Problem and intended result

Workshop has never delivered a meaningful result for Ben, even for a number generator or Word of
the Day. The current page lists builds, while requirements and approval happen in global chat.
The background builder runs disconnected steps, cannot receive useful supervision, and does not
prove its generated module works. Improving the status cards or prompt alone will not fix that.

An admin starts a **project** inside Workshop, discusses the requirements with a dedicated
assistant, reviews a plan and visual mockup, approves the current revision, and tries the actual
working draft beside that conversation. Changes stay in that project. Finishing keeps the module
private; sharing with everyone is a separate human action.

Retain suitable module SDK, validator, registry, queue, model router, and provider adapters.
Replace the interaction and build coordination. Do not build a general agent framework or replace
Moss’s module platform.

## Authority and approved design

The [approved prototype and walkthrough](assets/2026-09-04-workshop/README.md) establish the
screens, copy direction, and primary interactions. The [assessment](../../reviews/2026-09-04-workshop-assessment.md)
and [custom-module guide](../../module-developer-guide.md#13-custom-and-installable-modules)
record the source findings and contract requirements.

This spec supersedes these parts of the August 19 spec and issue #2023:

- **New project** is the primary action. A project is the persistent workspace; a module is its
  output. General Moss may create the project and redirect with context using the same operation.
- Creation begins discovery. It never means approval to build, including with automatic approval
  enabled. Approval is tied to the actual current plan and mockup revision.
- Conversation and project work stay side by side on desktop. At widths up to 800 CSS pixels,
  switch between them while keeping state and unfinished input.
- Use the configured interactive model by default; use reasoning for specification and planning,
  including substantive revisions. A provider process need not survive a model switch.
- **Finish privately** and **Share with everyone** are different operations. Existing shipping
  cannot be reused unchanged because it clears the draft owner.
- Prove pages, host storage, and supported tools first. Custom SQL provisioning, optional terminal
  attachment, concurrent builds for an owner, and richer research libraries follow separately.
- A timer heartbeat proves worker liveness, not useful agent work. Neither status nor successful
  bundling counts as proof that the generated module works.

Other preserved constraints: admin-only building, owner isolation including against other admins,
no external publishing, no cost/ETA/percentage displays, and no permission to modify Moss core or
unrelated module data. This approval covers the reviewed product design, not a claim that these
capabilities already exist or a waiver of the repository’s live-path gate.

## First delivery and non-goals

Complete one general-purpose path that can build Word of the Day from the user’s conversation.
The application must not contain a hardcoded Word of the Day implementation or replay the
prototype’s scripted replies. The example uses a bundled word list and local date, then adds
private saved words through host storage. Richer requests must receive an honest feasibility
answer during requirements gathering, rather than producing a plan the runtime cannot execute.

The release includes project list/create/detail, durable conversation, revisions and mockup
review, actual model routing, supervised attempts, checks and installation, draft refinement,
private completion, separate sharing, recovery, and cleanup. A fake draft or a UI connected only
to stub events is not an intermediate “done” state.

### Saved-word storage: existing path and actual missing integration

Phase A live follow-up: after fixing draft invocation, the real worker's `kv.set` was rejected
by the enabled-only KV policies in settings migration `0157_module_worker_runtime_access.sql`.
The storage proof must also cover an additive owner-draft user-storage policy under the real
worker role. Admin status never substitutes for matching the draft and data owner.

The current validator accepts `storage: [{namespace: "word-of-the-day.saved", scopes: ["user"]}]`.
The Slice 1 rejection comment at `JsonMossModuleManifest` is stale; the positive validation is in
`packages/module-registry/src/external/validate.ts`. Do not introduce SQL or browser localStorage
to satisfy this example. The intended round trip follows Finance’s existing public interfaces:

1. Save/remove sends a declared manual queue request to
   `POST /api/modules/:moduleId/queues/:queueName/run`, containing only a bundled `wordId` and
   operation metadata. The worker looks up the word text in its package; no private content enters
   the queue. Use separate save/remove queues so opposite operations are not collapsed by the
   route’s current actor/queue singleton key.
2. The declared write handler calls `ctx.kv.set/delete("user", "word-of-the-day.saved", wordId, …)`.
   `worker-rpc-host.ts` derives the actor and enforces namespace/scope/risk; the page cannot choose
   an owner. Queue retries must be idempotent. The frontend waits for a confirmed read, handles
   pending/timeout/429, and does not treat HTTP 202 as a saved record.
3. A declared read-only tool lists saved words through
   `POST /api/ai/assistant-tools/:name/invoke`. Read-only invocations cannot write KV. Preserve
   the existing manual-run dedup/rate limits for the proof; a general synchronous write bridge
   is a separate capability, not a silent requirement of Save word.

**Missing integration:** `createVerifiedExternalModuleInvoker` currently requires
`state.status === "enabled"`. It rejects a draft even though the settings-owned active-user SQL
already includes its owner. Enable the exact owner’s verified draft in this shared gate, using
the registry’s authoritative visibility and version/hash checks. Do not simply accept all drafts
or remove hash checks. This must pass an isolated installed-draft read/write proof before building
the generated saved-word refinement. No claim of that live proof is made by this document.

Do not add a marketplace, GitHub publishing, browser IDE, generic terminal, collaboration system,
new model-settings screen, or a new streaming infrastructure. Use existing query refresh and
bounded polling first. Keep internal resource/time limits even though the UI does not show ETAs.

## Domain and persistence

| Term             | Meaning and durable ownership                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project          | Owner’s workspace: title, requirements context, conversation, current revision, attempts, and output module. Survives completion and sharing.      |
| Revision         | Immutable specification, implementation plan, acceptance examples, capability requirements, and visual mockup references. Only one is current.     |
| Approval         | Owner’s authorization of one exact current revision and artifact hashes. A requirements or authority change invalidates it.                        |
| Attempt          | One execution of an approved revision, with a unique run identity, worker lease, observed events, and check evidence. Retry creates a new attempt. |
| Draft            | Verified candidate module version available only to its author. Distinct from the last finished version.                                           |
| Finished version | Owner-accepted module version. Remains private unless separately shared.                                                                           |
| Availability     | Whether a finished module is available only to its owner or to everyone. Never controls access to the project conversation.                        |

Add Workshop-owned project, revision, and conversation/event persistence rather than treating a
global drawer identifier as a database thread UUID. Keep the existing `app.module_builds` records
as execution records where practical; link them to project and approved revision and add the
attempt/lease identity they lack. Use one ordered project feed with validated message/event kinds
instead of maintaining disconnected chat and status histories. Queries may project conversation
and activity separately from that feed. Do not reconstruct state by scraping terminal output.

Store current project state and feed writes transactionally. Revisions are immutable after being
presented. Approval, lease acquisition, completion, and cancellation use conditional writes so
two requests cannot both win an incompatible transition. Source and artifact references use
server-derived project/attempt paths; clients and model output cannot choose host paths.

The initial limit is one active planning/build execution per owner, while allowing multiple saved
projects. Enforce the active-owner constraint in the database, not just a disabled button. Opening
another project never replaces the running one. A new start returns a conflict with a link to
the owner’s active project; an idempotent replay returns its original result.

New module-owned SQL belongs in `packages/workshop/sql/` and is registered through the module’s
supported migration declarations. Extend existing tables through new migrations in their owning
package; never edit an applied migration. All project/feed/revision/artifact operations use
`DataContextDb` and owner RLS. An authenticated non-owner receives the same 404 as a missing object.
Admin power does not bypass this boundary.

The ownership decision is explicit: settings continues to own `app.module_builds` and its execution
record migrations. Its existing public `@moss/settings` exports include the build repository.
Extend that public API for expected-state/revision/lease operations and inject it into Workshop’s
host composition. Workshop owns project/revision/feed tables only; no Workshop SQL reads, joins,
alters, or migrates settings tables. Cross-boundary IDs are opaque references resolved by the
owning public API. Transactional host orchestration calls both APIs with the same scoped transaction
where required. A module-table move is unnecessary for this release.

## API and handoff contract

Use plain Fastify and shared request/response schemas in `packages/shared/src/workshop-api.ts`.
Expose project routes under `/api/workshop/projects` and the page at `/workshop/:projectId`.
Register the routes through the existing module/host composition, not a second server.

| Operation               | Required behavior                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Create/list/get project | Admin check in server code, owner scoping, bounded title/request/context, idempotency key on creation; no build job.                |
| Read feed               | Ordered cursor pagination, owner-scoped artifact links and structured errors. List/detail share one status projection.              |
| Send message            | Stable client message ID, persisted before acknowledgement, delivery status returned. Answer references an outstanding question ID. |
| Prepare/revise plan     | Uses current requirements and contract, records input context version; late output cannot overwrite a newer revision.               |
| Approve and start       | Expected revision ID and artifact hashes; atomic approval and execution intent. Duplicate request returns the existing attempt.     |
| Stop attempt            | Persist cancellation intent immediately; prevent further work/installation and interrupt the exact active process.                  |
| Retry attempt           | Same project and approved revision, new attempt identity; preserve failure evidence and last usable version.                        |
| Finish privately        | Expected verified candidate hash; owner acceptance without changing module availability.                                            |
| Share module            | Explicit owner/admin action against the finished version; never shares project/feed/data.                                           |
| Remove/purge            | Existing lifecycle semantics, scoped cleanup of this module and its attempts; no orphan process or queue work.                      |

Queue publication must recover from a crash between the database commit and job send. Reconcile
durable execution intent and reuse singleton job keys; do not rely on enqueue succeeding once.
Payloads contain only actor/project/revision/attempt IDs and small command metadata. Resolve
private content in the actor’s scoped context when executing.

Replace `workshop.buildModule`’s start semantics with a project-creation service used by both UI
and Moss. Its structured result returns the project ID and internal destination. If compatibility
requires keeping the old tool name temporarily, it delegates to that same create-only operation;
it cannot retain a parallel automatic-build path. The browser follows the trusted structured
destination, not a link invented by the model. Carry the relevant user request and already-settled
decisions once. Incognito/private source content requires the normal explicit persistence rules;
never silently copy an incognito chat into a durable project.

## Assistant and models

The Workshop assistant has project-specific instructions and a scoped tool set. Its job is to
clarify useful requirements, assess feasibility, prepare and revise the plan, explain observed
work, deliver questions, and help the owner try and refine the output. It must not behave like
general Moss with an extra build button. Use the role text in the assessment as the starting point.

Context passed to every turn includes relevant conversation, agreed requirements, current
revision, open questions, selected artifact references, recent verified events, and the installed
custom-module contract. Summaries retain unresolved decisions and approvals. Retrieved examples
and generated files are task data, not authority to expand the assistant’s permissions.

| Phase                                                             | Model selection                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| Discovery, ordinary questions, coding and progress explanations   | Interactive tier by default.                         |
| Specification and implementation-plan creation/revision           | Reasoning tier.                                      |
| Validation, tests, installation, lease/cancel/retry, finish/share | Host operations; models cannot assert their success. |

Reuse `resolveModelForService` and existing binding/pin precedence. Supply the appropriate tier
and required capability; do not accept its unbound economy default accidentally. An admin-enforced pin
must not be silently overridden. If a pin, service binding, or unavailable route cannot satisfy
required reasoning work, retain the project and report configuration needed before planning.
Do not claim a reasoning route from a UI label alone or silently fall back outside routing policy.

The recovery destination is **Settings → Administration → AI providers**,
`/settings?section=aiproviders`. Its current Services group lists Chat & briefing and Email
extraction, not Workshop. Add a **Workshop planning** row using the existing `ServiceRow` control,
bound to `module.workshop.plan`, defaulting to reasoning and requiring JSON capability. The current
`module.moss.workshop-build-plan` key does not name the installed Workshop namespace; the binding
route validates installed module IDs. Use the new key consistently in planner, UI, contract, and
app map; migrate an existing legacy binding through the AI-owned API, preserving an explicit new
binding if both exist. Do not loosen installed-module validation.

The existing admin binding API accepts this key via
`PUT /api/ai/services/module.workshop.plan/binding` and returns it from
`GET /api/ai/service-bindings`. “No new settings screen” permits this additional row in the existing
screen. A conflicting account pin uses the same page’s **Chat lock (this account)** control;
explain that it must be unlocked or changed to satisfy planning rather than silently bypassing it.
The recovery test must save the route there and successfully retry the same project. No capable
model at the provider is a real configuration requirement, not something a new label can solve.

Propagate the resolved provider model ID into `EngineLaunchOpts.model`, not just provider kind.
The current launcher already supports that field, but Workshop drops it. An unresolved CLI
`default` sentinel is not evidence of which model executed; record actual provider/model when
available and state when unavailable. Reasoning work requires an adapter that can honor that
selection. Record requested role, resolution reason, and execution identity in owner diagnostics.

Persist the project across phase/model changes. A process may restart with the current context;
the user does not have to repeat it. Unsupported adapter capabilities must produce a useful
availability error before dispatch, not a hidden wait for terminal readiness.

## Supervision, events, and recovery

Project phase covers discovery, planning, review, building, checking, draft review, and finished.
Execution health independently covers queued, working, waiting for answer, recovering, failed,
stopping, and stopped. Attention names the actual answer/approval/review/recovery action required.
The server computes the dashboard and detail projection from these facts.

Maintain worker liveness separately from observed productive activity. A stale lease cannot be
shown as Working merely because pg-boss still calls a job active. Preserve the existing heartbeat
cadence initially and mark liveness stale after four missed intervals, as #2023 specifies. An
alive process without new work reports its last observed activity; do not fabricate progress.
Timeouts and retry limits are bounded internal policy, with scheduled retries shown truthfully.

Use a structured attempt-scoped channel for `message`, `question`, `answer`, `steering_received`,
`phase_changed`, and completion proposals. The adapter receives only the current attempt’s
authority. The host verifies ownership, lease generation, message ID, and outstanding question.
No terminal prose or completion file can manufacture a passed check, approval, or installation.

Persist user messages before sending them. Distinguish accepted by the server from acknowledged
by the active builder. Deduplicate submissions and acknowledgements using stable IDs. A crash
after a terminal submit but before acknowledgement is ambiguous; do not promise transport-level
exactly-once delivery or blindly repeat a side-effectful instruction. Reconcile durable operation
results, or pause and resume safely with the message history. Host mutations are idempotent.

A build question pauses the relevant decision path and presents the question in conversation.
Answering continues the same attempt. New steering can arrive while working. If it changes the
approved scope, data authority, or reviewed UI, stop at a safe boundary and create a revision for
review; a chat message is not implicit approval of newly generated artifacts.

**Stop** first records intent and shows Stopping. Cancel actionable queue work, interrupt and then
terminate the attempt’s exact process tree if needed, and release resources idempotently. Only
confirmed teardown changes it to Stopped. Completion and installation recheck cancellation and
lease identity immediately before publishing a candidate, so a late process cannot resurrect it.

On restart, reconcile the lease, real process identity, and queued work. Fence the previous run
before creating another; replay only safe work from durable state. Never start overlapping agents
for one attempt. Missing acknowledgement or repeated failed recovery becomes a useful failed state,
not endless Building. Notify the owner through existing notification ports on question, failure,
or draft readiness with a project link and no private content in notification payload metadata.

## Module contract and verification boundary

Create one versioned, machine-readable contract alongside the existing SDK/validator declarations,
with the human guide as its documentation. Planning and generation receive that same contract.
The package validator remains canonical; do not relax it for Workshop or maintain a copied list
of manifest fields in the assistant prompt.

Every revision states purpose, behavior, data/storage, external services and credentials, schedules,
tools and permissions, UI states, lifecycle, and acceptance examples. Feasibility checks must reject
unsupported capabilities before approval. For the first proof, custom SQL is unavailable even
though the JSON type can describe owned tables; the current draft installer does not provision them.

Required host checks before publishing a draft:

1. Manifest and supported SDK/ABI validation, module ID/path ownership, dependency and capability
   declarations, and compatibility with the current contract version.
2. Type/bundle checks plus meaningful generated tests executed by the host. The existing bundle
   script does not run those tests, and optional `testsPassing` is not adequate evidence.
3. Executable acceptance checks through the installed UI and any declared tools, with the actual
   candidate hash attached. A route arrival or nonempty page alone is insufficient.
4. Private storage, cross-owner access, export/removal/purge, and version-update checks applicable
   to the declared data. Neither other admins nor other projects inherit access.
5. Truthful app-map feature/navigation/settings/error/remediation metadata. Extend the supported
   custom contract and runtime refresh path as necessary; ignored JSON keys are not coverage.

The host owns test execution and evidence, not the builder’s completion marker. Evidence records
the candidate hash, contract version, check identities, results, and bounded failure details.
Only verified evidence permits candidate promotion. User acceptance is a separate finish action.

Builder filesystem/process confinement is an implementation prerequisite. Limit writes to the
attempt workspace, give read access only to required SDK/examples, expose no host credentials or
deployment authority, and bound child processes/network/resources. Reuse existing adapter tooling
within an enforced execution boundary; permission prompts and persona text do not provide one.
Resolve the mechanism **before** dispatching builder implementation. A dedicated execution-boundary
spec must inventory the production image/user, mounts, capabilities, seccomp/user-namespace policy,
provider-auth conduit, permitted network destinations, process-group teardown, and resource limits.
Production currently runs API, worker, and CLI runner inside the same `jarv1s` Compose service; a
separate worker container or usable nested user-namespace sandbox cannot be assumed. Check dev and
production capabilities, choose one mechanism, and record a reproducible escape-denial/teardown
proof in that deployment shape. Do not grant privileged mode or the Docker socket as a shortcut.
Fail closed where required confinement is unavailable. Include required image/Compose/env changes
in dev and production with that capability, in the same PR. This prerequisite is unresolved here;
the review does not constitute a deployment feasibility test.

Likewise, the current scrubbed Node subprocess and web ABI are not proof of a hostile-code sandbox.
Document and test the actual worker/browser trust boundaries. Host-mediated capabilities must be
enforced where promised; direct filesystem/network escape cannot be dismissed by a prompt rule.
Do not declare arbitrary untrusted modules safely confined without implementing and testing that
boundary. This release is admin-authored local modules, not an untrusted module marketplace.

Plan mockups must be host-rendered declarative content or isolated inert previews. Never execute
model-produced HTML/JavaScript in the authenticated app just to review a design. The installed
draft uses the supported module loader/ABI with visible loading and contract errors; the current
silent empty render is insufficient. Preview and installed-module security checks are separate.

For the first release, choose the inert-preview option: **MockupV1 is an artifact manifest, not a
new UI language**. It contains `revisionId` and 1–16 screens, each with a stable `id`, `title`,
`state` (`default`, `empty`, `loading`, `error`), plain-text `description`, and 1–2 image references
for desktop/mobile. Each reference contains only a server-issued artifact ID, SHA-256, decoded
width/height, and alt text. Allow PNG/WebP only; no remote URLs, SVG, HTML, CSS, scripts, or arbitrary
component names. Cap decoded images at 4096×4096 and 8 MiB; the host must decode/re-encode them
before accepting the artifacts.
Approval covers the exact manifest and image hashes. Reject references outside this project or
revision. Display images in the existing image/figure surface with host-rendered screen/state
navigation and text. No new mockup execution runtime or general component renderer is needed.

The confined planning/render task can produce layout-only sketches using the installed UI
primitives, then capture raster images before returning them. It may not install a module or
execute those sketches in the authenticated user page. Its browser/capture dependency and offline
asset availability belong in the execution-boundary deployment spec. If capture fails, planning
shows a preview error with retry; it cannot offer approval of a nonexistent visual artifact.

## Draft, finish, and sharing

Build each candidate in a separate attempt directory. Preserve the last usable draft and last
finished version while refining. Verification happens before an atomic candidate pointer change;
failure or cancellation keeps the previous version and data available. No destructive schema/data
change is hidden inside a refinement. Unsupported migrations require an explicit future capability.

Finishing records the owner’s acceptance of a verified version and makes it usable privately in
normal navigation. Preserve ownership independently of `draft` status in registry queries,
web/worker access checks, app-map reads, and removal paths. Do not clear `owner_user_id` to finish.
All consumers that currently equate enabled with everyone must be updated together.

Concrete consumer checklist (baseline `cd0468307`; re-run discovery when implementing):

| Boundary                          | Consumers that must agree on owner and selected version                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence and constraints       | `packages/settings/src/repository-external-modules.ts`; new migrations replacing the semantics of `0187_external_modules_draft_owner.sql`, `0188_list_active_external_module_users_draft.sql`, and `0199_external_modules_worker_draft_write.sql`. In particular, the current CHECK forbids an enabled row with an owner. |
| Reconciliation and distribution   | `packages/module-registry/src/external/reconcile.ts`, `external/types.ts`, `external/install-draft.ts`; `apps/api/src/module-distribution-port.ts`; module reconciliation/install scripts. Preserve hash verification and private/published artifact pointers on restart.                                                 |
| API visibility, tools, and assets | `apps/api/src/external-module-tools.ts`, `external-module-web-route.ts`, `external-module-jobs.ts`, `module-dto.ts`; `packages/module-registry/src/route-guard.ts`. Owner-only draft/finished assets and queues must not become globally reachable.                                                                       |
| Worker execution                  | `apps/worker/src/external-module-invoke.ts`, `external-module-job-handler.ts`, `worker-module-gate.ts`, `external-module-discovery.ts`, and worker composition. Active-user SQL includes draft owners, but the verified invoker currently rejects draft status.                                                           |
| Settings, navigation, and app map | `packages/settings/src/routes-modules.ts`, `routes-serializers.ts`, `app-map.ts`; `apps/web/src/app.tsx`, `external-modules/loader.ts`; Workshop manifest and `packages/shared/src/app-map-core.ts`. Serializers currently derive everyone/you from draft status.                                                         |
| Export and removal                | Settings-owned module routes/repository and `data-export-queries.ts`, plus project cleanup. Keep user KV export/purge and installed-artifact cleanup consistent with the selected module version.                                                                                                                         |

The table is a mandatory impact checklist, not an instruction to copy owner filters into every
file. Resolve authorization and version selection centrally through the owning module’s public
API; update consumers to use it. Include denial and restart tests for every access boundary.

Sharing publishes the explicitly accepted finished version to everyone in the instance, without
granting others access to the project, its source/attempts, or the author’s saved words. Each user
gets their own host-scoped data. An update to an already shared module is built privately and
requires a separate explicit publication of that verified version; finishing a refinement must
not silently replace everyone’s running version.

Removal/purge must distinguish installed module data from project history and clearly state what
is removed. Reuse supported lifecycle behavior and add project/run cleanup to it. Never purge a
different owner’s objects or leave queued work able to recreate a removed module.

## Screens and remaining states

Implement the approved prototype with actual React components and the authored `jds-*` primitives;
do not transplant the prototype script. The review tooling, canned replies, single-project memory,
and simulated completion controls never ship. Keep the generated module’s visual revision tied to
the plan; the running draft must match it or return for revision review.

Complete existing design-system states around that layout: initial loading, failed list/detail
fetch with retry, pending create/approve/stop, send failure retaining text, disconnected/stale data,
superseded approval, unavailable capability/model, failed preview/load, and empty saved words.
Do not render a failed query as an empty project list. On reconnect, reload server state before
re-enabling state-changing controls. Errors explain the failed action and useful next step.

Keep visible keyboard focus, labeled inputs, native dialog behavior, accessible status messages,
and responsive layout at 320/375/414/768 pixels. Announce meaningful changes, not every heartbeat.
Do not move a typing user’s focus when background events arrive. Mobile view switches preserve
conversation and unsent text. Restore project state from the server on refresh/revisit.

The approved prototype already covers empty Workshop, question, failed check, stopped build,
model unavailable, draft, and finish/share, in addition to the happy path. It does **not** yet
show all fetch, mutation, reconnect, preview, and storage failure states listed above. Add a
supplementary state sheet before UI implementation and obtain review of those additions; do not
reinterpret approval of the original prototype as approval of unseen screens.

Name the authored primitives in that sheet: `Button`/`ButtonLink` for actions, `Card` for reviewed
artifacts and recovery panels, `EmptyState` for empty collections, existing `jds-field`,
`jds-label`, `jds-input`, `jds-textarea`, `jds-hint` for forms and retained-text errors, and native
dialog behavior with the established dialog styling for share confirmation. Pending buttons use
the current component’s supported disabled/pending pattern. Module CSS remains layout-only;
add any genuinely missing visual primitive in the host styles first. A count or ratio of class
names in a disposable prototype does not establish production design-system compliance.

## Delivery sequence and source seams

The five rows below are **workstreams, not session-sized tasks**. The task breakdown after them
supersedes the earlier instruction to assign each row to one session. Complete the combined live
proof before calling Workshop functional. GitHub remains the status authority; child issues have
not been created by this document.

| Slice                               | Main responsibility and current source seams                                                                                                                                                                                      | Exit evidence                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Durable project and approval     | Workshop routes/repository/manifest; `packages/shared/src/workshop-api.ts`; existing `packages/settings/src/module-builds-repository.ts`; replace create/start wiring in `packages/chat/src/module-build-start-impl.ts`.          | Owner isolation, idempotent handoff, restart-safe conversation, immutable revisions, stale approval rejection, active-owner exclusion.      |
| 2. Assistant, planning, and mockups | `packages/ai/src/module-build/write-plan.ts`, `packages/ai/src/repository.ts`, `packages/chat/src/live/types.ts` and `cli-launch-commands.ts`; project-scoped orchestration.                                                      | Real interactive/reasoning execution, context continuity, exact model propagation, contract feasibility, safe mockup rendering.             |
| 3. Supervised execution and proof   | `apps/worker/src/module-build-live-agent.ts`, `module-build-step-runner.ts`, `worker.ts`; `packages/jobs/src/module-build-jobs.ts`; `packages/ai/src/module-build/run-build-step.ts`; generated-module build/validator/installer. | Questions and steering reach the right run; enforced builder boundary; stop/restart/fencing; host-run checks; real candidate with evidence. |
| 4. Usable drafts and lifecycle      | `packages/module-registry/src/external/install-draft.ts`; `packages/settings/src/repository-external-modules.ts` and `routes-modules.ts`; web loader/navigation and registry authorization consumers.                             | Failed refinement preserves old version; private finish; explicit shared-version publication; data isolation and purge.                     |
| 5. Approved UI and complete journey | `packages/workshop/src/web/*`, `apps/web/src/app.tsx`, shared API client, module/core app-map declarations.                                                                                                                       | Both entry points and all reviewed states wired to real services; complete live proof below.                                                |

Bounded task breakdown, in dependency order within each workstream:

| Task | Owned scope and exit                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | Execution-boundary design only: inspect exact dev/prod deployment, select the mechanism, and record confinement/teardown evidence in its own spec. No builder coding until settled. |
| P1   | Supplementary UI state sheet and MockupV1 review, including pending saved-word writes and configuration recovery. No production UI coding until reviewed.                           |
| P2   | Owner-draft invocation integration and installed KV round trip: shared verified invoker, its authorization tests, and the minimal isolated draft fixture.                           |
| D1   | Workshop project table/RLS and create/get/list public repository operations.                                                                                                        |
| D2   | Ordered project feed persistence/cursors and client-message deduplication.                                                                                                          |
| D3   | Settings-owned execution-record migration and public expected-state/revision/lease API.                                                                                             |
| D4   | Immutable revisions, atomic approval, and active-owner exclusion using those public APIs.                                                                                           |
| D5   | Create-only UI/Moss service wiring and durable enqueue reconciliation.                                                                                                              |
| M1   | Planning service key, existing settings row/recovery path, binding migration, and routing tests.                                                                                    |
| M2   | Exact model-ID propagation through launcher adapters and execution diagnostics.                                                                                                     |
| M3   | Project persona/context assembly and planning generation bound to input-context version.                                                                                            |
| M4   | MockupV1 validation, owner artifact serving, and inert screen viewer. Confined capture implementation depends on P0.                                                                |
| R1   | Implement P0's execution boundary and corresponding dev/prod image/Compose configuration as one capability change. Re-split by the chosen mechanism if this exceeds one session.    |
| R2   | Structured question/answer and steering channel with attempt-scoped authorization and acknowledgements.                                                                             |
| R3   | Lease generation/fencing and restart reconciliation, with duplicate-dispatch races.                                                                                                 |
| R4   | Cancellation intent, exact process-tree teardown, and late-completion rejection.                                                                                                    |
| V1   | Host contract/type/test executor and candidate-hash evidence, separate from model completion.                                                                                       |
| V2   | Installed-candidate UI/tool verification and atomic verified-candidate promotion.                                                                                                   |
| L1   | Settings-owned lifecycle constraints and central owner/version-selection public API.                                                                                                |
| L2   | API/tool/asset/queue consumers of the central visibility API, with cross-owner denial tests.                                                                                        |
| L3   | Worker/reconciliation consumers and restart/hash behavior for private/published versions.                                                                                           |
| L4   | Private finish and explicit shared-version publication routes; preserve prior versions on failed refinement.                                                                        |
| L5   | Module/project removal, user-data export/purge, and attempt cleanup.                                                                                                                |
| U1   | Project list/create/detail shell and query/mutation failure states using reviewed primitives.                                                                                       |
| U2   | Conversation/revision/mockup approval and responsive view switching.                                                                                                                |
| U3   | Supervision/draft/finish/share UI, installed loader failures, and supported app-map metadata/refresh. Split custom metadata platform work into its own task if needed.              |
| T1   | Positive real-model Word of the Day creation and refinement journey through Moss.                                                                                                   |
| T2   | Negative/restart/cancellation/isolation proof and final resource cleanup.                                                                                                           |

Each issue owns only its listed slice of the named workstream files and its targeted checks.
Read dependencies before assignment; do not assign speculative parallel work across a shared
interface. If a task cannot finish in one context window, split it before execution instead of
relaying a partially designed change. These are task boundaries, not an assertion that every item
has a measured duration. Keep each product PR’s app-map changes and release note with that change.

Build UI alongside the relevant service slice where useful, but do not use a polished disconnected
shell as proof of progress. Module-platform prerequisites, especially confinement and app-map
support, belong in this sequence before the capability is advertised.

Existing legacy builds must remain inspectable and removable. Link them into projects where the
record provides enough context; label incomplete legacy records honestly instead of inventing
conversation or verification. Do not replay old queued builds through the new runner unchecked.
Rollout must fence/drain legacy attempts and retain installed modules and data. Do not rewrite
unrelated modules or old applied migrations to accomplish the transition.

## Acceptance and release gate

The live test must use an isolated dev instance provisioned under the repository’s verify-gate
skill. It runs the real configured model and installed module through Moss navigation. Record
bounded assertions/network/log evidence on the PR; prototype screenshots and mocked unit tests
are not the live-path evidence.

Required journey:

1. As an admin, open Workshop, create Word of the Day, answer a question, and leave/return/reload
   without losing the conversation. Separately create via Moss handoff and verify no duplicate
   project, repeated briefing, or unapproved build; double-submit the same creation operation.
2. Observe actual interactive/reasoning model routing. Revise and review the plan and visual
   mockup. Reject approval of the previous revision, including concurrent approval/revision calls.
3. Approve, receive and answer a structured build question, and send steering with visible
   acknowledgement. A scope-changing request returns to review before unauthorized work proceeds.
4. Reach a real installed draft. Assert word, definition, and example; reopening preserves the
   word for the same local date and changing the date chooses the expected next word. Check phone
   layout through executable assertions, not only route success.
5. Request saved words in that same project. Review its new plan/mockup, build, then save/reopen/
   remove a word. Prove data survives reload and another account, including another admin, cannot
   read it or the project. Force a failed refinement and show the previous draft still works.
6. Stop another attempt mid-work; verify the process exits, no successor/candidate appears, and
   reload still shows Stopped. Restart the worker during a separate attempt and observe bounded
   recovery or useful failure with no duplicate session or lost context.
7. Finish privately and verify normal navigation for the owner and denial for another account.
   Explicitly share the finished version, verify availability for that account with separate
   personal data, and prove an unshared refinement does not alter the published version.
8. Exercise unavailable model, disconnected UI, failed generation/test/install, safe retry,
   and removal/purge. End with no test module/data, active attempts, orphan processes, or jobs
   that can recreate the module; verify Moss remains healthy.

Supporting tests cover transaction races, permission boundaries, request validation, queue/send
crashes, cancellation/completion races, lease fencing, escaped/generated preview content, capability
enforcement, model-route precedence, loader errors, and data-preserving version transitions.
Run the required repository static/integration gates and keep app-map declarations truthful in
each product PR. Never run a DB-touching command outside the isolated verify-gate workflow.

### Reproducible negative cases

No prototype control, fault endpoint, or test bypass ships in production. Implement the negative
case harness in `tests/live/` against the verified isolated instance; record what is injected
separately from the positive real-model proof:

| Case                            | Concrete mechanism and assertion                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed host check               | In the test-only worker composition, wrap the checker dependency for one attempt and execute a child command that exits nonzero once. Keep generation, event persistence, installation gate, and browser real. Assert Failed, bounded stderr, no candidate promotion, then successful retry. This proves failure handling, not a naturally occurring generated-code defect. |
| Invalid package/install failure | Supply a validator fixture with a wrong ABI/hash at the candidate-verification seam in the same test-only composition; assert the actual validator rejects it before changing the usable version. No direct status-row edits.                                                                                                                                               |
| Unavailable reasoning           | Through the real admin binding/provider/model APIs on the isolated instance, make the selected reasoning route unavailable with no eligible fallback; assert configuration recovery link, restore the saved settings in `finally`, and retry that project. Test a conflicting pin separately.                                                                               |
| Worker restart                  | Verify the test instance’s Compose project/container identity, terminate only its supervisor-managed worker process, and observe supervisor restart and lease reconciliation. There is currently no standalone `worker` Compose service to restart. Never issue this command against the shared dev or production container.                                                |
| Mid-build cancellation          | Wait for the real run identity/start event, click Stop in the UI, then assert that exact process tree exits, the lease is revoked, and late completion cannot install.                                                                                                                                                                                                      |
| Browser disconnect              | Use Playwright offline mode for the project browser context, send/retain text as applicable, then reconnect; assert stale-state protection and authoritative refresh.                                                                                                                                                                                                       |
| Privacy/share                   | Use separate real authenticated browser contexts for owner, another admin, and a regular user; assert route, tool, asset, worker, and storage decisions before/after explicit share.                                                                                                                                                                                        |

The test-only worker composition is a separate harness entrypoint, not a production flag that
opens privileged failure injection. Keep the positive generation/build/install journey on normal
dependencies. If the isolated supervisor harness cannot replace the checker dependency without
changing production behavior, implement that test entrypoint before claiming these cases covered.

Every product PR includes the required **Release note** section with Category, Title, and a
plain-English Description. Documentation-only work uses `Category: N/A`. Do not mark #2023 Done
or merge the product change without recorded live-path evidence.

## Evidence behind this contract

Original source inspected in `~/Jarv1s` at `bedfb0382`; review follow-up inspected `cd0468307`.
In addition to the earlier assessment:

- `startModuleBuild` currently bypasses plan review when YOLO is active; its approval helper
  checks owner but not current revision or expected status.
- `resolveModelForService` defaults to economy and honors admin/service pins. Structured CLI
  adapters already receive model identity; the build launcher does not pass the selected ID.
- `EngineLaunchOpts.model` and provider launch flags already exist; reuse them.
- Chat drawer surface IDs may be non-UUID; the current start service explicitly drops them.
- `shipExternalModule` enables the module and clears its owner. Draft-only predicates appear
  in deletion as well, so lifecycle changes require an audit of all registry consumers.
- Issue #2023 is open and labeled RFA when read on 2026-09-04. Its older wording remains on GitHub;
  this local spec explicitly records the superseding decisions instead of claiming it was updated.
- The review follow-up executed the real manifest validator against a minimal user-scoped saved-word
  storage declaration: accepted. This is schema evidence, not installed-draft or browser proof.
- `workshop.view` currently describes “instance-wide module builds.” Replace that copy with
  owner-scoped projects in the Workshop manifest and matching app-map descriptions.

The graph service was unavailable in the original follow-up (transport closed); the earlier graph
also returned insufficient Workshop results. Bounded source reads were used. The review response
ran only the standalone validator assertion; no database or live build was exercised. The
prototype’s separate scripted checks remain recorded in its README.
