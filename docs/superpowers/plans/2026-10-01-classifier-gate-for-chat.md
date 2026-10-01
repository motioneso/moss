# Classifier gate for chat: implementation plan

Date: 2026-10-01. Planning branch: `plan/classifier-gate-for-chat`.
Workspace: `~/Jarv1s/.claude/worktrees/classifier-gate-plan`.

## Status and execution gates

This is a plan only. The task brief records Ben's approval in discussion of
[the spec](../specs/2026-10-01-classifier-gate-for-chat.md), superseding its stale
"Not approved" heading. Its section 5 questions remain open. This planning assignment
explicitly forbids creating an issue, pushing, or opening a PR; it overrides the
plan-build skill's issue prerequisite for this document only. Before product work,
the build coordinator must record the approval and supply a GitHub `task` issue
with its parent link. No issue number is invented here.

Use `.claude/skills/plan-build/SKILL.md`. Each numbered task below is one session,
with one bounded deliverable and its own check. Do not combine sessions to fit a
large implementation into one context. Slice 1 ships and is evaluated first;
subsequent slices are bounded work orders to revalidate against the resulting tree,
not prewritten implementation. No product code accompanies this plan.

**Release kill gate:** no tool executes through the gate until Ben has set the
shadow agreement rate and review window, reviewed that tool's evidence, and approved
its activation. Missing approval means ineligible, even if the setting says `on`.
A new classifier selection or material tool/schema change requires fresh evidence.
The marker must ship before any real activation. Turning the setting off must restore
today's path immediately for subsequent messages.

## Seams check and rulings ledger

Checked the current worktree with codebase-memory graph search, call tracing and
source reads before choosing boundaries. Graph coverage excludes parts of external
module loading, so bounded source searches filled those gaps. Agent memory returned
no matching prior classifier/platform-seam observations. The archived classifier
discussion in the Obsidian vault preserves the four unresolved decisions, not answers
to them. Citations below are from the planning checkout; recheck them at build start.

