# Workshop assessment and redesign requirements — 2026-09-04

Recommendation: rebuild the Workshop interaction and build-session coordination, retaining the
existing module platform as the foundation. The evidence does not support calling this an easy
fix, nor does it justify replacing Moss's entire module system.

This assessment records the source findings and agreed direction, not a live runtime diagnosis.
Ben subsequently approved the interaction prototype; the resulting
[implementation contract](../superpowers/specs/2026-09-04-workshop-projects-and-supervised-builds.md)
defines the next work. No product code changed. Source reviewed in `~/Jarv1s` at `bedfb0382`; the two commits
on the local `origin/main` reference introduce no differences in the inspected Workshop page,
AI build-step directory, or live-agent launcher.

The subsequent [adversarial review response](2026-09-04-workshop-spec-review-response.md) corrects
implementation readiness: the design is approved, but confinement feasibility and missing UI
state review remain prerequisites. It also identifies the concrete draft-worker KV integration
gap and the missing Workshop planning settings row.

## User experience and agreed direction

Ben reports that number generators, Word of the Day, and a research library have never advanced
meaningfully beyond the initial prompt. The current design and interaction need complete replacement.

Ben agrees with a dedicated Workshop conversation: discuss the module, revise a plan, approve it,
then supervise the build and try the draft in the same place. He also proposes separate instructions
for the Workshop assistant rather than having it behave like general Moss.

Ben subsequently specifies **New project** inside Workshop as the primary entry point. Moss may
also create a project from a normal conversation and redirect the user into it. Carry the request
and relevant context across that handoff, with no repeated briefing or second build. Both entry
points must use the same project-creation operation. Creating a project begins discovery; it must
not silently be treated as approval to execute a build.

Working interpretation: a project is the durable workspace for its conversation, current plan,
build attempts, and draft; the module is its output. This does not authorize general-purpose
projects unrelated to building Moss modules. Persistence/schema choices remain to be designed.

