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
  the missing protections; follow-up passing results will be recorded before publication.
- Remaining slice 2: #3720; slice 3: #3721; slice 4: #3722. These are ordered prerequisites,
  not completed work. #3715 and the Meals consumer remain blocked on their delivery.
- This session stops after slice 1 to preserve room for complete verification and publication;
  no RPC/runtime capability is exposed by this slice.