| Capability                                  | Current evidence                                                                                                                                                                                                                                                                                | Consequence for the plan                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted chat input                         | `packages/chat/src/live-routes.ts:127` validates the request; attachment lookup completes before `submitTurn` at line 178.                                                                                                                                                                      | Gate sees the accepted original text and resolved attachment metadata, not an independently parsed copy.                                                                                                                             |
| Shared turn boundary                        | `packages/chat/src/live/chat-session-manager.ts:302` takes the actor/surface turn lock and calls `runTurn` at line 327. `runTurn` installs cancellation and activity state at line 366, calls `ensureSession` at line 395, builds retrieval-enriched text at line 411, and submits at line 442. | Put the gate inside that lock, after cancellation/activity setup and before `ensureSession`. A handled message must never reach session creation, retrieval, or model submission.                                                    |
| Session launch itself can submit            | `packages/chat/src/live/chat-session-manager.ts:214` launches the engine; line 261 submits replay on one runtime path.                                                                                                                                                                          | A hook immediately before line 442 is too late. The earlier boundary is necessary even for a cold session.                                                                                                                           |
| Other entry paths                           | `packages/chat/src/live-routes.ts:418` also uses `submitTurn`; `chat-session-manager.ts:333` separately seeds context.                                                                                                                                                                          | Apply the gate to accepted user turns across surfaces. Do not treat internal context seeding as a user command. Preserve surface/control context on fallback.                                                                        |
| Classifier setting                          | `apps/web/src/settings/settings-ai-sorting-row.tsx:43` saves/deletes the reserved binding; `packages/shared/src/ai-types.ts:142` defines its key. `packages/ai/src/capability-route-routes.ts:89` reads it and line 114 admin-gates writes.                                                     | Rename public copy to Classifier without migrating the existing `sorting` storage key or breaking background consumers. Gate-state ownership is a separate unresolved decision.                                                      |
| Classifier routing                          | `packages/ai/src/repository.ts:1425` resolves the sorting model; line 1452 reads its binding and honors explicit-binding/admin-pin restrictions.                                                                                                                                                | Resolve the configured classifier inside the AI boundary, preserving existing routing restrictions. No classifier means decline; never borrow the chat default to classify.                                                          |
| Choice transport                            | `packages/ai/src/structured/generate-choices.ts:15` includes confidence and probabilities; line 75 exposes `generateChoices`; line 174 accepts an explicit resolved model.                                                                                                                      | Reuse this transport behind a capability-based router. It is not itself a universal classifier router.                                                                                                                               |
| Existing wrapper is insufficient            | `packages/ai/src/structured/ask-sorting-questions.ts:127` resolves the setting, line 211 calls `generateChoices`, line 228 drops probabilities, and line 86 defines a yes/no-only structured schema.                                                                                            | Preserve existing consumers; add the small generic choice/typed-argument contract in the AI package. Do not pretend this helper already supports tool selection and runner-up scores.                                                |
| Structured calls retry today                | `packages/ai/src/structured/generate-structured.ts:119` accepts an explicit model and line 219 applies repair retries. Its sorting fallback begins at line 173.                                                                                                                                 | Add an explicit single-attempt option for gate calls. Use the resolved classifier and caller deadline; disable repair retries and internal default-model fallback.                                                                   |
| Gateway composition                         | `packages/chat/src/routes.ts:289` constructs tokens and the gateway; line 327 constructs the runtime; line 349 captures an executable-tool allowlist when minting.                                                                                                                              | Inject the gate from this composition root, through `packages/chat/src/live/runtime.ts` and the manager ports. Do not create a second gateway or import another module's internals.                                                  |
| Existing authority path                     | `packages/ai/src/gateway/gateway.ts:185` verifies token identity, checks executable tools and allowlist, validates input, and resolves confirmation/policy. Lines 236, 291 and 336 cover YOLO, ordinary policy and confirmation.                                                                | Gate execution must call this same path. It needs a decline-without-card option and a side-effect-free shadow evaluation; neither exists today.                                                                                      |
| Rate limiting and confirmation              | `gateway.ts:248` consumes YOLO allowance; line 297 consumes ordinary allowance and line 306 may create a card.                                                                                                                                                                                  | A separate preflight in chat would race and duplicate policy. Keep decisions in the gateway; intercept every confirmation branch, including rate-limit escalation. Shadow must not consume allowance.                                |
| Handler result and identity                 | `gateway.ts:645` executes then sanitizes; line 655 detects module-reported failure even though the public response at line 658 is `ok: true`. `gateway.ts:732` dispatches under `withDataContext`.                                                                                              | Preserve actor-scoped dispatch and audit. Expose a trustworthy execution outcome to the gate; public `ok` alone is insufficient to choose success/fallback. This is a seam observation, not a new end-to-end security certification. |
| Engine-independent token                    | `packages/ai/src/gateway/session-tokens.ts:91` mints from a supplied session identity without launching an engine.                                                                                                                                                                              | Mint a short-lived gate token with actor, surface session and captured tool allowlist. Revoke that token alone in `finally`; do not revoke an existing model session's tokens.                                                       |
| Tool declarations                           | `packages/module-sdk/src/index.ts:575` defines `ModuleAssistantToolManifest`, including schemas, risk, family and confirmation hooks.                                                                                                                                                           | Add optional classifier metadata here; absent means off. Module ID remains the area; no new grouping hierarchy.                                                                                                                      |
| External declarations are a separate path   | `packages/module-sdk/src/external-module.ts:179`, `packages/module-registry/src/external/validate.ts:634`, and `packages/module-registry/src/external/tool-manifests.ts:52` define, validate, and explicitly copy external tool fields.                                                         | Update all three, plus the runtime dispatch contract for candidate hooks. Adding only the built-in interface silently loses external opt-in.                                                                                         |
| Input validation is incomplete for this use | `packages/ai/src/gateway/input-validation.ts:19` supports a subset of schema keywords; `packages/ai/src/structured/generate-structured.ts:282` already uses schema validation.                                                                                                                  | Gate boundary must validate the full eligible schema, candidate membership, bounds and unknown fields. Reuse installed validation machinery with external-schema resource limits; do not rely only on the gateway's subset.          |
| Normal persistence assumes a model ran      | `packages/chat/src/live/persistence.ts:248` requires an executed provider/model; `packages/chat/src/repository.ts:220` writes it to message metadata at line 269.                                                                                                                               | Add a discriminated gate completion origin; never fabricate model execution metadata. Reuse completed-turn storage and normal transcript delivery.                                                                                   |
| Private chat and sharing                    | `packages/chat/src/live/persistence.ts:280` skips persistence for incognito; `packages/chat/sql/0025_chat_owner_or_share.sql:51` permits shared message reads.                                                                                                                                  | Shadow records need a separate owner-only table, not inherited message sharing. Preserve private-chat non-persistence; resolve its shadow-review treatment before collection.                                                        |
| Existing reply surfaces                     | `apps/web/src/chat/message-row.tsx:128` and `packages/ui/src/chat-thread.tsx:242` render reply footers; `apps/web/src/chat/chat-drawer.tsx:308` merges the HTTP result.                                                                                                                         | Carry origin through HTTP, SSE, history and shared thread rendering. A marker in only one component is incomplete.                                                                                                                   |
| App map and design gates                    | `packages/shared/src/app-map-core.ts:253` describes the sorting row. `docs/DEVELOPMENT_STANDARDS.md:148` and `docs/design-system.md:145` specify guardrails and shared primitives.                                                                                                              | Update map and owning manifests in each product slice. Both new UI surfaces require Ben's mockup review before implementation.                                                                                                       |

