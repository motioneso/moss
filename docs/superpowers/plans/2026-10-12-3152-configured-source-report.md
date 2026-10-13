# Configured source reports with bounded read retries

Part of #3152, under #3137. Base: integration/scheduled-proactive at 4b2846f8e.
Risk: sensitive. Status: approved by the coordinator at 9d4a69caa; implementation
complete, final verification and live proof in progress.

## Scope and verified foundations

Replace the code-written status report with one bounded report from the owner's
configured model. Keep the existing one-time check of one owned Tasks item, Main
delivery, reminder controls and outward notification policy. No migration is needed;
0321 remains reserved but unused. No new connector, recurrence, source, write,
deletion, recipient choice or quiet-hours authority is introduced.

The approved product spec is
docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md,
sections Background execution and permissions, Recovery and lifecycle, Testing
Decisions, and acceptance scenarios 3, 7-10 and 13. Issue #3152 and its parent have
no comments. PR #3497's description and final QA comment were read. Its report
and retry implementation are present, so this plan extends them rather than
rebuilding the prerequisite.

| Capability                                  | Current evidence                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen operation, owner and version         | packages/chat/src/scheduled-reads/runner.ts:27; packages/chat/src/scheduled-reads/repository.ts:4                                             |
| Actual session-free read gateway            | packages/ai/src/gateway/gateway.ts:569: tasks.get only; :614: effective read risk; :793: owner authorization inside the execution transaction |
| Current module capability                   | packages/ai/src/gateway/gateway.ts:591: executableTools before execution                                                                      |
| Source fields and trusted citation          | packages/chat/src/scheduled-reads/report.ts:3: item identity/title/status validation and fixed Tasks link                                     |
| Quiet retry budget                          | packages/chat/src/scheduled-reads/queue.ts:3: two retries, 15-second backoff, 60-second delay cap                                             |
| Existing safe dependency classifier         | packages/ai/src/gateway/dependency-failure.ts:95; packages/ai/src/gateway/run-tool-handler.ts:118: first-party-only, trap-free error branding |
| Owner capability routing                    | packages/chat/src/scheduled-reads/generation.ts:67: module.chat, json capability and economy hint                                             |
| One model attempt outside a transaction     | packages/ai/src/structured/generate-structured.ts:277: prepared closure, explicit model, singleAttempt                                        |
| Existing recorded CLI transport             | packages/chat/src/live/cli-structured-adapter.ts:114; :156: neutral directory, owner identity, finally teardown                               |
| No native Codex shell or patch tools        | packages/chat/src/live/module-build-codex-exec-session.ts:128: unconditional disabled tools; :159: read-only sandbox                          |
| No MCP or native search on this report call | packages/chat/src/live/cli-structured-adapter.ts:419: launch has no gateway token or URL, and search is opt-in                                |
| Worker composition                          | packages/module-registry/src/index.ts:2395; packages/chat/src/jobs.ts:622                                                                     |
| Stable message and notification separation  | packages/chat/src/reminders/deliver.ts:126: reserved assistant message, delivery state, arrival and notification enqueue in the existing path |
| Real provider proof                         | tests/uat/specs/real-chat-signin.ts:84; tests/uat/specs/3151-scheduled-owner-read.uat.spec.ts:64                                              |

## Decisions and contracts

1. Keep creation failures explicit when Tasks or the model is unavailable. A caught
   scheduled request must not imply that a check was saved. Keep cancellation from
   falling through to another model turn; observe the existing aborted-turn behavior
   in regression tests. Preserve ordinary reminder/question routing unchanged.
2. The model has exactly two jobs across the feature: interpret the requested task
   and time (existing), then write a concise report from the authorized task snapshot.
   It never selects another operation or item at execution time. The host performs
   at most two exact gateway reads per attempt: the initial source read and a fresh
   access/source check after generation, before delivery. No model tool loop exists.
3. Add a report factory in packages/chat/src/scheduled-reads/report-generation.ts.
   Its public contract accepts actor ID, a validated {id, title, status} snapshot and
   an AbortSignal, returning success text or a typed report failure. Resolve the
   owner's module.chat JSON model with an economy hint and call the existing
   prepared structured generation once, outside the actor transaction. Use the
   existing CLI adapter factory at worker composition; no provider-specific branch.
   Bound generation to 120 seconds, output to 300 tokens and prose to 600 characters.
4. The report schema has only taskId, status and summary, with descriptions, no
   additional properties, and a worked example in guidance under 150 words.
   Validate the returned item ID and status against the source snapshot. Render
   summary as escaped plain text and append the host-authored Tasks citation.
   Reject malformed, oversized, mismatched or empty output with an honest report
   failure; do not substitute a successful deterministic report. Never accept model
   URLs, delivery metadata, permissions or notification exceptions. Only the small
   snapshot goes into the prompt, not subtasks, activities or an entire tool result.
5. Before generation, reload the reminder to check cancellation, version, deadline
   and run state. After generation, repeat the same exact gateway read to check
   current access, then reload under the existing delivery lock. A denied read
   discards the report and posts only the code-written refusal. A changed snapshot
   discards stale prose and posts an honest failure asking for a fresh check.
   Paused, deleted, expired, stale or already delivered work produces no new message.
6. Add optional retryable: true to the gateway error variant in
   packages/ai/src/gateway/types.ts. Produce it only for classified first-party
   connection-refused, unreachable or timeout failures. Reuse the safe classifier;
   generic exceptions, malformed source data, HTTP errors, denied access and model
   failures do not retry. Move the read-error mapping to
   packages/ai/src/gateway/actor-read-failure.ts so gateway.ts stays below its current
   1000-line boundary. Keep the existing log fields and never include raw errors.
