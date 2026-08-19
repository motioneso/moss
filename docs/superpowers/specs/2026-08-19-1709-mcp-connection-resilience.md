# #1709 — MCP Connection Resilience

**Date:** 2026-08-19

**Status:** Draft — needs Ben's approval

**Issue:** [#1709](https://github.com/motioneso/moss/issues/1709)

## Context

Found during live dogfood testing (2026-08-19): when a connector/module call drops mid-flight, the
failure surfaces as a raw error the assistant has to explain to the user, mid-conversation. A dropped
connection is an infrastructure detail, not something the assistant should have to narrate or the
user should have to see.

Repository triage on the issue (see the issue's grounding comment) found that "MCP connection" in
product terms means the call boundary in `apps/worker/src/external-module-invoke.ts` and
`external-module-job-handler.ts` — every scheduled job, briefing contribution, and tool call into a
connector/module worker process goes through the shared trust gate built there
(`createVerifiedExternalModuleInvoker`). There is no separate outbound MCP client wrapper anywhere in
the codebase; `packages/chat/src/mcp-transport.ts` is Moss acting as an MCP _server_ for external
assistants, not a client of any outbound connector. So "MCP connection drop" and "external module
invocation drop" are the same event today.

The only resilience that exists at that boundary right now is generic: pg-boss's per-queue
`retryLimit` (`packages/jobs/src/pg-boss.ts`), which retries a _failed job_ after it has already
failed and already produced a `failed` row with a raw error message in `output`
(`external-module-job-handler.ts`'s own comment on why a declined invocation throws rather than
resolving). Nothing retries a transient connection drop _before_ it becomes a job failure, and
nothing distinguishes "the module process dropped mid-call, try again" from "the module rejected this
call for a real reason."

## Goals

1. A transient connection drop between the worker and an external module's child process is retried
   automatically, with bounded attempts and backoff, before it is ever treated as a failure.
2. A tool call or job that lands while a drop is being retried is queued and completes once the
   connection recovers, rather than failing immediately.
3. Nothing about connection state — "reconnecting," "retry N of M," a raw transport error, a process
   PID, a socket/child-process error message — ever reaches a system message the assistant model can
   see, and therefore never reaches the user.
4. A drop that exhausts its retry budget still surfaces as a real, honest failure — this spec removes
   invisible noise, not honest error reporting.

## Non-Goals

- A general-purpose outbound MCP client for third-party MCP servers. No such client exists in this
  codebase today; this spec resilience-hardens the existing external-module invoke boundary, not a
  new protocol client.
- Changing the trust gate itself (`not-active` / `not-discovered` / `not-enabled` / `hash-mismatch`).
  Those are policy rejections, not connection drops, and must keep failing immediately and visibly in
  logs exactly as they do today.
- Changing pg-boss's per-queue `retryLimit` values or retry semantics.
- A user-facing connection-health indicator or settings surface. This spec is about making drops
  invisible, not about surfacing a new status UI.
- Retrying non-transient failures (module-thrown application errors, validation errors, timeouts from
  `invocationHardTimeoutMs` being legitimately exceeded by slow module logic). Only connection-level
  failure is in scope; see Resolved Decisions for the exact classification.

## Resolved Decisions

| Decision                                               | Choice                                                                                                                                                                                                                                                                                                                                                                        | Reason                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the retry lives                                  | A bounded retry+backoff wrapper _inside_ `createVerifiedExternalModuleInvoker`, wrapping only the `deps.runtime.invoke(...)` call, after the trust gate and before the result is returned                                                                                                                                                                                     | The trust gate's rejections are policy decisions, not connection drops, and must stay immediate and unwrapped. Both existing callers (job handler, briefing invoker) get the retry automatically since both already call through this one function. |
| What counts as retryable                               | Only errors that indicate the module's child process was unreachable or died mid-call — the categories `ExternalModuleWorkerError("crash")` and a connection-level rejection of the in-flight `invoke()` promise from `worker-runtime.ts`'s process lifecycle handling. Everything else (module-thrown RPC errors, hard-timeout expiry, trust-gate rejections) is not retried | A drop is specifically "the transport died," not "the call failed." Retrying a module's deliberate error or a legitimate timeout would silently change job semantics and could double-run a write.                                                  |
| Retry budget and backoff                               | Small bounded budget (e.g. 3 attempts) with short exponential backoff, deliberately smaller and faster than the pg-boss job-level retry window, so a transient drop resolves within one job attempt instead of ever reaching pg-boss's retry                                                                                                                                  | Keeps the two retry layers from competing: this wrapper absorbs sub-second-to-few-second drops invisibly; pg-boss's existing `retryLimit` remains the outer safety net for a drop that outlasts this budget.                                        |
| What happens on budget exhaustion                      | The wrapper re-throws the original connection error unchanged, so the job handler's existing throw-on-`!outcome.ok` path and pg-boss's `retryLimit` behave exactly as they do today                                                                                                                                                                                           | No new failure shape to design or test; exhaustion degrades to today's already-correct behavior instead of inventing a second one.                                                                                                                  |
| Queuing mid-drop                                       | **Open question — see below.** Recommendation: reuse the job queue's existing retry semantics (pg-boss's per-queue `retryLimit`/backoff) as the queuing mechanism for a call that arrives mid-drop, rather than building a second, in-process queue on top of the retry wrapper                                                                                               | Two retry/queue mechanisms stacked at the same boundary are a coordination hazard (double attempts, unclear ownership of "how many total tries"); pg-boss already durably queues and retries.                                                       |
| System-message isolation                               | The retry wrapper never logs, throws, or returns anything containing retry-in-progress state to the RPC/tool-result path; only `deps.logger?.warn` (existing structured logger, not model-visible) sees intermediate attempts. The model only ever sees a final success or the final, budget-exhausted failure                                                                | Matches the existing pattern in `external-module-invoke.ts`, where the structured logger is explicitly carved out as "REJECTIONS only, never the happy path" and never touches the RPC response shape.                                              |
| Distinguishing a drop from a real module error in logs | Log one structured line per attempt (`event: "external_module.invoke_retry"`, attempt number, moduleId, lane) at the existing `warn` level, and one final line if the budget is exhausted, so operators can diagnose a flapping module without any of it leaking into the tool-call result                                                                                    | Mirrors the trust-gate's own rejection logging (`external_module.trust_gate_rejected`) — this repo's established pattern for boundary-level diagnostics that must never reach the model.                                                            |

## Architecture

### Retry wrapper placement

`createVerifiedExternalModuleInvoker` (`apps/worker/src/external-module-invoke.ts`) currently calls
`deps.runtime.invoke(...)` once, directly, after the trust gate passes (lines 216-227). The wrapper
sits at exactly that call site: the trust gate, rpc-handler construction, and `{ ok: true, result }` /
`{ ok: false, reason }` return shape are unchanged. Only the single `await deps.runtime.invoke(...)`
line becomes `await retryOnConnectionDrop(() => deps.runtime.invoke(...), { logger: deps.logger,
moduleId: args.moduleId, lane: args.lane })`.

Both existing callers — `createExternalModuleJobHandler` (queue jobs) and
`createExternalBriefingInvoker` (briefing contributions) — go through `createVerifiedExternalModuleInvoker`
already, so both gain the retry with no per-caller change.

### Classifying a connection drop

`packages/module-registry/src/external/worker-runtime.ts` already distinguishes process lifecycle
failure (`ExternalModuleWorkerError("crash")`, thrown when a module's child process exits or is
force-stopped mid-invocation) from a module-thrown RPC error (surfaced through the same `invoke()`
promise but originating from the module's own handler, not the transport). The retry wrapper matches
on this existing error shape rather than introducing a new one; it does not change
`worker-runtime.ts`'s error types.

### What stays out of the assistant's view

The RPC/tool-result path a chat tool call ultimately returns to the model already only ever produces
a tool result or a thrown error at the `VerifiedExternalModuleInvokeResult` boundary — this spec adds
no new field to that type and no new value the model-facing serializer would need to special-case.
Retry attempts are only ever visible through `deps.logger`, which is wired to the worker's structured
process log, never to a system message, a tool result, or a job's `output` column that a chat surface
reads back.

## Security and Privacy

- No change to the trust gate: active-user membership, `enabled` status, and manifest/package hash
  checks still run before any retry logic is reached, and still reject immediately and visibly.
- No change to what data crosses the RPC boundary; the retry wrapper only re-invokes the same
  already-verified call with the same already-scoped `AccessContext`, never with different params or
  a different actor.
- Retry log lines carry only `moduleId`, `lane`, `jobKind`/`requestId`, and attempt count — no params,
  no secrets, no module output — matching the existing metadata-only logging pattern at this boundary.
- A bounded retry budget with backoff prevents this from becoming an unbounded-retry amplifier against
  a genuinely down module; the budget is deliberately smaller than pg-boss's own retry window (see
  Resolved Decisions).

## Verification

### Focused automated checks

1. A simulated connection-drop error (the same shape `ExternalModuleWorkerError("crash")` produces)
   on the first attempt, followed by success, resolves the invocation successfully with no thrown
   error and no `not-*` rejection reason.
2. A connection drop on every attempt up to the retry budget re-throws the original error unchanged,
   and the job handler's existing `outcome.ok === false` / throw path still fails the pg-boss job
   exactly as it does today.
3. A non-connection error (a module-thrown RPC error, or a genuine hard-timeout expiry) is not
   retried — it propagates on the first attempt.
4. A trust-gate rejection (`not-active`, `not-discovered`, `not-enabled`, `hash-mismatch`) is
   unaffected by the retry wrapper — it still returns immediately with no retry attempt logged.
5. Retry attempts produce only the structured `warn`-level log line; the returned
   `VerifiedExternalModuleInvokeResult` and any thrown error contain no retry-count, backoff, or
   connection-state field.
6. Both `createExternalModuleJobHandler` and `createExternalBriefingInvoker` exercise the same retry
   wrapper (constructed once, inside `createVerifiedExternalModuleInvoker`) rather than each caller
   needing its own retry logic.

### Required live-path proof

This is an internal resilience change with no new UI surface. Live-path proof is: on the exact
implementation head, exercise a real external-module tool call end-to-end (chat or a scheduled job
against an installed module) while forcibly killing the module's worker child process mid-call, and
confirm the call completes successfully with no error visible in the chat transcript or job output,
and that the retry is visible only in worker process logs. Record the exact reproduction steps and
log evidence on the PR.

## Open Questions

- **Q1 — Is pg-boss's existing retry the right mechanism for "queuing mid-drop," or does this need a
  second in-process queue at the invoke boundary?** The issue's own scope note names this as open.
  Repository triage recommends reusing pg-boss's existing per-queue `retryLimit`/backoff as the
  queuing mechanism (see Resolved Decisions), since a queue job that lands mid-drop already gets
  pg-boss's durable retry if it fails, and a second, in-process queue on top of the retry wrapper adds
  a second place a call can be waiting with no clear ownership of the combined retry budget. The
  briefing-invoker path has no queue underneath it at all (it throws synchronously on a declined
  outcome), so a call arriving there mid-drop would rely entirely on the retry wrapper's own budget,
  not on any queue. **Recommendation: reuse pg-boss's retry semantics for the queue path; accept that
  the briefing path's only protection is the retry wrapper's budget, since briefings already treat a
  failed module contribution as "no contribution," not a user-visible error.** _Need Ben's call before
  implementation._
- **Q2 — Exact retry budget and backoff values.** This spec deliberately does not pin numbers (e.g.
  3 attempts, 250ms/500ms/1s backoff) so the build task can tune them against real drop durations
  observed in dogfood logs rather than a guess made at spec time. **Recommendation: implementation
  task picks values and documents the observed drop duration that justified them.**

## Exit Criteria

- A transient connection drop at the external-module invoke boundary is retried automatically, within
  a bounded budget and backoff, before it is treated as a job or tool-call failure.
- A call that lands mid-drop still completes once the connection recovers, using the queuing
  mechanism Q1 resolves.
- No retry attempt, backoff delay, or connection-state detail ever appears in a system message, tool
  result, or chat-visible output — only in the worker's structured process log.
- A drop that exhausts the retry budget still fails honestly, with the same error shape and job
  behavior as today.
- Trust-gate rejections and non-connection errors are provably unaffected by the retry wrapper.
- Both existing invoke-boundary callers (queue jobs, briefing contributions) share one retry
  implementation, not two.
- Focused automated checks and the live-path drop-and-recover proof are green.

## Hard Invariants Honored

- Spec before build: this document must be approved before an implementation plan is written.
- Module isolation: no change to how modules collaborate with the platform; the retry wrapper is
  entirely on the worker's side of the existing RPC boundary.
- Metadata-only job payloads: retry logging adds no new payload field and carries no content, prompts,
  or secrets.
- Provider-agnostic AI: no change to AI routing; this boundary carries module RPC calls, not model
  calls.