Keep this ledger, including limitations and rejected options, through future review
rounds. Append new tree facts with citations and decisions with their owner; do not
remove a finding merely because a later slice fixes it.

### Boundary choices

Use the manager boundary rather than the HTTP route: the route is simpler for one
endpoint, but misses other callers and would run outside the shared turn lock.
Use a gateway option rather than a chat policy precheck: a precheck would be small,
but could create cards or execute under changed trust after checking. Reuse existing
AI transports rather than calling `generateChoices` directly from chat: direct use
preserves scores, but does not cover structured-capable selections or no-retry behavior.
No separate policy service, provider client, grouping taxonomy, or workflow engine.

These are local seam choices, not a new platform architecture. This planning session
uses no delegated agents. Product reviewers must review the actual wiring and the
policy-negative tests, not accept this document as proof of implementation.

## Contracts and invariants to build

- The classifier has exactly two jobs: (1) choose an eligible module area or a decline
  sentinel; (2) choose one eligible tool and its validated argument values, or decline.
  Stage two may carry named argument-choice questions in the same request. If a safe
  bounded schema cannot express the choice and its arguments within that stage, the
  tool is ineligible; do not hide extra model rounds. Typed extraction is capability
  dependent. No names of providers or models determine gate behavior.
- Resolve the Classifier binding once per attempt. The AI router reports supported
  answer capabilities and returns scores in a common contract. The user's configured
  default chat model is reached only by resuming the existing chat path, unchanged.
- The gate gets only the accepted message and bounded menu descriptions/candidate
  labels needed for that decision. No history, retrieval, memory, credentials or raw
  tool results go into classification. Candidate lists containing stored user data
  create a spec ambiguity explicitly listed below; do not silently broaden disclosure.
- Before model work: decline attachments, UTF-8 length over 2,000 bytes, missing
  classifier, off state, cooldown, or no eligible tools. `none` and
  `needs_earlier_conversation` decline. A module-controlled/context-dependent request
  must not be acted on using context the classifier is forbidden to see.
- One 3,000 ms deadline covers both stages, including preparation within the attempt;
  pass remaining time and cancellation through both transports. No retries. Timeout,
  provider error or malformed answer declines and starts a 30-second cooldown scoped
  to the affected actor/classifier. User cancellation stops the turn, not a fallback
  model turn. Late results cannot trigger a tool. Bound candidate and policy reads so
  a stalled dependency cannot strand chat.
- Validate tool membership, every argument and candidate identity before dispatch.
  Use stable candidate IDs; labels are untrusted data, not instructions. Reject unknown
  fields, missing required values, non-finite numbers, malformed scores, and unsupported
  schemas. Never send the raw message as tool input.
- Apply the eventual tool's risk bar to both stages and argument answers: initially
  read 0.90, write 0.95, outbound/destructive 0.98, with a top-minus-runner-up lead of
  at least 0.40 for each choice. These are provisional shadow thresholds, not proven
  accuracy. Missing runner-up evidence means decline, not invented certainty.
- Distinguish `declined-before-execution`, `executed-success`, and
  `executed-failure-or-unknown`. Only a failed read may fall back after dispatch.
  A failed/unknown write/outbound/destructive attempt, a timeout or module-reported
  error after its dispatch, or failed reply rendering after a mutating dispatch
  produces a code-written terminal outcome; never replay the
  message to the default model. The specific rule in spec 3.8 takes precedence over
  the broad "every failure" wording in 3.9.
- Templates render from validated/sanitized tool results and execution records, never
  model prose. All UI acknowledgements, errors, and the marker derive from records.
  Host chat owns message persistence and delivery; modules never inject chat turns.
  Guidance stays below 150 words and includes an untrusted-data contract and worked
  example. Model-authored user-data values require schema descriptions, that contract,
  and boundary validation. For this task, the approved spec's explicit unattended
  typed-argument path and no-gate-card rule override plan-build's generic per-item
  before/after acceptance rule. Existing gateway confirmation still wins: decline
  whenever it would require acceptance. Do not add a new approval flow.
