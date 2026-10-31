# Module job enqueue build plan (#3715)

Spec: `docs/superpowers/specs/2026-10-25-module-job-enqueue-design.md` (PR #3718).
Part of #3715; consumer: #3317 phase 2. Branch: `feat/module-job-enqueue`.

## Authorization and scope

The boot brief explicitly authorizes implementation against the draft using recommendations as
provisional defaults. Ben subsequently approved the slice plan in this session. This overrides
the usual approved-spec gate for this task, without marking the draft approved. Work stays in
`~/Jarv1s/.claude/worktrees/mod-job-enqueue`. No migrations, sibling-spec changes, merges, relays
or handoffs. Commit this plan before implementation. Finish at a complete slice boundary and
create separate GitHub task issues for every unfinished slice.

## Provisional decisions and remaining questions

- Use the chosen forks: `ctx.jobs.enqueue`, deterministic UUIDv5 job IDs, per-queue
  `allowModuleEnqueue`, no delay/start-after. Standard queue policy stays unchanged.
- Use caps of 5 calls per invocation, 10 pending and 120 hourly; Ben still must approve the numbers.
- Preserve today's disable/access-loss behavior (no cancellation). This is the safest compatibility
  choice because changing cancellation would affect every origin. Ben still must decide whether
  cancellation should be a separate follow-up.
- Manifest-declared quotas for third-party modules and applying strict schemas to all queues remain
  deferred platform questions; ask Ben whether to commission those changes, without widening v1.
- The spec does not select a UUID namespace literal. Slice 2 must choose and document a fixed
  platform namespace, with test vectors; treat it as permanent once jobs use it.
- Missing/false opt-in preserves existing schema behavior. True requires a valid schema with no
  free `string` at any depth. Bounded identifiers, enum literals and timestamps remain allowed
  exactly as specified; this is a schema restriction, not a claim that arbitrary module code can
  never encode content into allowed metadata fields.

## Verified seams (current starting tree)

| Capability                                                   | Evidence                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Queue declaration and params DSL                             | `packages/module-sdk/src/external-module.ts:96-131`                |
| Schema shape validation and value matching                   | `packages/module-sdk/src/module-params.ts:3-108`                   |
| Queue normalization currently spreads unchecked keys         | `packages/module-registry/src/external/validate.ts:310-379`        |
| Strict envelope, queue prefix, kind/hash and byte caps       | `packages/jobs/src/module-jobs.ts:50-96`                           |
| Existing lock/send shape on root DB                          | `packages/jobs/src/module-jobs.ts:98-128`                          |
| RPC bound to module, actor and risk; per-invocation counters | `packages/module-registry/src/external/worker-rpc-host.ts:154-216` |
| API tools and read candidate hooks share RPC construction    | `apps/api/src/external-module-tools.ts:60-75`                      |
| Worker checks active actor, status and both hashes           | `apps/worker/src/external-module-invoke.ts:159-194`                |
| Instance module predicate                                    | `apps/worker/src/worker-module-gate.ts:14-33`                      |
| API root DB and actor-active resolver already available      | `apps/api/src/server.ts:442-492`                                   |
| Reconciler tracks declared queues and per-user schedules     | `packages/module-registry/src/external/job-reconciler.ts:120-165`  |

The source is authoritative for each slice: recheck these seams after rebasing. Graph discovery
was used before source inspection. The existing schema validator allows scalar, array-of-scalar
and object-with-scalar/array fields; do not expand that DSL in this feature.

## Ordered session-sized slices

### 1. Manifest opt-in and schema restriction (this session)

Files: `packages/module-sdk/src/external-module.ts`,
`packages/module-registry/src/external/validate.ts`, a focused browser-safe validation helper if
needed to keep the main validator below 1000 lines, and
`tests/unit/external-validate-module-enqueue.test.ts`.

Add `readonly allowModuleEnqueue?: boolean` to `ExternalModuleQueueDeclaration`. Validate boolean
values; true requires a structurally valid `paramsSchema` and rejects free strings, including
array items and object fields. Reuse the canonical shape validator before walking typed schemas.
Do not expose `ctx.jobs` before the host path exists.

Behavioral checks: malformed flags and absent/malformed schemas rejected; direct/array/field
strings rejected; every allowed metadata scalar and array form retained through the public
`validateExternalModuleManifest` entrypoint. Absent/false flag still accepts legacy strings and
schema-less queues. Demonstrate the new negative cases failing before the guard exists, then
passing with it: this catches spread-through validation and an incomplete recursive walk.

This is internal manifest validation, with no UI or runtime enqueue surface; no app-map change
or UI e2e proof applies. Its assembled boundary test is the public manifest validator.

**Kill gate after slice 1:** stop before adding runtime authority if valid metadata schemas cannot
survive public validation, legacy queues regress, or the stricter rule cannot be localized without
changing existing origins. Ben/coordinator decides whether to revise the design. Evaluate the
observed results before detailing later implementation. Session scope may stop here so sufficient
context remains for verification, issues, rebase, PR and coordinator reporting.

### 2. Atomic queue primitive and real pg-boss proof

Files: a focused `packages/jobs/src/module-job-enqueue.ts`, `packages/jobs/src/index.ts`, shared
SDK result types, and `tests/integration/module-job-enqueue.test.ts`.

Export `enqueueModuleJobForActor` with the spec signature. Validate the existing envelope; derive
UUIDv5 from module/queue/actor/key, never returning the ID. Hold one module/actor advisory lock
across duplicate check, counts and send. Count all origins on all declared module queues; duplicates
precede limits. Document retention and namespace. Keep manual/scheduled/reconcile paths unchanged.

Execute real pg-boss checks for spec cases 7-11, 13 and 17: duplicate at cap, actor separation,
pending/hourly boundaries, race at nine pending, all-origin counts and absence of raw key text.
Remove the pending guard temporarily and observe its test fail; restore and record the result.
This slice is a prerequisite, not a complete feature; RPC must not ship without these checks.

### 3. SDK port and invocation-scoped RPC guard

Files: `packages/module-sdk/src/worker.ts`, SDK public exports,
`packages/module-registry/src/external/worker-rpc-host.ts`, a focused RPC helper if useful, and
focused worker SDK/RPC unit tests.

Add `ModuleJobsPort`/`ModuleJobEnqueueResult` and bind `ctx.jobs.enqueue` to `jobs.enqueue`.
Implement spec check ordering, exact keys/formats, own declared opted-in queue only, five-call
per-invocation counter, injected enqueue port, inactive mapping and scrubbed limited warning.
No queue IDs/counts/params in responses/logs. Test spec cases 3-5, 12, 14 and 15 at the RPC boundary;
observe security tests fail with their protections removed. Missing port refuses the call.

### 4. Composition roots, runtime proof and author documentation

Files: `apps/api/src/external-module-tools.ts`, `apps/api/src/server.ts`,
`apps/worker/src/external-module-invoke.ts`, `apps/worker/src/external-module-job-handler.ts`,
`apps/worker/src/worker.ts`, `tests/integration/module-worker-queue-enqueue.test.ts`,
`docs/module-developer-guide.md`.

Wire both tool and worker paths to slice 2 through the current actor/module/hash and live module
checks. Briefing stays read-only. Integration tests exercise actual tool RPC and queue workers,
covering spec cases 1-6, 14-16 and 17 through these production construction sites, including
retry-after-enqueue, inactive actor/module and compatible/incompatible schema upgrades.

Document the complete port, opt-in, allowed schema, idempotency retention/regeneration, limits,
rebuild/older-host behavior and upgrade compatibility. No new core app-map surface; Meals owns
its stalled/resume behavior and the real chat-started, closed-page live proof in its own PR.
Do not declare #3715 complete until all four slices pass. No merge in this session.

## Verification and publication

Expected exit code 0 for each successful command; commands are never piped:

- `pnpm install` before work (completed).
- `pnpm exec vitest run tests/unit/external-validate-module-enqueue.test.ts tests/unit/external-validate.test.ts`
- `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck`.
- Slice 1 static gate: `scripts/run-gate.sh start --gate verify:static`, then
  `scripts/run-gate.sh wait --follow` using the
  returned log and a detached tool session. Only this skill-managed throwaway DB procedure may
  run DB checks. Inspect the actual exit code; any failures must be named, never called green.
  Full `verify:foundation` belongs to the runtime/database slices; slice 1 changes only pure
  manifest validation and is covered by the static gate plus the two focused validator suites.

For leftover slices, create one `task` issue each with `Part of #3715`, ordering/dependencies,
owned paths, tests and security mutation evidence required. Link them here and in the PR;
none closes #3715. Publication ruling from Ben: open the single build PR against `docs/module-platform-specs`,
without committing any spec files. Keep this plan in the build PR. Retarget to `main` once
PR #3718 merges. A rebase onto current `origin/main` was performed before this ruling; the final
build commits are based on the spec branch to keep the PR diff limited to this build. Fill Release note with `Category: N/A` for internal-only
work, list every pending Ben question, push, report the PR to coordinator w1:p1E using
`docs/agents/herdr-pane-message.md`, and verify the worktree is clean.

## Rulings and slice evidence

- Boot brief explicitly permits provisional implementation against the draft; Ben approved the
  slice approach. Existing runtime gates remain untouched by slice 1.
- Slice 1 baseline: public-validator tests exited 1 with 15 rejection cases failing and
  35 acceptance/compatibility cases passing before the guard was added. This directly observes
  the missing protections. With guards added, both validator suites passed: 113 tests,
  including all 50 new cases. Root `tsc --noEmit`, scoped lint, touched-file formatting and
  file-size checks also passed.
- Remaining slice 2: #3720; slice 3: #3721; slice 4: #3722. These are ordered prerequisites,
  not completed work. #3715 and the Meals consumer remain blocked on their delivery.
- This session stops after slice 1 to preserve room for complete verification and publication;
  no RPC/runtime capability is exposed by this slice.

- Publication follow-up authorized by Ben: Finance alone is bumped from 0.6.11 to 0.6.12,
  with its existing version assertion updated, so the rebuilt registry artifact has a new
  version. #3731 will rebase on this bump and own its subsequent bump. The read-only registry
  check is rerun; signed release upload belongs to the existing main-merge workflow.
- Baseline artifact evidence is preserved in #3732: Finance built using the spec branch's
  tracked sources and this branch both produced SHA-256
  `89607cee1d7b3c44c7b2cd303140ebc168e76d135306b1813861abc0a0467dc0` (73,685 bytes),
  versus published 0.6.11 at 73,677 bytes. The SDK type change emitted identical JavaScript.
  The version bump proceeds under Ben's explicit coordination ruling rather than rewriting
  that observation as proof that this type-only change altered the artifact.
- The initial static gate passed lint and was deliberately stopped during formatting when the
  Finance bump was assigned, to avoid reporting stale gate inputs. Final validation is rerun.

### Slice 2 delivered (#3720)

- `enqueueModuleJobForActor`, `deriveModuleJobId` and `ModuleEnqueueLimits` live in
  `packages/jobs/src/module-job-enqueue.ts`. The SDK gained the `ModuleJobEnqueueResult` type only.
  No RPC, port, migration or change to the manual-run, schedule or reconcile paths.
- Job identity namespace: `71dd6e02-9cde-4943-ac23-3a72e0464852`, chosen by the Meals build and
  permanent once any job uses it. Version 5 is implemented with `node:crypto` because no UUID
  library is in the jobs dependency tree. Fixed vectors come from Python's `uuid.uuid5` and are in
  `tests/unit/module-job-enqueue-id.test.ts`.
- The function reuses `withModuleEnqueueLock` from #3735 (shared module barrier plus the per-actor
  lock), so it cannot interleave with a disable sweep.