This aligns with the still-open [issue #2023](https://github.com/motioneso/moss/issues/2023).
That proposal is a useful starting point, not proof that its implementation exists or that all
its scope should be built at once. Its optional terminal surface can follow the primary conversation
and working-draft journey unless Ben needs it in the first slice.
Ben's newer direction supersedes #2023's instruction to avoid the product noun “project” and
its restriction of global Moss to suggesting or linking to Workshop.

### Confirmed scope and first journey

Ben confirms on 2026-09-04:

- Project creation remains **admin-only** for this release. Each admin owns their projects;
  another admin does not acquire access to their conversations, drafts, or build sessions.
- **Prove the full journey first.** Start with pages, host storage, and supported existing tool
  capabilities. Custom SQL-table provisioning is outside the initial proof. This is a delivery
  sequence, not a permanent removal of richer modules from the goal.
- For a module with UI, show a **visual mockup with the plan before building**, so the admin can
  review layout and interaction. The running draft remains the test of actual behavior.

The first project journey is: New project (or Moss handoff) → focused requirements conversation →
reasoning-model specification and plan, with UI mockup → review/revision → approved build →
working draft → requested change → verified result. Opening a project never starts construction
by itself. Revisions must identify the current plan/mockup; an old approval cannot silently approve
changed requirements. Planning, building, and reviewing remain in the same project conversation.

The Workshop interface itself also needs reviewed designs before implementation: dashboard/new
project, requirements conversation, plan/mockup review, active build, question/answer, stalled or
retrying, failed, draft review, private completion/sharing, and empty/loading/error states. The existing status cards are not
the starting layout constraint. Optional terminal inspection follows the primary proof unless
separately prioritized; it is never required for the user to complete a project.

### Finishing and sharing

Ben confirms that finishing a module keeps it private, with a separate **Share with everyone**
action. The current `shipExternalModule` implementation enables the module and clears its draft
owner, so it cannot supply this behavior unchanged. Preserve project ownership independently of
draft status so a finished project remains editable by its owner. Define completion and sharing
as separate lifecycle transitions; neither generated code nor model prose can widen availability.

## What the current implementation does

The global chat calls `workshop.buildModule`. A planning service creates a build record and a
structured plan. Approval queues background work. The worker launches a separate interactive agent
for each of three steps: specification, tests, and code. Each agent signals completion by writing
a marker file; the worker bundles the resulting module and submits it to the existing validator
and draft installation path. Workshop polls build rows and offers draft actions.

The intended outcome is reasonable. The connections needed for an interactive builder are missing.

| Finding from current source                                                                                                                                                                              | Consequence                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/workshop/src/web/workshop-page.tsx:35` consumes query data but no loading/error states; mutations at lines 63–100 expose no pending/error feedback.                                            | A failed request can look empty or make an action appear inert. These are bounded repair candidates.                                                                                                   |
| The page has no new-build conversation or build-detail view. Starting requires global chat.                                                                                                              | Workshop is a status list, rather than a place to develop a module together.                                                                                                                           |
| `apps/worker/src/module-build-live-agent.ts:35` creates a new session for each step and kills it at line 139. It supplies a separate builder prompt, but no persistent conversation or steering channel. | Better prompting alone cannot create continuity, questions, answers, or live intervention.                                                                                                             |
| The live-agent launcher recognizes terminal readiness and then polls for a completion file. It allows up to 30 minutes per step.                                                                         | A living process, a stalled agent, and an agent awaiting input are not meaningfully distinguished for the user. This is a structural limitation, not a reproduced explanation for Ben's exact failure. |
| `apps/worker/src/module-build-step-runner.ts:80` updates activity on a timer while waiting; `packages/ai/src/module-build/run-build-step.ts:45` records files after the agent returns.                   | “Last active” is worker liveness, not evidence of useful agent progress; file reporting is delayed until a step ends.                                                                                  |
| Cancellation changes stored status; the step runner checks it after the active step. The launcher receives no cancellation signal.                                                                       | Stop does not promptly interrupt the active agent.                                                                                                                                                     |
| `packages/workshop/src/web/workshop-groups.tsx:68` labels every failed build “Build couldn’t start” and gives generic discard advice, without showing the returned build error.                          | Failure midway through building is indistinguishable from failure to start, with little recovery guidance.                                                                                             |
| “Ask for a change” navigates to the module and opens chat; `apps/web/src/app.tsx:480` also just opens chat. The draft-change classifier has only test callers.                                           | Opening the drawer is implemented; a connected draft refinement workflow is not established by that wiring.                                                                                            |
| The runner's optional `testsPassing` result is never enforced; `scripts/build-external-module.ts` bundles code but does not run generated tests.                                                         | A “writing checks” phase is not proof that the generated module passed checks or works in the UI.                                                                                                      |
| The Workshop module list filters to `scope === "you"`.                                                                                                                                                   | Its “Live · everyone” presentation cannot be reached through that query after sharing.                                                                                                                 |

## Keep, replace, and prove

Keep the module format and SDK, existing manifest validator, author-owned draft model, explicit
shipping and removal lifecycle, provider launch support, and background queue infrastructure.
These are reuse candidates with existing consumers; retaining them does not mean their assembled
Workshop path has passed live verification. For example, `installModuleDraft` already uses the
same validator and staging/hash primitives as downloaded modules.

Replace the current Workshop screens and the coordination that treats each build phase as a
disconnected agent invocation. Establish one durable build identity, conversation, current plan,
and truthful record of activity. A live process may restart, but the module's intent, messages,
questions, and recovery state must survive. Reuse suitable existing chat/runner capabilities
after checking their fit; do not invent another general agent framework.

The first acceptance journey should be deliberately small: create Word of the Day inside Workshop,
answer a requirements question, revise and approve the plan and visual mockup, reach an actual running draft, request
a visible change, and see it applied. Verify stopping a separate attempt, returning after navigation,
and restart recovery. Exercise failures with visible explanations. Broader research-library
capabilities should follow once this basic journey is proven.

## Model selection by phase

Ben requires the configured interactive model by default, switching to a reasoning model when
creating the specification and implementation plan. Use Moss's existing model tiers and service
routing; do not hardcode a provider or model or create separate Workshop model settings without need.

| Work                                                                                         | Model role                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Requirements conversation, ordinary questions, progress explanations, coding, and refinement | Interactive by default                                                 |
| Creating or substantively revising the specification and implementation plan                 | Reasoning                                                              |
| Running tests, validation, installation, cancellation, and shipping                          | Deterministic host operations; no model decides whether a check passed |

Model changes preserve the same project, user-visible conversation, requirements, and current
artifact revisions. Pass the relevant project context to each selected model; do not require a
single provider's terminal session to support every phase or make the user repeat their request.
User steering must still reach the active phase. Record the actual selected model and its role in
build diagnostics so a tier label cannot hide a launcher that used a different model.

Proposed unavailable-model behavior: preserve the project and explain the missing reasoning-model
configuration before specification work begins. Do not silently downgrade or cross providers
outside the user's routing policy. Reconcile explicit global model overrides with phase routing
in the implementation spec; do not silently override a deliberate user setting either.

Current seams: `packages/ai/src/service-binding-map.ts` already supports tier bindings;
`AiRepository.resolveModelForService` accepts `tierHint`, with an unbound default of economy.
`packages/ai/src/module-build/write-plan.ts` supplies no tier hint. The worker currently selects
a chat model but gives `createModuleBuildLiveAgent` only its provider kind; the selected model ID
is absent from that launcher's input. Both planning and agent launch need verified model routing.

## Custom-module requirements and enforcement

Ben requires explicit custom-module requirements that Moss builds within. Establish a canonical,
versioned custom-module authoring contract tied to the installed SDK/runtime and validator.
Keep the same contract available during requirements gathering, reasoning/planning, generation,
and validation. Reuse canonical declarations and checks instead of copying a second set of rules
into a long prompt that can drift. Each rule must identify its enforcement point and evidence;
requirements below are not a claim that all corresponding checks exist today.

| Requirement                              | Required evidence or enforcement                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clear purpose and supported capabilities | The project spec states users, behavior, data needs, external services, and acceptance examples. Check requested capabilities against the installed custom-module runtime before promising a build. Explain unsupported needs during planning.                                                                                 |
| Valid module package                     | Use the custom-module manifest/ABI, supported SDK entrypoints, compatible core version, declared dependencies, and required build artifacts. Run the existing manifest validator and bundle checks. Generated modules meet the same contract as hand-authored custom modules.                                                  |
| Moss-native interface                    | Use the host's supported UI primitives, design tokens, navigation, and preferences contracts. Cover empty, loading, error, and success states, keyboard use, focus, and labels. Include truthful feature/settings/navigation descriptions in the app map through the supported declaration path.                               |
| Owner-scoped data and lifecycle          | Declare storage and any supported owned tables. Access data through host-scoped APIs; preserve owner privacy including against other admins. Define export, removal, purge, and update behavior. Any database capability needs proven host provisioning/migration and ownership enforcement, not merely valid manifest syntax. |
| Declared authority                       | Declare external hosts, tools, action risk, permissions, and supported background work. Use host-mediated network/data/tool APIs. Validate inputs at trust boundaries. A request for new authority during refinement updates the plan and follows the applicable approval policy.                                              |
| Secret and execution boundaries          | No credentials in generated source, browser data, logs, prompts, or queue payloads. Credentials are configured through host-managed slots. Enforce workspace/process authority; the builder cannot modify Moss core or unrelated projects. Generated runtime code receives only its declared host capabilities.                |
| Bounded, recoverable behavior            | External calls and jobs need timeouts, useful errors, and safe retry/idempotency behavior where applicable. Failed changes preserve the last usable version and data. Cancellation and cleanup must release project resources without harming other modules.                                                                   |
| Demonstrated correctness                 | Run meaningful generated checks and host contract checks, then exercise the module's acceptance examples through its real UI/tools. “Files written,” successful bundling, and the model saying “done” are insufficient. Keep evidence attached to the project.                                                                 |
| Controlled lifecycle                     | A passing build produces an author-only draft. Refinement stays attached to the project. Sharing/shipping remains an explicit human action. Verify reload/restart behavior and supported removal/purge paths.                                                                                                                  |

Use [the refreshed custom-module authoring guide](../module-developer-guide.md#13-custom-and-installable-modules)
as the human-readable contract, grounded in the installed SDK and validator. Sections 2–12 of that
guide describe built-in modules; they must not be copied as custom-module instructions. Fields such
as `dataLifecycle`, `settings`, and `externalSources` are compiled built-in declarations rejected by
the custom JSON validator. Use supported custom declarations and host lifecycle support; do not
loosen validation to make an invalid generated package pass.

### Existing enforcement and missing prerequisites

The guide now names the source for each current custom-module surface. In particular:

- `JsonMossModuleManifest` and its validator define JSON capabilities; the worker SDK exposes
  host-controlled KV, credentials, fetch, queries, AI, embeddings, notifications, and attachment
  text. Availability still depends on the configured host and invocation risk.
- The web loader requires `{ contractVersion: 2, Root, css? }`; a built-in web contribution is
  incompatible. It currently renders empty on loading/contract failure, so UI proof must assert
  useful content and behavior, not only route arrival or a successful bundle.
- Custom database installation and generated RLS exist in `scripts/module-install.ts` and the
  DB package. Custom account export/deletion derives from `database.ownedTables`. Workshop's
  draft installer does not invoke schema provisioning; keep SQL outside the first proof.
- The worker RPC boundary enforces scoped data and capability rules, but
  `packages/module-registry/src/external/worker-runtime.ts` starts a Node process without an OS
  sandbox in that launcher. Process/environment separation alone does not enforce all filesystem
  and network confinement. The implementation must establish the required execution boundary
  and test it, or explicitly limit its trust claim; a builder prompt cannot supply it.
- The custom JSON contract has no feature/error/remediation metadata equivalent to the compiled
  app-map declarations. `packages/settings/src/app-map.ts` reads a built artifact. Provide a
  supported declaration and refresh path so generated modules remain explainable by Moss; do
  not add ignored JSON fields and claim app-map coverage. The existing Workshop screens' own
  declarations must also change with their replacement in the same product PR.

These are engineering prerequisites and verification gaps, not questions for Ben to solve through
configuration or manual host changes. The docs refresh does not implement them.

Delivery order: check feasibility while gathering requirements; include applicable constraints and
acceptance checks in the reasoning-model spec/plan; enforce contract checks while building; verify
the running result before draft review and shipping. If a required enforcement mechanism is missing,
either implement that prerequisite or clearly mark the capability unavailable before building.

## Proposed Workshop assistant instructions

> You are the assistant for this Workshop project. You help the user design, build, test, and refine
> its Moss module. Keep the conversation focused
> on that module and retain its agreed requirements and current plan. Ask focused questions when
> an answer changes the result; otherwise make reasonable choices and explain them briefly.
> Before building, describe what the module will do, what it will access or store, and how the user
> will know it works. For a module with a UI, present a visual mockup for layout and interaction
> review with the plan. Follow the user's applicable approval settings and decisions. Build only
> within the authorized module workspace. Use the existing Moss module contracts and design system.
> Apply the custom-module contract for the installed Moss version throughout planning and building.
> Identify unsupported requirements before promising them. The host selects the reasoning model for
> specification and planning work and the interactive model by default for other conversation/work.
> Run the available checks and help the user try the actual draft. Report progress from observed
> work, distinguish waiting from working, and explain failures with a useful next step. Incorporate
> feedback into this same module. Never claim success from a plan, written files, or compilation
> alone. Keep broader shipping an explicit human action.

This role can use the same configured provider as Moss. Instructions define behavior; the runtime
must separately enforce workspace boundaries, ownership, cancellation, approvals, and delivery of
questions and steering messages. A prompt is not an implementation of those guarantees.

## Evidence and limits

### Interaction design follow-up

The [September 4 interaction prototype](../superpowers/specs/assets/2026-09-04-workshop/README.md)
now makes this direction reviewable: project creation, a focused conversation, revision-specific
plan and mockup approval, building/question/failure/cancellation states, draft refinement, private
completion, and separate sharing. It reuses Moss's real tokens and authored controls. All build
events and assistant responses are simulated; this is design work, not a repaired Workshop.
Ben approved the prototype after reviewing it remotely. Its README records the walkthrough,
verification, limits, and the
confirmed layout preference: side-by-side conversation and project work on desktop, switchable
views on phones. The implementation contract translates that approved design into the required
service, runtime, lifecycle, and live-verification work.

### Earlier source assessment checks

Ran five isolated unit suites: live-agent composition, worker step runner, AI build-step sequence,
Workshop page, and Workshop button actions. **34 tests passed across five files.**

```sh
pnpm exec vitest run tests/unit/worker-module-build-live-agent.test.ts tests/unit/worker-module-build-step-runner.test.ts tests/unit/ai-module-build-run-step.test.ts tests/unit/workshop-page.test.tsx tests/unit/workshop-groups-actions.test.tsx
```

These use fake agents/database access and cached page data. They verify pieces, not a real build.
The existing `tests/live/workshop-1888-uat.spec.ts` includes a real Word-of-the-Day journey, but it
was not run in this assessment. Ben's exact live failure has not been reproduced here; no root-cause
fix or effort estimate is claimed.

[Issue #1990](https://github.com/motioneso/moss/issues/1990) records real prior production agent
readiness failures and exhausted jobs left labeled Building. Its final comment explicitly closes
on merged/deployed code, leaving the production Word-of-the-Day verification to Ben. Closed issues
therefore do not establish a working Workshop journey.

Graph discovery was attempted first, including indexing the checkout. The graph returned only 31
nodes and no Workshop results; source search was used as the documented fallback.