- Shadow does not execute tools, create approval cards, consume auto-run allowance, or
  delay the default turn waiting for classifier completion. It records a hypothetical
  decision and correlates the first actual model tool attempt by turn ID. Keep `none`,
  pending, cancelled, failed, and unobserved outcomes distinct from a mismatch. Compare
  normalized module/tool identity; record argument agreement separately when safely
  available. Tool-name agreement alone does not certify argument safety.

## First-party candidate inventory (not an activation decision)

| Requested use                  | Exact current candidate                                                                                                                       | Work and eligibility before opt-in                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a task                     | `tasks.create`, `packages/tasks/src/manifest.ts:638`; handler `packages/tasks/src/tools.ts:188`; input `packages/shared/src/tasks-api.ts:379` | Requires a typed title; choice-only classifiers cannot supply it. Restrict the gate's offered argument subset; validate against the real schema. Render from the returned task record. Existing gateway trust and confirmation still apply. |
| Today's calendar               | `calendar.listVisibleEvents`, `packages/calendar/src/manifest.ts:306`; handler `packages/calendar/src/tools.ts:146`                           | Derive today's start/end from the actor's timezone in code; defaults are not "today". A bounded template must handle no events, gaps/stale results and overflow truthfully. Long/open-ended results decline.                                |
| Smart-home switches and scenes | No first-party tool declaration found in this checkout by graph search plus manifest/path searches.                                           | Ben/build coordinator must identify the owning installed module and exact tools. Do not invent tool names or build a smart-home module as part of this plan.                                                                                |
| Timers                         | No first-party timer action found; runtime idle-reap timers are unrelated.                                                                    | Same owner action: identify an existing installed tool and its manifest, or defer. Do not create a timer product to fill the list.                                                                                                          |

This is the exact available shortlist for Ben's section 5 decision, not permission
to opt in both existing tools. Third-party/integration tools are not automatically
eligible merely because they are installed or have an input schema.

## Slice 1: rename and setting

### 1.1 Settings mockup review (one design session)

Owner: UI implementer, reviewed by Ben. Use `.claude/skills/design-system/SKILL.md`,
`docs/design-system.md`, and `packages/ui/OPTIONS.md`. Produce a settings-row mockup
in the design spec using existing `Field`, `Select`/`Segmented`, and help/status
primitives. Include no classifier, unavailable selection, loading, save failure,
read-only permissions, off/shadow/on, and `on` unavailable pending release approval.
Show the API disclosure: eligible chat messages are also sent to the chosen classifier
provider, in addition to the default provider in shadow/fallback cases. Do not imply
quickly declined attachments are uploaded to it. Preserve existing background-use
privacy disclosures while renaming. Capture Ben's agreement before tasks 1.2-1.3.

Exit: agreed mockup and gate-state scope decision recorded in the spec. No UI code.

### 1.2 Setting contract and storage (one backend session)

Depends on 1.1 and Ben's state-scope choice. Touch `packages/shared/src/chat-api.ts`,
`packages/chat/src/manifest.ts`, the owning settings API/repository selected by that
choice, and a new owning-module migration only if needed. Define off/shadow/on with
off as the missing-value default. Preserve the admin-owned Classifier binding and
its storage key. Per-user state must use actor preferences; admin-wide state must
use the existing admin configuration boundary, not a new admin private-data bypass.
Reject live activation without an approved tool release record; no bypass from a
forged API request. This slice changes no chat execution.

Update `packages/shared/src/app-map-core.ts` and owning manifest settings/features,
including scope, permissions, locked activation and remediation, in the same PR.
Check default-off, invalid enum, ownership, admin/non-admin permissions, and rejection
of premature `on`. Extend the existing settings API test path, rather than building
a second settings mechanism. Exit: scoped checks pass; settings UAT below passes.

### 1.3 Public rename and settings row (one UI session)

Depends on 1.2. Touch `apps/web/src/settings/settings-ai-sorting-row.tsx`, its parent
settings composition as needed, AI help/docs, `packages/ai/src/manifest.ts`,
`packages/chat/src/manifest.ts`, and `packages/shared/src/app-map-core.ts`. Rename
user-facing Sorting model copy to Classifier; retain internal compatibility names.
Build exactly the approved row and disclosure, with accessible labels and save
feedback from the saved record. Do not expose `on` as usable before the release gate.