7. Runner retries require the typed flag and a fixed maximum of two retries,
   regardless of larger supplied queue metadata. Existing backoff remains.
   Each retry starts with current lifecycle and access checks. Exhaustion persists
   one ordinary failure message; an immediate failure never claims it retried.
   Invalid model output, missing model setup and timeout get separate code-written
   explanations. Notification failure must not repeat the model or delivered result.
8. Update packages/chat/src/reminders/features.ts to describe model-authored reports,
   JSON model requirements, source-only retries and report failure recovery. Reuse
   the existing trusted-source marker and renderer; no new screen or setting.

The determinism boundary stays explicit: save acknowledgements, failures, lifecycle
state, recipients, source links, message identity and attention permissions come
from code and persisted records. The model authors report prose only. This prose
does not edit user data or authorize an action; no before/after acceptance UI applies.
Semantic accuracy remains a model limitation and is checked in the live proof.

## One implementation phase and its checks

Write red-first tests at the existing public seams, then make the smallest change:

- tests/unit/3151-background-read-gateway.test.ts: classified temporary failures
  have the flag; unknown/hostile/external throws and denials do not. Retain operation,
  effective write/destructive and owner guard negatives.
- tests/unit/3152-scheduled-report.test.ts: configured routing and bounded single
  attempt; source field projection; schema/identity/status bounds; escaped hostile
  source/model markup; fixed citation; missing model and invalid report failures.
- tests/integration/3151-scheduled-read.test.ts: supply a report double for existing
  lifecycle tests and update the registered-worker success expectation.
- tests/integration/3152-scheduled-report.test.ts: real worker role and gateway with
  model double; quiet temporary failure followed by success; exactly two retries
  then one failure; permanent/model failure without retries; cancellation/version
  changes during generation; access revoked during generation; stale snapshot;
  replay and concurrent delivery yield one result with distinct message identities.
  Source instructions cannot change the task, operation, recipient or allowance.
- Observe the source/write/cross-owner/cancellation/output guards fail when removed,
  restore them, rerun and retain bounded failure counts as mutation evidence.
- Update tests/uat/specs/3151-scheduled-owner-read.uat.spec.ts to assert supported
  source facts instead of exact deterministic wording. Add
  tests/uat/specs/3152-configured-source-report.uat.spec.ts and blocking rows in
  .claude/skills/coordinate/uat-trigger-map.tsv. Prove the model executes after the
  scheduled read, not merely during creation, with model activity evidence.

Expected exit code is 0 for each final verification command, all unpiped:

- pnpm exec vitest run tests/unit/3151-background-read-gateway.test.ts tests/unit/3152-scheduled-report.test.ts
- pnpm exec prettier --check <explicit changed paths>
- pnpm exec eslint <explicit changed TypeScript paths> --max-warnings=0
- pnpm typecheck
- scripts/run-gate.sh start, followed by scripts/run-gate.sh wait --follow as one
  background completion wait. This is the full isolated foundation gate; narrowed
  integration runs also go through the same script, never direct database commands.
- Real UI specs run on a new disposable from-source install, using the existing
  provisioner and sanctioned real-chat Codex login helper, with capture disabled.
  Claim a dev port as sched-3152, pass it as the provisioner's candidate port, and
  use JARVIS_IMAGE_TAG=uat-sched-3152. Never use the persistent proof instance or
  copy the box Claude login. Run against the discovered cheapest economy model.

The existing port injection is UatProvisionOptions.claimedWebPort in
tests/uat/provisioner.ts:617; no provisioning change is required.

The live test creates a real task through Tasks, schedules its status check in Main,
changes its status through Tasks, closes the browser page, then reopens to the sourced
normal report. Reload, reply, inspect Settings history, and verify only one result.
For a second check delete its source through the real UI before execution and verify
an access refusal with no title/status/source content. Prove quiet-hours persistence
with outward policy unchanged. No response interception, screenshots or test retries.

Verification adjustment: Tasks is core and exposes no delete or disable UI. The live
proof removes only its disposable source row as disclosed fault setup, following
the prerequisite proof. Creation, scheduling, status change, report, reply and
Settings history still use the real UI. Webmail links do not apply because Tasks
is the only supported source, as the coordinator explicitly confirmed.

The coordinator also confirmed the explicit creation errors and cancellation
behavior above. A cancelled turn must not start another model turn, and an
unavailable prerequisite must not imply that a check was saved. Hostile task titles
are tested through the report generator and schema as well as the renderer.
The narrowed isolated gate uses the added test:integration:3152 pnpm script.

Kill gate: after this single phase's first assembled live proof, the coordinator
decides whether to stop if the economy model cannot provide a supported sourced
report. At most one prompt correction; a second model failure is evidence to send,
not a reason to add loops, adapters, a pricier model or more scope.

## Review and closeout

Keep this plan current as decisions change. Commit only explicit owned paths and
push the branch. Rebase on origin/integration/scheduled-proactive before opening a
PR against integration/scheduled-proactive. Body: Part of #3152; release note
Category: N/A. Read CI and post live proof as a PR comment. Missing live proof is
reported as code-complete, unverified. Tear down every disposable install and process,
remove scratch artifacts, release the port and leave the worktree clean before
reporting the PR to the coordinator. Do not merge or change tracking boards.
