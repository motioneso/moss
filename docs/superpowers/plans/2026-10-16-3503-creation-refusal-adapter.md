# #3503 creation-only admission implementation plan

Implement the approved target in companion specification
`docs/superpowers/specs/2026-10-16-3503-creation-refusal-adapter.md` only under subsequent exact
coordinator grants. These documents do not grant product writes, checks, installation or runtime.
Standing Stage 4 authorization supersedes historical routine human/local-only permission gates;
coordinator technical disposition, finite leases, independent review and genuine evidence remain required.
Do not expand the prospective lease without a new technical disposition. N1 remains STOP/RESLICE,
unimplemented and unaccepted; runtime NOT_RUN.

## Exact prospective code lease

Five NEW files:

- `apps/api/src/n1-admission-activation.ts`
- `packages/chat/src/live/n1-turn-admission.ts`
- `tests/unit/n1-provider-admission-public-path.test.ts`
- `tests/uat/run-3503-creation-refusal.ts`
- `tests/uat/specs/3503-tasks-creation-refusal.uat.spec.ts`

Fifteen AMEND files:

- `apps/api/src/server.ts` — `createApiServer` activation before route registration.
- `packages/module-registry/src/index.ts` — `BuiltInRouteDependencies`/`registerBuiltInApiRoutes` chat wiring.
- `packages/chat/src/index.ts` — public types.
- `packages/chat/src/routes.ts` — `ChatRoutesDependencies`/`registerChatRoutes`.
- `packages/chat/src/live/runtime.ts` — `CreateChatSessionRuntimeDeps`/`createChatSessionRuntime` forwarding.
- `packages/chat/src/live/chat-session-ports.ts` — `ChatSessionManagerDeps` and optional resolver admission argument.
- `packages/chat/src/live/persistence.ts` — `DataContextChatPersistence` forwarding.
- `packages/chat/src/live/chat-session-turn.ts` — `runChatTurn` claim, outer barrier and finally.
- `packages/chat/src/live/pre-model-turn.ts` — early `tryPreModelTurn` N1 branch.
- `packages/chat/src/scheduled-reads/generation.ts` — `createScheduledReadResolver` fixture binding/callback.
- `packages/ai/src/structured/generate-structured.ts` — AI-owned callback/options/additive failure reason.
- `packages/chat/src/live/errors.ts` — admission error.
- `packages/chat/src/live-routes.ts` — `handleLiveRouteError` mapping.
- `packages/chat/src/manifest.ts` — applicability, error and remediation metadata.
- `tests/uat/provisioner.ts` — optional `N1ProvisionBinding`, generated override threading,
  single attempt/build refusal and opt-in safe failure collection.

Only the two existing canonical companion spec/plan documents accompany this code lease.
No provider/classifier/Tasks implementation, startup-script or additional export-file change is implicit.
The existing AI barrel exports the owning structured module; Tasks repository is already public.
`N1ProvisionBinding` is exactly
`{runId,projectName,imageDigest,controlDirectory,overridePath,manifestSha256,claimedWebPort}`;
validate paths under the new private run directory. API reads one fixed manifest; no request endpoint enables it.

## Ordered build and proof

1. Commit truthful approved canonical spec/plan before code. Use repository shared-checkout procedure,
   confirm ownership, inspect every changed line and stage/commit explicit owned paths only.
   Record exact authoring base and task linkage in the implementation handoff. Publication follows
   later exact review/disposition; no historical local-only permission restriction is reinstated.
   Freeze the launcher/fixture contract from the spec; absent real artifact/provider witnesses remain
   future execution holds, never invented receipts.
2. Under a finite code grant, write the nine fixed offline groups below first. Each group is at most
   five seconds, with fake I/O only. Groups 1–7 each send exactly ONE authenticated Fastify public
   POST through real `registerChatLiveRoutes`, manager, pre-model, scheduled resolver and structured
   orchestration. Fake persistence, clock, transport and engine only; fixed owner/Main/task UUID
   fixtures and exact N1 prompt. Group 8 has zero POSTs; group 9 is supplemental direct lifecycle
   stimulus. Total public POSTs per full suite is seven. Never claim these are a live Main trial.
3. Implement only the leased activation/forwarding/admission/barrier/error seams and UAT adapter.
   Preserve optional defaults, module boundaries and the original strict one-attempt interpretation.
   Enforce synchronous consumption before adapter dispatch, never refund, and preserve existing
   one-use prepared closures and `maxAttempts1`. Complete chat app-map metadata in the same product PR.
   New UAT spec must refuse accidental generic discovery outside the dedicated exact launch context.
4. Run the fixed guard-on/guard-off cycle below under a separate finite check grant, retaining raw
   exits. Restore immediately after each mutation. Two identical failures mean stop/rethink.
   No dependency installation or unrelated repairs under that check slice.
5. Freeze exact implementation diff/hashes, compatibility/app-map/default-behavior results and actual
   guard-on/off exits. Obtain distinct independent Standards and Spec review and coordinator technical
   disposition before installation. Static reviewers must trace success, refusal, preflight failure,
   provisioning failure, timeout, interruption and teardown to safe collection and owned cleanup.
6. Later reviewed artifact must contain this admission and these controls. Before runtime, separately
   establish approved source-to-image provenance, exact installed source/image/route correspondence,
   provider readiness, total-call/background coverage, time interruption, collector and cleanup proof.
   Neither startup permit nor runtime labels nor fake tests certify those properties. Refresh exact
   witnesses/preflight and obtain a finite original-trial grant. DB-touching checks require
   `verify-gate` and its `run-gate` wrapper. No foundation/DB/UAT execution occurs in the offline phase.