Check `tests/unit/settings-ai-sorting-row.test.tsx` and a new
`tests/uat/specs/classifier-settings.uat.spec.ts`: owner signs in, opens the real
settings path, selects/clears a classifier, reloads, changes the allowed gate state,
and verifies unchanged chat behavior and forbidden premature activation. Run the
UI assertions in light, dark and one theme; record bounded DOM/network evidence.

**Slice 1 evaluation:** Ben decides whether the configuration and disclosure are
understandable and still worth pursuing. Stop here if Ben rejects the extra data
sharing or intended latency benefit; do not start slice 2 automatically. Later
work orders must be refreshed after this review.

## Slice 2: tool opt-in

### 2.1 SDK contract and safe template/candidate support (one session)

Own `packages/module-sdk/src/index.ts` and a focused SDK helper if necessary. Add an
optional `classifier` declaration containing a one-line description, per-argument
enum/candidate/extraction requirements and a bounded result reply template. Reuse
risk, input/output schemas and module ID. Candidate hooks are read-only, actor-scoped,
cancellable and bounded; no arbitrary code in templates. Static enum tools need no
hook. Validate placeholders against allowed result fields and reject incomplete
contracts before listing. An absent declaration makes every existing tool ineligible.

Check one enum tool, a typed-only tool, missing required arguments, invalid template,
unknown result field, and unbounded candidate output. Document the SDK contract in
`docs/module-developer-guide.md`. Internal-only helpers need no false app-map feature;
any newly exposed opt-in capability must be declared in the owning feature metadata
and core map in this same slice.

### 2.2 External-module round trip (one session)

Own `packages/module-sdk/src/external-module.ts`,
`packages/module-registry/src/external/validate.ts`,
`packages/module-registry/src/external/tool-manifests.ts`, and the existing external
runtime dispatch boundary. Carry validated declarative templates and candidate-hook
handler references through discovery into runtime manifests. Candidate hooks must
use the existing sandbox/RPC mechanism; the SDK function form alone is not portable.
First verify and cite that runtime extension point; if it cannot support a bounded
read-only hook, owner is the module-platform implementer and dynamic external
candidates remain blocked, not silently replaced with direct database access.

Extend `tests/unit/external-module-tool-manifest-policy.test.ts` and add an installed
fixture round trip: valid opt-in survives loading, unknown/hostile declarations fail,
no opt-in stays off, two owners cannot see each other's candidate values, and handler
failure declines without a tool write. Preserve provenance and existing policy fields.
Exit: fixture load-to-gateway test passes; document external eligibility requirements
and update owning app-map feature metadata if the published capability changes.

### 2.3 First candidate declarations (one session per approved owning module)

Depends on Ben's exact shortlist and the candidate privacy decision below. For each
approved candidate in the inventory, edit only its owning manifest/tools, add the
small candidate/template helper needed, and update that manifest's features/errors/
remediations and `packages/shared/src/app-map-core.ts` where core help describes it.
No direct cross-module imports. Do not widen an existing tool's authority. Calendar
window candidates are deterministic and timezone-aware; task fields are extracted
only on capable classifiers. No live activation yet.

Check declaration-to-loaded-menu eligibility, candidate authorization, schema
validation and template output against the actual handler result. Use the existing
tool handler tests plus `tests/uat/specs/classifier-tool-menu.uat.spec.ts` to confirm
real module installation and unchanged default chat operation. Missing smart-home
and timer ownership blocks only those candidates. Exit: each approved module's
bounded session passes separately; no fictional tools in the shipped list.

## Slice 3: shadow mode

### 3.1 Classifier routing contract (one AI session)

Own a new `packages/ai/src/structured/classifier.ts`, package exports, and the minimal
single-attempt extension to `generate-structured.ts`. Resolve the existing binding
through `AiRepository`; report choice-only versus typed-extraction capability without
provider names in gate logic. Reuse `generateChoices` or the structured transport,
retaining complete choice scores and validating a common result shape. Do not change
the yes/no helper's callers. Pin the resolved model for both stages. Add no fallback
inside classification and no repair retry. Unsupported capability declines.

Check different configured classifier selections, no binding, disabled model,
routing restrictions, malformed/missing scores, and timeout after stage one. Count
transport calls to prove at most one attempt per stage. Verify the chosen default
chat model is never called by this helper. New tests:
`tests/unit/ai-classifier.test.ts`. Exit: focused tests pass.

### 3.2 Gateway decline and shadow evaluation (one gateway session)