- Real pg-boss suite: `tests/integration/module-job-enqueue.test.ts` (10 tests, spec cases 7-11,
  13, 17, plus a sendModuleJob-counts test and a bad-format test). Run with
  `scripts/run-gate.sh start --gate test:integration:3720`.
- Mutation result: with the pending check removed, 5 of 10 tests failed (7, 9, 10, 13 and the
  sendModuleJob count test). With the check restored, all 10 passed.

### Slice 3 delivered (#3721)

- SDK: `ModuleJobsPort` and `ctx.jobs.enqueue`, bound to the RPC method `jobs.enqueue`. Only
  queue, jobKind, idempotencyKey and optional params go on the wire. The result type is slice 2's
  `ModuleJobEnqueueResult`.
- RPC host (`worker-rpc-host.ts`): optional injected `enqueueJob` port and the spec's checks in
  order: read risk (`forbidden_enqueue_mutation`), no port (`invalid_rpc`), exact keys and
  formats (`invalid_rpc`), own opted-in queue read from the handler's own manifest
  (`undeclared_queue`), per-invocation cap of 5 counted after the queue check
  (`limited: invocation`, port not called), then the port. `inactive` throws `module_inactive`,
  `invalid_params` throws `invalid_job_params`, any other port error becomes a generic
  `invalid_rpc` with no key or params text. Every `limited` result logs one warning with module,
  queue, job kind and limit name only.