7. The later original trial remains one fresh install, synthetic owner, UI-created standalone
   nonrecurring task and one Main POST with the exact prompt from the spec. One structured generation;
   zero classifier/conversation/report generations; no retry, parallel case, extra chat, delivery wait,
   recurrence, task mutation, deletion/revocation, credential setup or implicit build. Enforce monotonic
   setup 300s, observation 120s, cleanup 120s within 540s absolute and teardown before due time.
   Keep all-path metadata-only collection and owned browser/worker/project/volumes/network/temp/control
   directory/boot marker/port cleanup; cancellation stops dispatch and absence must be verified.
   Cleanup failure overrides the verdict. Exit 0: exact creation NOT_REPRODUCED; exit 1: correlated
   schema refusal REPRODUCED; exit 2: admission/other/ambiguous/limit/cleanup BLOCKED/INCONCLUSIVE.
   A passing trial does not prove intermittent #3503 fixed or satisfy R05-C1/P2/Stage 4 acceptance.

## Nine fixed offline groups

1. Schema-valid unmatched UUID, recognition gate enabled.
2. Same unmatched result, recognition gate disabled.
3. Valid deterministic schedule creation.
4. Correlated original schema refusal.
5. First provider dispatch rejects.
6. Cancellation after first dispatch starts, followed by late transport settlement.
7. Unconfigured ordinary turn with matching prompt takes its existing classifier/conversation flow.
8. Exactly twelve zero-POST fake activation rows, listed below.
9. Two fresh actual prepared closures sharing the same open admission, specified below.

Groups 1/2 assert HTTP 409 and interpreter=1, classifier=conversation=report=launch=submit=0.
Groups 3/4 assert one interpreter, zero fallback and the correct original response/outcome.
Groups 5/6 assert no refund and zero fallback; they are NOT the distinguishing consumed-only control.
Groups 1–6 use actual server-derived fixture binding with fake owner-scoped data; no client activation.

Group 8 rows are fixed: (1) file+digest absent => ordinary; (2) valid => capability and one boot marker;
(3) client-only request flag => ordinary; (4) unknown key => startup denial; (5) digest without file =>
denial; (6) symlink => denial; (7) wrong owner/mode => denial; (8) content-hash mismatch => denial;
(9) witness-binding mismatch => launcher preflight denial; (10) expired => denial;
(11) existing marker => denial; (12) claim-write failure => denial. No row dispatches a model call
or adds a chat case.

Group 9 uses actual `N1TurnAdmission` and actual `prepareStructuredGeneration`/`runPreparedModel`,
with fake repository/cipher/DB/transport. At fake t=0 create ONE admission, live signal,
deadline=120000, and capture its bound callback D ONCE. Prepare TWO DISTINCT fresh closures A/B
with the identical D reference, schema/input and fake transport. Preserve each existing single-use
closure and `maxAttempts1`. Fake transport increments `calls`, then rejects a fixed synthetic Error.
Await A fully: assert calls=1 and provider_error. At fake t=1 invoke B for its FIRST time BEFORE
ANY admission close/finally, abort or expiry. Immutable assertions: B is provider_error with reason
admission_denied; calls===1; consumed===true; closed===false; signal.aborted===false.
Test finally closes admission only AFTER B settles. Neither closure is recalled. This explicitly
supplemental offline guard witness never substitutes for the original Main trial or adds a real POST.

## Exact mutations and bounded commands

M1 removes ONLY the N1 fallthrough terminal barrier set. Run the SAME groups 1/2 assertions;
require nonzero exit because forbidden classifier/engine work becomes reachable. Restore.

M2 disables ONLY `if(consumed) return 'deny'` in the new admission dispatch function. Preserve
consumed assignment, closed/abort/deadline checks and original per-closure guards. Run the SAME
group 9 assertions: A dispatches; B's unused closure reaches transport, calls=2 and provider_error
without admission_denied, so unchanged assertions MUST fail. Restore. Never close between A/B,
force early cancellation or mutate original closure guards; each would mask this mutant.

Four Vitest invocations, in this exact order, each with a 120-second command deadline:

```bash
timeout 120s pnpm exec vitest run tests/unit/n1-provider-admission-public-path.test.ts
# After M1 only:
timeout 120s pnpm exec vitest run tests/unit/n1-provider-admission-public-path.test.ts -t 'N1 public unmatched'
# After restoring M1 and applying M2 only:
timeout 120s pnpm exec vitest run tests/unit/n1-provider-admission-public-path.test.ts -t 'N1 shared admission two preparations'
# After restoring M2:
timeout 120s pnpm exec vitest run tests/unit/n1-provider-admission-public-path.test.ts
```

Also run once each, under the same finite check disposition:

```bash
timeout 120s pnpm exec tsc --noEmit --incremental false -p tsconfig.json
```

Run `timeout 120s pnpm exec eslint` with the exact twenty code paths listed above and
`--max-warnings=0`, and `timeout 120s pnpm exec prettier --check` with those twenty code paths plus
these two canonical documents. Expand explicit paths; no directory-wide sweep, install, hidden retry
or piped exit masking. A missing tool is a reported check limitation, never a passing check.
No check above has been run or passed by preparing these documents.
