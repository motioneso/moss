# Workshop build plan

Date: 2026-09-04. Source baseline: `3798c41cf` in `~/Jarv1s`.
Parent: [#2023](https://github.com/motioneso/moss/issues/2023).
Spec: [Workshop projects and supervised builds](../specs/2026-09-04-workshop-projects-and-supervised-builds.md).
Review: [Fable findings](../../reviews/2026-09-04-workshop-spec-adversarial-review.md) and
[response](../../reviews/2026-09-04-workshop-spec-review-response.md).

Ben reports Fable agrees with the response and requests this plan. The product design is approved;
that agreement does not supply the missing confinement evidence or approve unseen UI states.
This document plans the prerequisites explicitly. It does not authorize deployment or claim a
working Workshop. No implementation, migration, or live test ran while writing it.

Execution started in an isolated worktree with Luna subagents: A0 [#2265](https://github.com/motioneso/moss/issues/2265),
A1 [#2266](https://github.com/motioneso/moss/issues/2266), A2/A3 [#2267](https://github.com/motioneso/moss/issues/2267).
See the [execution evidence](../../handoffs/2026-09-04-workshop-phase-a.md),
[boundary investigation](../specs/2026-09-04-workshop-execution-boundary.md), and
[supplementary states](../specs/assets/2026-09-04-workshop/states.html). Ben approved the
supplementary states on 2026-09-04 ("states look good"), satisfying A1's design-review gate.
Local container primitives, authenticated Claude source generation, confined worker/web compilation
and offline browser rendering passed. A fixed-operation host/systemd control fixture now also
passes denial, cancellation, controller-death deadline and restart/replay checks. Actual dev/prod
wiring, actor-scoped routing, all-provider CLI safety and application lifecycle evidence remain
outstanding; Phase A has no go decision.

## Delivery contract

Deliver the approved project workspace, with interactive conversation, reasoning-model plans and
mockups, revision-specific approval, supervised execution, verified drafts, refinement, private
completion, and explicit sharing. The release must complete the real Word of the Day journey in
the spec. The application must generate its implementation from a conversation, not recognize
that request and return a built-in example.

**Phase A is detailed below:** establish confinement feasibility, finish the state designs, and
prove the existing private-draft storage path with a small trusted fixture. It can ship the scoped
draft-invocation correction independently once its own proof passes. This is platform evidence,
not delivery of the redesigned Workshop.

**After Phase A’s go/no-go review**, expand the downstream task contracts into execution plans
against the resulting code and selected sandbox design. Their dependencies and acceptance
boundaries are listed now, but this plan deliberately does not prescribe unverified sandbox APIs,
version-storage DDL, or a full implementation before that decision. The repository’s plan-build
rule is to evaluate the first phase before planning later phases in detail.

GitHub remains the status authority. At planning time #2023 is OPEN, RFA, in Backlog, with no
milestone. Before executing each code task, create/identify its `task` issue with `Part of #2023`,
the task ID below, owned paths, dependencies, and checks. Do not dispatch the whole parent as one
build task. Creating this local plan does not create those issues or change their board state.

## Seams check

These are source capabilities, not live-test claims. The reviewed seams below did not change
between `cd0468307` and the planning baseline; other work in this shared checkout is left alone.

| Capability                               | Current evidence                                                                                                                     | Decision                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| External user storage                    | `packages/module-registry/src/external/validate.ts:533`; `packages/module-registry/src/external/worker-rpc-host.ts:443`              | Reuse declared user KV. The SDK Slice 1 rejection comment is stale.                                                               |
| Browser write path                       | `apps/api/src/external-module-jobs.ts:23`; `external-modules/finance/src/web/api.ts:99`                                              | Reuse declared manual queues with metadata-only params. Handle asynchronous completion.                                           |
| Queue limits                             | `apps/api/src/external-module-jobs.ts:10` and `:26`                                                                                  | Five-second queue/actor deduplication and per-module rate limit are real constraints, not silent save success.                    |
| Read path and write protection           | `external-modules/finance/src/web/api.ts:33`; `packages/module-registry/src/external/worker-rpc-host.ts:456`                         | Read tools supply state; read-risk calls cannot write KV.                                                                         |
| Draft-worker gap                         | `apps/worker/src/external-module-invoke.ts:161`, `:175`; `packages/settings/sql/0188_list_active_external_module_users_draft.sql:23` | Active-user SQL includes the draft owner, but the shared invoker rejects draft status. Fix/prove this in A2.                      |
| Existing draft exemption is insufficient | `apps/worker/src/worker-module-gate.ts:27`; `tests/unit/worker-module-gate.test.ts:36`                                               | Do not copy its unconditional draft/hash exemption into the verified invoker.                                                     |
| Build-record ownership                   | `packages/settings/src/index.ts:29`; `packages/settings/src/module-builds-repository.ts:62`                                          | Keep execution records and migrations in settings; extend its public API.                                                         |
| Workshop registration                    | `packages/module-registry/src/index.ts:2344`; `packages/workshop/src/manifest.ts:8`                                                  | Register project routes and Workshop-owned migrations through the existing module entry.                                          |
| Current start/approval                   | `packages/ai/src/module-build/start-build.ts:49`, `:98`                                                                              | Replace create-and-auto-build and owner-only approval with create-only handoff and revision checks.                               |
| Role-aware routing                       | `packages/ai/src/repository.ts:1224`, `:1234`                                                                                        | Supply interactive/reasoning explicitly; unbound economy is not the intended default.                                             |
| Model propagation                        | `packages/chat/src/live/types.ts:89`; `apps/worker/src/worker.ts:255`                                                                | Reuse `EngineLaunchOpts.model`; current Workshop passes only provider kind.                                                       |
| Planning configuration                   | `apps/web/src/settings/settings-ai-admin-pane.tsx:78`, `:321`; `packages/ai/src/capability-route-routes.ts:97`, `:114`               | Add an existing-control row for `module.workshop.plan`; preserve installed-module validation.                                     |
| Current builder control                  | `apps/worker/src/module-build-live-agent.ts:26`, `:139`                                                                              | Per-step launch/kill is not a durable project or a structured question channel.                                                   |
| Check evidence                           | `packages/ai/src/module-build/run-build-step.ts:13`, `:57`                                                                           | Optional `testsPassing` cannot gate promotion; host checks must.                                                                  |
| Private completion gap                   | `packages/settings/src/repository-external-modules.ts:501`, `:505`; `packages/settings/sql/0187_external_modules_draft_owner.sql:19` | Shipping clears ownership and the current CHECK forbids enabled-with-owner. New lifecycle design must update both.                |
| Production process shape                 | `infra/docker-compose.prod.yml:144`, `:151`, `:201`; `scripts/start-jarv1s.ts:7`                                                     | App/worker/CLI runner share one service and mounted data. Do not assume a worker sidecar or nested sandbox.                       |
| Isolated browser testing                 | `tests/uat/run-uat.ts:13`; `tests/uat/provisioner.ts:291`; `tests/uat/playwright.uat.config.ts:3`                                    | Reuse per-spec isolated Compose provisioning and required base URL.                                                               |
| Older live-test limitations              | `tests/live/workshop-1888-uat.spec.ts:27`; `playwright.live.config.ts:18`                                                            | Existing example is useful prior art, but defaults to shared dev and does not prove saved-word refinement. Do not run it blindly. |

### Unproven capabilities and accountable decisions

| Question                                                      | Owner and deadline                                                      | Required answer                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What execution boundary works in dev and production?          | Execution implementer, A0, before any builder task                      | Selected mechanism, image/config changes, authenticated provider transport, denied escape probes, and process teardown evidence.                         |
| What do the missing UI states look like?                      | UI implementer, A1; Ben reviews the concrete state sheet                | Fetch/send/pending/reconnect/preview/storage errors and recovery, using named primitives.                                                                |
| Does a real installed owner-only draft write and reread KV?   | Worker implementer, A2/A3                                               | Browser + real queue + worker + scoped KV + second-account denial; no localStorage or fake endpoints.                                                    |
| How do private candidate and published versions coexist?      | Lifecycle implementer, L0, after Phase A and before lifecycle migration | Exact additive DDL, artifact layout, central selection API, upgrade/rollback and consumer tests. Current single-version state is not assumed sufficient. |
| How is custom module app-map metadata declared and refreshed? | Registry implementer, C1, before generated modules are advertised       | Supported validated declaration/schema, owner visibility and dynamic refresh, not ignored JSON keys.                                                     |

Those owners are task responsibilities, not spawned agents. No user answer is needed to perform
the engineering investigations. Return to Ben only for a changed product/trust tradeoff or the
actual supplementary UI review, with the concrete result available first.

## Determinism boundary

The model has two jobs:

1. Discuss requirements and propose/revise specification, plan, mockups, and bounded questions.
2. Author and refine module source within an authorized attempt.

Job 1 uses interactive for conversation and reasoning for specification/planning. Job 2 defaults
to interactive. Neither model decides whether a command succeeded, an approval is current, a
process stopped, a test passed, data was saved, or a version was published. Those UI messages
come from durable host records. Persist an assistant reply as conversation content, separate from
the deterministic acknowledgement of the user’s message or action.

Runtime guidance budget: at most 150 words for the project role; pass the structured contract and
current project data separately rather than expanding the persona for every failure. Persona
prefixes stay byte-stable; attempt IDs and changing context belong in the turn data.

Any model proposal crossing into accepted project/user data requires field descriptions, a worked
example in its generation contract, a schema validator, and an explicit before/after revision
review. Example: adding saved words changes “stores nothing” to “owner-only saved-word IDs in
host KV,” adds save/list/remove acceptance checks, and supersedes the earlier approval. Generated
modules cannot inject turns into general Moss chat; the host handles the authorized project handoff.

## Phase A — prove the prerequisites

Run these as bounded sequential tasks in the same task checkout. Do not launch a fleet against
unsettled interfaces. UI design A1 may be developed while deployment evidence is gathered, but
shared file edits and resource-heavy checks must be coordinated rather than run concurrently.

### A0 — execution-boundary decision and deployment proof (spec P0)

**Own:** new `docs/superpowers/specs/2026-09-04-workshop-execution-boundary.md` and a small
`tests/uat/workshop-confinement-probe/` probe artifact. Read-only inputs: `Dockerfile`,
`infra/docker-compose.yml`, `infra/docker-compose.prod.yml`, `scripts/start-jarv1s.ts`,
`apps/worker/src/module-build-live-agent.ts`, and the provider launch/auth paths. Do not edit
production infrastructure in this decision task.

Inventory exact image digest/user, mounts, privileges, seccomp/user-namespace support, network
policy, provider credential delivery, process ownership, and CPU/memory/process limits. Use the
isolated UAT environment, synthetic secrets and an empty test workspace; never inspect or print
live credentials. Keep the probe small and dependency-free where possible.

Compare the options against the same evidence:

- Existing per-provider process plus an OS sandbox has the least transport change, but it only
  qualifies if the production container permits the required isolation without unsafe privileges.
- A dedicated constrained builder service separates app data and credentials more clearly, but
  requires deliberate workspace/auth transport and deployment lifecycle work.
- A remote runner can isolate the host, but adds connectivity, credential handling, and service
  operation beyond the current deployment. Use only if local options cannot meet the contract.

Do not choose a winner from appearance or familiarity. No privileged container, host Docker socket,
unrestricted app-volume mount, or raw credential dump is an acceptable shortcut. Reuse platform
deployment patterns where useful; an existing sports renderer is not proof of builder capability.

**Proof:** allowed workspace write works; sibling/core/data/synthetic-secret reads or writes are
denied as required; denied network paths stay denied; required provider execution and capture
work through the specified conduit; cancel kills the exact child tree; another run is unaffected;
resource limits terminate a deliberate runaway. Record each probe’s expected and actual outcome.
Exercise the actual production-shaped policy, not a more permissive development shell.

**Exit:** selected mechanism and deployment contract with repeatable evidence, or a written
infeasibility result naming the exact unmet requirement. If the chosen implementation cannot fit
one session, split R1 into owned transport/image/runtime tasks before scheduling it.

### A1 — supplementary state sheet (spec P1)

**Own:** new `docs/superpowers/specs/assets/2026-09-04-workshop/states.html` and, only if needed,
`states.js`; extend the existing preview CSS locally and link the sheet from its README. Keep the
approved original journey intact. Preview-only controls stay labeled and never become product code.

Show list/detail loading and fetch failure; pending create/approve/stop; failed send retaining
text; stale approval; offline/reconnect; unavailable capability/model with real settings destination;
failed mockup generation/loading; saving/removing pending, failure, deduplication, timeout, and 429.
Use `Button`, `ButtonLink`, `Card`, `EmptyState`, declared form primitives, and the current dialog
pattern. Confirm component options in `packages/ui/catalogue.json`; no invented `jds-*` classes.

Use the spec’s raster MockupV1 contract for generated-module previews. Review its host screen/state
navigation and missing-artifact behavior here. Image captures are design evidence only, not live
Workshop verification. Serve the sheet over the same restricted Tailscale preview used previously.

**Checks:** actual keyboard focus, retained unsent text, retry action, reduced motion, and no
clipped controls at 320/375/414/768 pixels. Extend the disposable preview check only for new behavior.
Request Ben’s review of this sheet after it exists; do not repeat already-settled layout questions.

**Exit:** concrete supplemental designs reviewed, with any feedback incorporated. The original
prototype approval alone does not close this task.

### A2 — verified invocation for the owner’s draft (spec P2, implementation half)

Live A3 follow-up: the invoker correction exposed a second enabled-only gate in
`packages/settings/sql/0157_module_worker_runtime_access.sql`. The real queue handler reached
`kv.set`, but its insert failed RLS. A2 therefore also owns the new settings migration
`0215_module_kv_worker_owner_draft.sql`: an additive policy for the active admin author's own
draft user storage, preserving module/actor binding and all existing enabled-module policies.
The UAT tests the real worker role for owner success and other-user/admin denial. No applied
migration is edited and no shared database receives this change during the isolated proof.

**Own:** `apps/worker/src/external-module-invoke.ts`, a focused new
`tests/unit/external-module-draft-invoke.test.ts`, and
`tests/integration/module-worker-queue-ai.test.ts` for the assembled actor/queue path. Audit callers
before changing the shared gate: queue handler and briefing invocation must preserve their own
constraints. Do not fix only a Workshop caller or replace KV/queue infrastructure.

Preserve the existing exported `VerifiedInvoke` signature. Read the owner in the verified state
lookup and accept a draft only for that exact actor, with active-user membership and exact
manifest/package hashes. Retain enabled behavior. Reject disabled, missing, wrong-owner,
undiscovered, and stale-hash cases before constructing the RPC handler or launching runtime code.
Do not import another module’s private repository. Use the current platform composition/public
settings seam; keep this a correction of an existing advertised owner-draft contract.

**Behavioral tests and failure reasons:** owner draft with matching hashes reaches the runtime
(currently fails at `not-enabled`); another admin/regular user cannot execute it; stale hash fails
even for the owner (catches copying the permissive draft gate); revoked/disabled state fails;
read-risk invocation still cannot mutate storage; enabled modules retain current behavior.
Assert effects and denials, not private helper call ordering beyond “no runtime on denial.”

**Exit:** targeted tests and isolated integration checks pass. This is not yet browser proof.

### A3 — installed private-draft storage proof (spec P2, live half)

**Own:** `tests/uat/specs/workshop-storage.uat.spec.ts`, a tiny trusted fixture under
`tests/uat/fixtures/workshop-word/`, and the minimum fixture-install hook in the existing UAT
provisioning path. Reuse `tests/uat/specs/module-install.uat.spec.ts` and Finance’s queue/read
contracts. Do not add a new deployment orchestrator or hardcode a fixture into Workshop product code.

The fixture has one daily word page, one declared user namespace, read-only saved-word tool,
and declared manual save/remove handlers. Queue params carry only bounded IDs/operation metadata.
Handlers are idempotent; the page waits for confirmed state and handles current queue limits.
Disable conflicting gestures while a mutation is outstanding. Prove retry/deduplication cannot
resurrect a removed word; do not hide an ordering defect by sleeping for the singleton window.

Install it as an owner-only draft through the real supported installer in the test harness.
Exercise through browser navigation: save, confirmed reread, reload, list, remove, reload; repeat
with another authenticated admin and user to prove denial. Verify the real queue/runtime/KV path,
not intercepted requests or a fixture answering the API itself. Restart the isolated worker and
repeat a read. Purge only the fixture and assert zero leftover data/jobs/processes.

**Exit:** recorded live browser/queue/storage assertions on the isolated instance. Existing UI
copy/app-map changes and the PR release note accompany any user-visible correction. No test result
from A3 may be described as a successful generated Workshop project.

### Phase A go/no-go

Ben owns the decision using the recorded evidence; the implementing agent recommends it.

- Continue only if confinement is feasible in the required deployment, the state sheet is reviewed,
  and the installed owner-draft storage path passes with isolation and cleanup.
- Stop this implementation line if it requires privileged host access, silently weakened ownership,
  unbounded new infrastructure, or a different module authoring contract merely to make the simple
  example work. Bring the concrete limitation and smallest alternatives to Ben.
- A failed isolated test is first a bounded diagnosis task, not automatic permission for a platform
  rewrite. Two identical failed approaches trigger re-evaluation, not a retry loop.

Only after this checkpoint should later phase plans fix their final DDL and runtime signatures.

### Concrete decision after the local proofs

**Approved by Ben in chat: limited capability implementation, not a full Phase A go.** A1's
state review and A3's storage proof passed. A0 now has local source-only worker/web/browser and
host-controlled lifecycle evidence. Completing actual app routing, hardened CLI launch and dev/prod
composition requires the R1 production code whose dispatch the current gate withholds.

The approved authorization is R1a–R1d plus M1/M2, in
bounded task plans with one accountable owner per shared file. Start with R1b's source-generation
launch policy; keep the existing provider scope and ordinary chat behavior. Keep Workshop's new
execution path unavailable until the assembled capability's routing, isolation, cancellation and
real dev/prod checks pass. Do not dispatch downstream Workshop UI/lifecycle/promotion work, install
host services, deploy, merge or declare the complete Phase A gate passed under this authorization.
R1e and its durable attempt/dispatch dependencies remain gated as well. Those retain their existing design, live-path and release gates.

Ben replied "approve" after reviewing the summary and pros/cons. Proceed with this limited scope
without asking for the same permission again. Actual deployment, enabling new Workshop execution,
R1e and downstream delivery retain their separate gates.

### R1-owned capability tasks for Phase A review

First R1b implementation task: [#2276](https://github.com/motioneso/moss/issues/2276), shared
structured-generation cancellation handling. Owned code is the AI structured entry, CLI adapter
and their existing tests. This task rejects late results and preserves non-cancellation recovery;
it does not complete the provider launch-isolation contract or enable Workshop execution.

Second R1b task: [#2277](https://github.com/motioneso/moss/issues/2277), explicit source-generation
intent, a dedicated narrow RPC operation and the demonstrated Claude launch policy. Implemented
locally with targeted checks; the authenticated Claude adapter/RPC/runner/engine composition also
passed a private fixture. Installed user-hook exclusion, the real engine wall deadline, and
actual `createCliRunner` generation/cancellation also pass. Codex still advertises native tools
under the candidate policy; a passing negative control confirms an image-read attempt reaches
the filesystem helper and is denied by this container. The shared source dispatch now rejects
empty/default selectors and provider-record identity mismatches before credential/adapter access. Actor isolation, full deployment wiring and other-provider policy proofs remain
open. Older runners and routes without a demonstrated policy fail unavailable,
without falling back to an ordinary launch. The handoff records exact current evidence.

R1a/M2 is now tracked by [#2288](https://github.com/motioneso/moss/issues/2288). The local worker
composition uses capability-routed source data and rejects execution before provider access until
isolated runtime acceptance is available. The interactive writer and host compile/install path
are removed. 59 targeted tests, root TypeScript and scoped lint pass; actor-bound live routing,
CLI credential provenance and execution acceptance remain unproved. See the compact
[live state](../../handoffs/workshop-live-state.md) for files, evidence and next work.

R1c is tracked by [#2289](https://github.com/motioneso/moss/issues/2289). Its local public image,
fixed offline recipes, separate resource profiles and disposable proof pass; see
[`infra/workshop/README.md`](../../../infra/workshop/README.md) for exact image/tool identities,
limits and evidence. This completes local image proof, not deployment acceptance. R1d continuation
is tracked by [#2293](https://github.com/motioneso/moss/issues/2293); its detailed task remains local.

These are bounded ownership and acceptance contracts for the
[source-only deployment candidate](../specs/2026-09-04-workshop-execution-boundary.md#source-only-deployment-contract-for-phase-a-review).
They split the original R1 responsibility. The limited approval above permits R1a–R1d and M1/M2
before a full Phase A go; R1e and downstream rows retain `A0, A` as prerequisites. A0 may continue its isolated feasibility
investigation before `A`; it must select and prove the deployment control mechanism rather than
requiring an already completed R1 implementation to pass Phase A. Final assembled-product proof
remains with T1/T2.

| Task                                   | Owner and scope                                                                                                                                                                                                                                                                                                                                                                                                      | Required exit evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1a — trusted source generation        | AI/worker integrator. Reuse `packages/ai/src/structured/generate-structured.ts` and its public composition seam; replace the Workshop live-agent source-writing path in `apps/worker/src/module-build-live-agent.ts` and its `worker.ts` wiring. Coordinate shared edits with M2, which owns concrete model propagation, and M1, which owns planning configuration.                                                  | Real actor-scoped routing reaches the configured concrete model with interactive/reasoning role and pin precedence preserved. Two actors cannot borrow credentials, context or results. Unavailable/conflicting routes fail before execution. Schema-checked source and bounded diagnostic feedback cross the boundary; no generated source runs on the trusted side.                                                                                                                                       |
| R1b — CLI source-only safety           | Chat/CLI integrator. Own the source-generation launch policy in `packages/chat/src/live/cli-structured-adapter.ts`, provider engines under `packages/chat/src/live/`, and `packages/cli-runner/src/` composition where required. Reuse existing one-shot engines; do not apply a tool-less policy to normal interactive chat.                                                                                        | For Claude, Codex and Gemini, installed-version evidence covers native tools, hostile ambient MCP/hooks/settings, isolated per-call state, credential hygiene and model selection. Abort/timeout cannot produce an accepted late result; unrelated sessions survive cleanup. Test actual runner composition, not just direct CLI invocation. Preserve all-provider scope; a route without a demonstrated policy remains unavailable rather than silently falling back.                                      |
| R1c — public build/render image        | Runtime image implementer. Own proposed `infra/workshop/Dockerfile` and fixed recipes beside it under proposed `infra/workshop/`; reuse `scripts/build-external-module.ts` semantics and public SDK/UI contract. New locations are proposals, not existing files.                                                                                                                                                    | Reproducible pinned release image includes only necessary public toolchain/runtime assets. Real worker/web/tests/browser work offline with the final limits; malformed input, filesystem/network escape, output flooding and runaway resource cases fail safely. Export validated source/bundles/raster data only. Full host acceptance and promotion remain V1/V2 responsibilities.                                                                                                                        |
| R1d — deployment control and transport | Deployment implementer. Own the A0-selected controller/install files, `infra/docker-compose.yml`, `infra/docker-compose.prod.yml` and affected env/release wiring. A0 proposes `infra/host/workshop-control.py` and `infra/host/install-workshop-unit.sh` using the existing host/systemd control pattern; finalize the installation contract before dispatch. Consume R1c image and agree the caller seam with R1a. | Both deployment shapes use the selected fixed-operation control path without privileged mode or a mounted Docker socket. Caller/source cannot choose host paths, commands, mounts or limits. Fresh unit per attempt; unauthorized/cross-owner launch/stop denied; wall/output limits and cleanup survive controller loss; second attempt and app unaffected. Unavailable control fails closed, while the rest of Moss starts normally. Include compatible dev/prod configuration in the same capability PR. |
| R1e — attempt execution adapter        | Worker integrator. Own transport integration in `apps/worker/src/module-build-step-runner.ts` and the R1 runtime adapter after D3/D5b and R1a–R1d. Consume settings-owned authority APIs; do not add a second attempt repository. Coordinate worker composition edits with R1a.                                                                                                                                      | Owner/revision/attempt/lease/source hash bind every dispatch and result. Duplicate delivery starts at most one unit; superseded/aborted/expired results are discarded before any side effect. Export uses bounded validation and staging on the module filesystem. Runtime provides idempotent stop/status/absence evidence; R3 owns durable restart fencing and R4 owns stopping/stopped and cancel-versus-complete tests.                                                                                 |

R1 is complete only when all five rows pass together; rows cannot independently enable Workshop
execution. R1c may proceed independently of trusted generation after Phase A approval. R1d follows
the selected A0 mechanism and R1c; R1e additionally needs the durable attempt/dispatch APIs. Do not
parallel-edit shared AI/worker composition files. No migration numbers or final API signatures are
reserved here.

The current `generateStructured()` implementation routes with JSON capability and `tierHint`,
then forwards the concrete provider model ID. That is a reuse seam, not actor-routing evidence:
the authenticated A0 helper bypassed it. Its validated return also does not establish current
attempt authority. R1a/R1b verify adapter cancellation, while R1e/R3/R4 fence execution and side
effects independently of adapter behavior. M2 should prove the surviving launch path, not preserve
the old interactive tmux writer merely to populate `EngineLaunchOpts.model`.

Before dispatch, create/link each approved task under #2023 with these ownership boundaries,
dependencies, targeted checks and required live evidence. Product behavior/errors update the
owning app-map metadata in that same PR. No GitHub task creation, closure or approval is implied
by these local contracts.

## Contracts preserved for downstream planning

These are cross-task decisions, not implementation bodies. Exact storage DDL and newly exported
signatures are finalized by their owning task plan after Phase A; do not reserve migration numbers
now in a shared repository.

| Contract          | Required invariant                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project creation  | `(actor, idempotencyKey)` identifies one durable result. Returns project ID and trusted internal destination. No approval or execution implied.                                 |
| Ordered feed      | Cursor is server-issued; client message IDs deduplicate acceptance. Persist first, then acknowledge; delivery-to-builder is a separate recorded acknowledgement.                |
| Revisions         | Immutable spec/plan/MockupV1 and hashes; generation input version prevents stale output replacing current work.                                                                 |
| Approval          | Owner + expected current revision/hashes; compare-and-set transition. Duplicate approval returns the same attempt, stale approval cannot start one.                             |
| Execution record  | Settings-owned public API; project/revision IDs are opaque cross-module references. Lease generation fences side effects, not just status writes.                               |
| Owner concurrency | One active planning/build execution per owner across projects; enforce atomically in owning persistence. Saved projects are not restricted to one.                              |
| Queue dispatch    | Metadata-only payload; durable intent and singleton dispatch recover a crash before/after enqueue without a second agent.                                                       |
| Runtime channel   | Run identity, message ID, kind, and validated payload. Completion proposal is not host verification. Ambiguous terminal delivery is reconciled or paused, not blindly replayed. |
| Models            | Interactive default; reasoning spec/plan; preserve pins/policy and context, propagate concrete provider model ID, and expose unavailable routing honestly.                      |
| Stop              | Persist intent → invalidate work → tear down exact process tree → confirm stopped. Late completion cannot install.                                                              |
| Verification      | Host check records bind candidate hash and contract version to actual results. Every failed check preserves the previous usable version.                                        |
| Lifecycle         | Project owner is independent of draft status. Candidate/private-finished/published pointers are distinct; private finish cannot publish an update.                              |
| Preview           | Raster MockupV1 only, actor-scoped artifact IDs and hash approval; no generated script in authenticated app.                                                                    |

## Downstream dependency map

This is the full remaining scope map, not approval to execute unresolved tasks. Each row becomes
a small task plan/issue after Phase A. `A` means Phase A’s go/no-go passed. Source paths below are
ownership boundaries; parenthetical new filenames are proposed rather than claimed to exist.

| Task | Depends on             | Owned files/responsibility                                                                                          | Required exit evidence                                                                                                                                |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | A                      | New `packages/workshop/src/projects-repository.ts`, Workshop SQL/manifest/registration, shared project DTOs         | Runtime-role owner RLS, idempotent create/get/list, two-owner denial.                                                                                 |
| D2   | D1                     | New `packages/workshop/src/project-feed.ts`, its SQL and cursor schemas                                             | Durable ordering, bounded pagination, duplicate-message and reconnect behavior.                                                                       |
| D3   | A                      | `packages/settings/src/module-builds-repository.ts`, public exports and settings-owned SQL                          | Expected-state/revision/lease API rejects stale writes and cannot be used cross-owner.                                                                |
| D4   | D1, D2, D3             | New `packages/workshop/src/project-revisions.ts`, approval route/schema                                             | Concurrent supersede/approve and two-project owner start have one valid winner.                                                                       |
| D5a  | D1, D2                 | `packages/chat/src/module-build-start-impl.ts`, Workshop tool/manifest and shared creation result                   | Direct entry and Moss handoff use one create-only operation; incognito rules preserved.                                                               |
| D5b  | D3, D4                 | `packages/jobs/src/module-build-jobs.ts`, owning host dispatch wiring                                               | Crash between intent and enqueue reconciles without duplicate execution.                                                                              |
| M1   | A                      | AI-owned binding migration/API; `write-plan.ts`; `settings-ai-admin-pane.tsx`; shared schemas/app map               | Configure `module.workshop.plan` in existing settings; preserve explicit choices and retry same project.                                              |
| M2   | A0, A                  | `apps/worker/src/module-build-live-agent.ts`, `worker.ts`, `packages/chat/src/live/types.ts` and launcher consumers | Selected model reaches actual launcher; unsupported/default sentinel cannot masquerade as verified reasoning.                                         |
| M3   | D2, D4, M1, M2         | Project-context orchestration in Workshop; existing structured planner                                              | Context survives phase/model changes; typed proposals and input-version checks; role guidance under 150 words.                                        |
| M4a  | A1, D4                 | MockupV1 schemas/validator, new owner artifact route and lifecycle                                                  | Invalid formats, cross-owner IDs, excessive decoded size, stale image hashes rejected.                                                                |
| R1   | A0, A; R1e also D3/D5b | R1a–R1e capability tasks above: trusted generation, CLI safety, public image, deployment control, execution adapter | All five contracts pass together in dev/prod shapes; R3/R4 retain durable recovery/stop ownership.                                                    |
| M4b  | M4a, R1                | Confined layout capture adapter and browser dependency selected by A0                                               | Real raster artifact generation; safe failure and offline asset support.                                                                              |
| R2a  | D2, D3, R1             | Attempt-scoped control channel and host tool registration                                                           | Authorized structured question/answer resumes same run; invalid run/question cannot steer it.                                                         |
| R2b  | R2a, D4                | Steering acknowledgements and revision handoff                                                                      | Accepted versus delivered visible; changed authority returns to plan review; duplicate messages have no duplicate effect.                             |
| R3   | D3, D5b, R1            | Worker lease/restart reconciliation in `module-build-step-runner.ts` and job composition                            | Stale process is fenced before another starts; lost worker never remains falsely healthy.                                                             |
| R4   | R2a, R3                | Cancellation API/runtime teardown and completion guard                                                              | Stopping is distinct from stopped; process descendants exit; cancel-versus-complete race cannot publish.                                              |
| C0   | A                      | SDK/validator-owned authoring contract and guide synchronization                                                    | Generator and host consume one versioned supported contract; unsupported SQL rejected during feasibility.                                             |
| C1   | A                      | SDK custom app-map declaration, validator, `packages/settings/src/app-map.ts` and owning runtime refresh            | Generated feature/settings/error/remediation metadata survives serialization and stays owner-scoped.                                                  |
| V1   | C0, R1, M3             | Host validator/type/test executor beside existing build-step code; `scripts/build-external-module.ts` integration   | Nonzero test/ABI/hash failures prevent promotion; model success text cannot bypass checks.                                                            |
| L0   | A                      | Lifecycle design addendum using spec’s concrete consumer inventory                                                  | Exact additive constraints/artifact pointers/public selection API and upgrade plan agreed before L1.                                                  |
| L1   | L0, D3                 | Settings registry SQL/repository and central version/visibility API                                                 | Private finish is representable; revision/version races preserve the previous finished/published pointers.                                            |
| L2   | L1                     | API resolver/tool/web-asset/queue/DTO consumers named in the spec                                                   | Every route denies other owners’ private artifacts and resolves the correct published version.                                                        |
| L3   | L1                     | Worker discovery/invoke/reconcile consumers and active-user SQL                                                     | Restart retains ownership/version/hash rules and queued work cannot cross versions.                                                                   |
| V2   | V1, R4, L1, L2, L3     | `install-draft.ts` and host verification/promotion orchestration                                                    | Installed UI/tools pass acceptance for the exact candidate; cancelled or stale attempts cannot promote; failed install keeps the last usable version. |
| L4a  | V2, L2                 | Private finish route and owner navigation                                                                           | Expected verified candidate finishes privately, with no publication side effect.                                                                      |
| L4b  | L4a, L3                | Explicit share/update-publication route                                                                             | Only an owner-authorized verified finished version changes everyone’s availability.                                                                   |
| L5   | L1, L2, L3, L4a, L4b   | Settings export/purge/removal paths and project/attempt cleanup                                                     | User KV exports; removal cannot affect another owner or be resurrected by old jobs.                                                                   |
| U1   | A1, D1, D5a            | Workshop list/create/detail shell, API client and manifest navigation                                               | Real create/handoff/query errors, retained text and mobile/keyboard behavior.                                                                         |
| U2   | U1, D2, D4, M3, M4b    | Project conversation and revision/mockup review components                                                          | Current/superseded review is server-backed; unapproved work never starts.                                                                             |
| U3a  | U2, R2a, R2b, R3, R4   | Supervision/progress/question/recovery components                                                                   | Phase, liveness and attention match durable events; no fake progress.                                                                                 |
| U3b  | U2, V2, L4a, L4b       | Draft/finish/share views, `apps/web/src/app.tsx`, loader error handling                                             | Actual private draft in the workspace; failed refinement retains prior view and data.                                                                 |
| T1   | C1, L5, U3a, U3b       | `tests/uat/specs/workshop-projects.uat.spec.ts` and `workshop-build.uat.spec.ts`                                    | Full real-model creation, handoff, revision, saved-word refinement, finish/share and cleanup.                                                         |
| T2   | T1                     | `tests/uat/specs/workshop-recovery.uat.spec.ts` and test-only fault composition                                     | Cancellation, restart, stale approval, denied actor, unavailable route, failed check/install and cleanup proof.                                       |

V1 can prove the host checker against candidate artifacts before supervision is assembled. It
does not start or promote a build; V2 depends on R4 so installation uses lease fencing and the
confirmed cancellation/completion guard.

Every task that changes a feature, setting, error, or navigation updates its matching app-map
declaration in that product PR. C1 is the custom-module metadata platform work, not permission to
leave other tasks’ app map stale. Each code task has targeted regression coverage; each shipped
user-facing slice additionally has its own observed real-UI proof. T1/T2 prove the assembled release,
not retroactive permission to ship untested earlier slices.

## Verification and evidence

Do not run these while merely approving this plan. Future-file commands become valid when the
owning task creates the files. **Expected exit for every successful check is 0.** A failure,
missing dependency, or skipped real-model run is reported as such, never relabeled passed.

For A1, scope formatting and the disposable interaction check to the artifact. For A2, run the
focused unit test and normal affected-file lint/type checks. Examples after those files exist:

```sh
pnpm exec vitest run tests/unit/external-module-draft-invoke.test.ts
pnpm exec eslint apps/worker/src/external-module-invoke.ts tests/unit/external-module-draft-invoke.test.ts --max-warnings=0
pnpm exec tsc --noEmit
pnpm check:design-tokens
pnpm check:ui-classes
```

Before any database-touching or full-gate run, read
`.claude/skills/verify-gate/SKILL.md`. Use its supported isolated procedure and coordinate the
shared database/test resources. Do not run a bare integration test, foundation gate, migration,
or live Playwright command against defaults from the shell.

```sh
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Start should return 0 for a successfully launched gate; that is not a passing gate. Run the wait
as a background/yielding tool call; its final 0 and gate sentinel establish success. No piped gate,
short polling loop, hand-created database, or global environment rewrite. The foundation gate
does not include browser proof.

For isolated browser proof, reuse the existing UAT provisioner; after the new specs exist and the
verify-gate workflow/target checks are satisfied:

```sh
pnpm test:uat workshop-storage
pnpm test:uat workshop-projects
pnpm test:uat workshop-build
pnpm test:uat workshop-recovery
```

Each invokes a new isolated stack, not the shared instance. Extend the existing fixture opt-in
pattern minimally for A3. For T1, use the repository’s real-provider credential-file conduit,
validate the configured role/model, and omit scripted `chatScript` providers. Never copy the old
live spec’s hardcoded account credentials. No provider credentials enter test artifacts or logs.
If the harness cannot support the approved provider safely, resolve that in A0/R1 rather than
quietly running the real test against production.

Port the spec’s negative-case mechanisms into the isolated UAT composition: fail one host check
using a nonzero child command; submit an invalid ABI/hash fixture at the candidate seam; disable
the selected test reasoning route without eligible fallback and restore it in `finally`; terminate
only the identified test container’s supervised worker; disconnect only the test browser context.
The positive run uses normal dependencies and real generation. Test-only injection must not be
enabled by a production flag, route, or hidden Workshop control.

Record on each product PR: source SHA, isolated target identity, test/run name, exit code, bounded
assertions and network/log evidence, cleanup result, and known limits. No screenshots for the
live-path gate. Include the required Release note section and leave #2023 open until the full
positive and negative journeys pass. Prototype screenshots remain design-review assets only.

## Rollout and rollback requirements

Keep new schema changes additive and old installed modules usable while services are assembled.
Fence/drain legacy build jobs before enabling the replacement start path; do not run two builders
or silently reinterpret an old approval. Retain inspect/remove support for legacy records even
when conversation or verification history cannot be reconstructed.

The lifecycle task must provide exact rollback compatibility before changing version selection.
Never clear owner identity or point all actors at a candidate as an intermediate deployment step.
If a capability needs new configuration, dev and production receive it together with that capability.
Do not expose the new builder UI until its backing services and the relevant live proofs are ready.

## Rulings and plan acceptance checklist

Preserve both Fable documents; this plan does not overwrite their historical findings.

- Storage rejection claim: corrected by the real validator assertion and positive source at
  `validate.ts:533`; actual integration gap is the invoker at `external-module-invoke.ts:175`.
- Settings table move: rejected as unnecessary; public export at `packages/settings/src/index.ts:29`
  supports the smaller ownership-preserving extension.
- Readiness: corrected. Confinement and missing screen review are explicit Phase A work, not implied
  completed prerequisites or implementation choices hidden in a worker task.
- Planning recovery: add the existing settings row and valid service key; respect pins and include
  a real retry test. Do not invent a new settings application.
- Five large slices: replaced by bounded owned tasks. Downstream detail waits for the Phase A result.
- Deterministic feedback, host verification, private finish and separate publication are mandatory.

Before code dispatch, verify: task issue open; applicable design approved; Phase A or prerequisite
exits recorded; owning task plan has exact changed files/contracts and unpiped checks; no collision
with active work; one-session scope; and a real caller plus live proof for every user-facing change.
Use one isolated task worktree at execution time and the shared-checkout skill for commits. Do not
switch this shared checkout, sweep other people’s files into a commit, or restart agentmemory.

Writing-time validation: reviewed current seams and the isolated test harness, checked the plan’s
dependency graph and local links, and formatted the documentation. No code tests, database changes,
live model calls, infrastructure mutation, commits, or GitHub edits are claimed by this plan.