Own `packages/ai/src/gateway/gateway.ts` and adjacent gateway types/policy tests.
Extend the existing call path with an explicit no-confirmation execution mode and
a dry-run evaluation that shares its policy decision. Refactor only the policy
portion needed to prevent divergence. Default callers retain current behavior.
Before any handler call or card emission, return a typed decline when confirmation
would be required. Shadow evaluates without creating cards, consuming allowance or
writing an executed-action audit. The live path still validates current membership,
trust, override and limits at dispatch time; a prior dry-run is never authorization.
Expose attempted execution and module-reported errors truthfully to the gate.

Extend `tests/unit/gateway-policy.test.ts` and
`tests/unit/mcp-gateway-units.test.ts`: normal/YOLO crossed with read/write/outbound/
destructive, trusted/untrusted family, per-call override, rate limit, removed tool,
invalid token, invalid arguments, and module-reported failure. A would-confirm gate
call must produce zero cards and zero handler invocations. Observe the test fail
with the no-card guard removed, then restore it. Exit: existing and new policy tests
pass; same-slice chat manifest/core map describe decline-to-normal-approval behavior.

### 3.3 Gate decision engine (one chat session)

Own new `packages/chat/src/live/classifier-gate.ts` and
`tests/unit/chat-classifier-gate.test.ts`. Implement quick checks, module/tool menus,
two stages, full validation, risk thresholds, margin, shared deadline and cooldown.
Keep the engine small and inject the AI/gateway/candidate ports; do not put the whole
implementation in the already-large session manager. Handle every invariant above.

Check UTF-8 byte boundaries, attachments, missing model, off, no eligible tools,
context-dependent language, every risk threshold, exact margin boundary, malformed
answers, candidate revocation, deadline/cooldown expiry, cancellation and late results.
Observe the risky-tool test fail with its confidence bar removed; restore it and
record both results. No threshold evidence means no live eligibility. Exit: focused
tests pass and shadow reasons are declared in the chat manifest/core app map with
useful remediation, in the same PR.

### 3.4 Owner-only shadow records (one persistence session)

Own a new `packages/chat/src/classifier-shadow-repository.ts`, a new migration under
`packages/chat/sql/`, chat database types/manifest migration registration, and
`tests/integration/chat-classifier-shadow.test.ts`. Do not edit applied migrations.
Store actor, turn correlation ID, timestamps, original message text, gate mode,
classifier configuration identity/version, module/tool, confidence and margin,
threshold version, decision/reason, timing, and first-model-tool comparison status.
Avoid storing raw argument/result payloads merely for convenience. Use owner-only
RLS for reads and writes with no admin or thread-sharing exception. Bound retention
and review reads according to the open decision below. No text in logs, job payloads
or public PR evidence. A record-write failure must not prevent the default turn.

Check two owners, shared-thread recipient, admin, missing actor, correlation before/
after classifier completion, missing model tool call, cancellation, storage failure,
and private-chat non-persistence. Observe the owner-isolation check fail when its
owner predicate is deliberately weakened in an isolated disposable database, then restore it. Before any
DB command the implementer must use the verify-gate skill and its isolated-target
procedure; this planning session runs none. Exit: scoped database proof passes;
privacy behavior and errors are declared in the same slice's chat manifest/core map.

### 3.5 Runtime wiring and shadow live proof (one integration session)

Own `packages/chat/src/routes.ts`, `packages/chat/src/live/runtime.ts`,
`packages/chat/src/live/chat-session-ports.ts`, the thin manager hook and
`tests/uat/specs/classifier-shadow.uat.spec.ts`. Wire dependencies from the existing
composition root. Launch the shadow attempt under the turn's cancellation lifecycle
while the default turn proceeds as today. Observe the first model tool record in
`runTurn`'s transcript processing; normalize transport prefixes and correlate by a
server turn ID, not actor alone. Do not count later matching tools as a first match.
Bound pending correlation state and clean it on completion/cancellation.

Through the actual UI, prove off makes no classifier request; shadow records a
decision, makes zero gate-origin tool executions and creates no gate card; the default model still
answers once with the original text. Include an attachment, oversized multibyte
message, timeout, malformed answer, cooldown, simultaneous surfaces and a cancelled
turn. Show normal and YOLO behavior. Update chat features/errors/remediations and
core app map in this PR. Exit: live proof linked on the future product PR with exit
code and redacted assertions; collect shadow data only after privacy decisions clear.

## Slice 4: prepare and turn on

### 4.1 Handled-turn lifecycle, initially unreachable live (one chat session)