- Constants beside the AI cap: `JOB_ENQUEUE_CALLS_PER_INVOCATION_CAP` (5) and
  `MODULE_ENQUEUE_LIMITS` (`{ pending: 10, hourly: 120 }`, slice 2's type) so slice 4 passes the
  same numbers to the primitive. No env var.
- Decision: the port result gains a third host-internal value, `invalid_params`. Step 7 runs
  inside the port and the primitive throws a plain Error for a bad payload. Without a distinct
  result the host would mislabel a database failure as bad params, or the registry package would
  have to recognise a jobs error class. Slice 4's composition root runs `assertModuleJobPayload`
  before the primitive and returns `invalid_params` on failure, which keeps the spec's order.
- No composition-root wiring. Every production construction site has no port, so a real call
  gets `invalid_rpc` until slice 4 (#3722).
- Version bumps: the registry check named Finance 0.6.12 and Food 0.3.12 (Job Search was not
  named). Bumped to 0.6.13 and 0.3.13; the Finance version assertion in
  `tests/unit/park-press-integration.design.test.ts` follows. The check passes locally after.
- Tests: `tests/unit/external-module-jobs-enqueue-port.test.ts` (12) and one serialization test in
  `tests/unit/module-sdk-worker.test.ts`. The port test builds its port on the real
  `assertModuleJobPayload`.
- Mutation results (each protection removed, test run, then restored and green):
  risk gate removed, 1 failed; exact-keys check removed, 1 failed; own-queue check removed,
  2 failed; counter increment removed, 1 failed; inactive mapping removed, 1 failed.

### Slice 4 evidence (#3722)

- Delivered: `createModuleEnqueuePort` builds the `enqueueJob` port. The API tool path
  (`external-module-tools.ts`, `server.ts`) and the worker queue path (`external-module-invoke.ts`,
  `external-module-job-handler.ts`, `worker.ts`) both call it, so the live check, the payload
  check and the limits cannot drift. A candidate hook shares the tool RPC construction, so it receives the port, and the slice 3 read-risk check refuses its call before the port is reached (row 14). Only the briefing invoker is unwired.
  The developer guide gained section 13.2.1. No migration, env var, or change to the manual-run
  route, schedules or reconcile jobs.
- Where the factory lives: `packages/module-registry/src/external/module-enqueue-port.ts`,
  exported from `@moss/module-registry/node`. That package already owns the port type and the
  limit constants and already depends on `@moss/jobs`. Both apps import it without reaching into
  another module's internals. The worker's live predicate (module enabled plus actor membership)
  is assembled in `apps/worker/src/external-module-enqueue.ts`; the API's comes from the active
  module resolver via `isExternalModuleActiveFor`.
- Why `invalid_params` is a result and not a thrown type: the primitive throws plain `Error`s for
  a bad payload. Recognising a typed class would change slice 2's code, so the factory runs
  `assertModuleJobPayload` itself and maps a throw to `invalid_params`.
- Tests: `tests/integration/module-worker-queue-enqueue.test.ts` (13, script
  `test:integration:3722`) on a real worker runtime, a real pg-boss and the production
  construction sites. Rows 1 to 6, 14, 15 (both roots, two causes each), 16 and 17.
- Mutation results (each protection removed, suite run, then restored and green):
  API live check removed, 2 failed (row 15 api root, both causes); worker live check removed,
  2 failed (row 15 worker root, both causes); actor taken from outside the bound context,
  3 failed (rows 1, 2 and 16).
- Status: code-complete, not live-proved. Live proof comes with the Meals PR.