Own the manager hook, `packages/chat/src/live/persistence.ts`,
`packages/chat/src/live/chat-session-ports.ts`, `packages/chat/src/repository.ts`,
`packages/shared/src/chat-api.ts`, and transcript origin types. Add a gate-origin
completion contract carrying tool identity, decision correlation and outcome. Keep
existing model-origin history readable. Mint/revoke the gate token through the real
composition root without launching an engine; use the gateway from task 3.2.
Persist and emit exactly one normal chat reply from the result template or terminal
failure record, with action results/cache invalidations preserved. Do not record a
fictional default-model execution or usage count.

Ensure a later default-model turn can see completed gated turns in normal history:
a warm model session will not have received them. Mark it for normal history replay
on the next default turn without submitting a synthetic turn during the gated reply.
Retain existing private-chat behavior and cancellation cleanup. Gate storage/render
failure after a mutating attempt must never trigger default-model replay. If Stop
arrives after dispatch, retain the action outcome and do not classify cancellation
as permission to retry; the classification deadline is not a tool-execution deadline.

Check cold and warm sessions: successful handling makes zero engine-launch/submit
calls, fallback submits original text once, read failure falls back, mutating partial
failure never retries, subsequent conversational reference has normal history, and
HTTP/SSE/history agree. Tests: `tests/unit/chat-classifier-live.test.ts` and extended
live persistence tests. Activation remains blocked. Update chat manifest/core map
truthfully to describe implementation as unavailable pending review.

### 4.2 Shadow review and release eligibility (one review/backend session)

Owner: build coordinator and Ben; depends on 3.5. Present owner-authorized aggregate
results for each candidate: sample count, review window, first-call agreement,
argument review where relevant, declines, unknowns and latency. Do not publish message
text. Ben sets the acceptable rate and window after data exists and chooses the tools.
Persist the reviewed tool/configuration versions as release eligibility, empty by
default; enforce it server-side alongside the state. Do not hardcode a guessed rate
or grant one tool eligibility based on another's aggregate.

Check that no approval, insufficient evidence, changed classifier/schema, or a
revoked approval denies live execution. Same-PR map/manifest updates explain eligibility
and how to return to off/shadow. Exit: Ben's decision recorded; if criteria fail,
remain in shadow or stop. This task does not itself enable production actions.

### 4.3 Real activation and live-path proof (one release session)

Depends on 4.1, 4.2, **5.1 and 5.2**, and all candidate-specific blockers. Enable only
Ben-approved tools on a dev instance and exercise
`tests/uat/specs/classifier-live.uat.spec.ts` through actual signup/settings/module/chat
UI. Prove correct result plus marker with no default-model turn; low confidence and
unknown arguments fall back; approved normal and YOLO tools follow the same gateway
policy; a tool requiring approval declines and the default model shows the usual
card exactly once. Include rate limits, per-call overrides, partial write failure,
read failure, stop, settings rollback to off and refreshed history.

Record the live test run, exit code and bounded redacted assertions on the future
product PR. No screenshots for this gate. Update core map and each activated owning
manifest in this same PR, including supported actions, errors and remediation. Exit:
proof passes and Ben's release gate is met. Otherwise report code-complete, unverified;
do not merge, mark Done, or turn on for real users.

## Slice 5: marker on handled replies

Listed fifth to preserve the spec's backbone; it is a hard predecessor of 4.3.

### 5.1 Reply-marker mockup review (one design session)

Depends on the origin contract in 4.1; may be reviewed earlier with 1.1. Use the
design-system skill and shared `Badge`/`InfoTip` or existing caption primitives.
Mock up a normal reply with "Answered without the main model", a terminal tool
failure, history after refresh, small screens and accessible keyboard/screen-reader
text. The marker reads origin metadata, never parses reply prose. Capture Ben's
agreement in the spec **before** task 5.2. Exit: agreed mockup, no UI implementation.

### 5.2 Persisted and live marker rendering (one UI session)

Own `apps/web/src/chat/message-row.tsx`, `apps/web/src/chat/chat-drawer.tsx`,
`packages/ui/src/chat-thread.tsx` and the history/stream adapters carrying their
records. Use the existing shared primitive to avoid two diverging marker designs.
Pass the origin through `packages/chat/src/live-routes.ts` response serialization
and shared response schemas as needed; dropping unknown fields must not erase it.
Old/default-model replies have no marker; live, refreshed, surface-specific and
private transient handled replies agree. No fabricated model/provider label.

Check `tests/uat/specs/classifier-marker.uat.spec.ts` through both drawer and module
thread surfaces, including HTTP completion/SSE ordering and reload. Run token/class
checks and UI assertions in light/dark/one theme. Update chat manifest feature/error
metadata and `packages/shared/src/app-map-core.ts` in this same PR. Exit: mockup
matches, executable assertions pass, and proof is attached before 4.3 can activate.

## Verification procedure for implementers

Commands below describe future build work; none of the database or live suites is
run for this documentation assignment. Read `.claude/skills/verify-gate/SKILL.md`
before any database test or full foundation gate, select its isolated target and
follow its setup. Never use a default live database. Keep command exit codes intact;
no piped verification. Use the repository's existing test runner and frameworks.

| Scope                                      | Command (after the named test exists)                                                                         | Expected    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------- |
| Docs                                       | `git diff --check`                                                                                            | Exit 0      |
| Plan formatting, if dependencies available | `pnpm exec prettier --check docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`                    | Exit 0      |
| Settings UI                                | `pnpm exec vitest run tests/unit/settings-ai-sorting-row.test.tsx`                                            | Exit 0      |
| AI contract                                | `pnpm exec vitest run tests/unit/ai-classifier.test.ts`                                                       | Exit 0      |
| Gateway                                    | `pnpm exec vitest run tests/unit/gateway-policy.test.ts tests/unit/mcp-gateway-units.test.ts`                 | Exit 0      |
| Gate decisions                             | `pnpm exec vitest run tests/unit/chat-classifier-gate.test.ts`                                                | Exit 0      |
| Handled lifecycle                          | `pnpm exec vitest run tests/unit/chat-classifier-live.test.ts`                                                | Exit 0      |
| External declaration                       | `pnpm exec vitest run tests/unit/external-module-tool-manifest-policy.test.ts`                                | Exit 0      |
| RLS, only after verify-gate isolation      | `pnpm exec tsx scripts/test-integration.ts tests/integration/chat-classifier-shadow.test.ts`                  | Exit 0      |
| UI slices                                  | `pnpm check:design-tokens` and `pnpm check:ui-classes` (separately)                                           | Each exit 0 |
| Changed product scope                      | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm build:app-map` (separately) | Each exit 0 |

Each slice's named UAT runs with `pnpm test:uat <named-file>.uat.spec.ts` after the
verify-gate/dev-instance procedure; expected exit 0. Replace the placeholder with
that slice's filename, for example `pnpm test:uat classifier-shadow.uat.spec.ts`.
Observe it pass and attach assertions proving the real UI called the new production
path. Internal SDK/AI/gateway tasks use their end-to-end fixture/wiring tests until
the slice's UI path exists; they do not count as delivered user behavior alone.
Security negative controls intentionally exit nonzero with the guard removed; restore
the guard, rerun to exit 0 and retain both observations. Do not commit weakened guards.

## Decisions still needed from Ben

The original four questions are unchanged:

1. Is gate state per user or admin-wide? Blocks 1.2 and final settings design; the
   classifier binding remains admin-owned under either choice.
2. Which first-party tools opt in first? The exact available candidates and missing
   owners are above. Blocks 2.3 for any unapproved tool, not the default-off SDK work.
3. Should a later version let the gate raise its own approval card? No version-one
   task implements that, regardless of the eventual answer.
4. What shadow agreement rate and review window permit activation? Set only when the
   data exists; blocks 4.2/4.3. Do not fill in a threshold for Ben.

Additional seams requiring a ruling, not an invented implementation assumption:

- **Candidate privacy (Ben, before 2.3/3.5):** spec 3.3 says no stored data reaches the
  classifier, while 3.4 allows candidate names from the user's devices. Agree the
  narrow data allowance and corresponding disclosure. Until then use static enums
  and synthetic fixtures; do not send private candidate lists.
- **Shadow retention/private chat (Ben, before 3.5 collection):** set retention and
  how private-chat attempts participate in review without storing their text. Existing
  incognito non-persistence wins until clarified. No new private-content sink by default.
- **Missing tool owners (Ben/build coordinator, before their 2.3 session):** supply
  the actual installed smart-home/timer manifests or defer those candidates.
- **External candidate dispatch (module-platform implementer, before 2.2 completion):**
  prove the bounded actor-scoped runtime hook with a source citation and fixture.
  This plan verified declaration loading, not a preexisting candidate-hook protocol.

## Planning-session completion

Deliver only this plan. Review the entire document for credentials, private hostnames,
LAN addresses and personal data; keep workspace references under `~/Jarv1s`. Run
bounded documentation checks, commit only this file with the required co-author
trailer, leave the worktree clean, do not push or create tracking artifacts, and
notify Ben with the task brief's exact `needs-ben` command.
