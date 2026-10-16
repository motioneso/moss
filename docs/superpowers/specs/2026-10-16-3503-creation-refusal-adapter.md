# #3503 Tasks-creation refusal adapter specification

This task prepares a bounded creation-only test adapter. It does not reproduce, diagnose, fix or close #3503.
The existing 3151/3152 UAT helper creates two schedules, executes a report, sends another chat turn and removes a source.
Its failure path can capture full logs/transcripts. This task adds a narrower adapter without changing product behavior.
Owner agreement to this exact public contract, coordinator approval of the implementation plan, a task issue and committed docs precede code.
No new UI, API, schema, prompt, validation, retry, provider-routing or app-map behavior is introduced.

## Public behavior contract for a later authorized run

Use one fresh disposable solo-admin install and one synthetic owner, with an already authorized, ready economy JSON route.
Sign in through supported UI. Create one standalone nonrecurring Task titled `3503 synthetic creation probe` through Tasks UI.
In Main chat send exactly once: `Check the status of my task 3503 synthetic creation probe in 30 minutes`.
Use the existing `POST /api/chat/turn` path and inspect its result plus Scheduled settings for one matching schedule.
Do not send another chat turn, mutate task status, delete a source, wait for delivery, or exercise recurrence/revocation.
The 30-minute timing intentionally isolates creation; it is not an exact replay of the historical 45-second case.
NOT_REPRODUCED requires a successful creation response, one matching confirmation/saved schedule, and no refusal diagnostic.
REPRODUCED requires creation refusal plus a correlated `schema_validation` / `validation_failed` scheduled-read diagnostic.
Other refusals, missing readiness, transport failures, ambiguous correlation, limit violations or failed cleanup are BLOCKED/INCONCLUSIVE.
Keep strict schema validation and one interpretation attempt. A fake model output cannot count as live reproduction.
The existing specs `3151-scheduled-owner-read.uat.spec.ts` and `3152-configured-source-report.uat.spec.ts` remain unchanged.
Their shared `scheduled-source-live-proof.ts` is linkage/context, not this narrower test specification.

## Adapter boundary and limits

Code ownership is exactly `tests/uat/run-3503-creation-refusal.ts`, `tests/uat/specs/3503-tasks-creation-refusal.uat.spec.ts`,
and the smallest opt-in failure-evidence dependency hook in `tests/uat/provisioner.ts`; existing default behavior stays unchanged.
Reuse provisionForUat isolation/teardown and its existing installRealChatAuth injection with a no-op. Disable implicit image builds.
Do not invoke bringUpRealChatModel, copy host login material, install providers, write pins, or reuse existing containers.
The runner must fail closed before effects unless artifact identity, scope, provider readiness, hard limits and explicit execution authority are present.
A later run permits one provisioning attempt, one owner, one task, one case and one chat POST; retries and parallel cases are zero.
Setup budget is 300 seconds, creation/observation 120 seconds, cleanup 120 seconds, absolute wall budget 540 seconds.
The cap is one structured provider-generation invocation and zero fallback conversational/report invocations, enforced before an extra call starts.
The existing public route can fall back; no hard cap is established by this specification. If infeasible within the three code files, stop/reslice.
Do not change product code, add a proxy/provider route or silently relax the cap. Post-hoc counting is not enforcement.
For a later run claim a fresh port with devports in the shared 5180–5299 range; no selected port or running target is authorized here.

## Evidence, results and cleanup

Disable traces, screenshots, video, raw console dumps and full application/Postgres/transcript/response capture on every path.
Persist only run ID, frozen source/artifact/adapter identities, UTC window, HTTP status, durations, counts and synthetic existence booleans.
Refusal fields are only event, stage, errorClass and known host-schema validation.keyword/schemaPath; reject unexpected fields/values.
Never persist prompt/output/candidate content, arbitrary keys, instancePath, params, messages, credentials or raw DB/job records.
Scope any diagnostic collection to the exact project and run window; retain filtered records only. No capture fallback may emit full content.
Exit 0 means NOT_REPRODUCED; exit 1 means exact target REPRODUCED; exit 2 means BLOCKED/INCONCLUSIVE, including cleanup failure.
Stop the browser/workers and remove only the run-owned project, volumes, network and temporary files; release its port.
Complete teardown before the due time; verify owned resources are absent. A failed cleanup overrides any otherwise successful verdict.
Do not sweep other resources. Report only safe owned resource identifiers if cleanup cannot finish.

## Preparation acceptance and remaining holds

Deliver locally committed docs and a frozen, independently reviewed adapter diff, bounded offline-check results and an explicit readiness ledger.
Offline self-checks use fake dependencies only and prove local verdict/filter/budget/cleanup decisions; they are not public-path or runtime proof.
No image is certified here against nominated product source `70562d7df460737497124bf83c27849025ef372c`.
Freeze adapter identity separately. Record its authoring base; fixed candidate compatibility needs review and source/artifact binding remains unproven.
Disposable provider binding, enforceable public-path call/time caps, complete collector coverage and cleanup enforcement remain technical holds.
Approval cannot resolve those holds. No installation, provider, browser, DB, model call or live UAT is authorized by this task.
The narrow pre-reproduction experiment, if later selected, sits outside R05 repair selection; original R05-C1/P2 entry stays unmet.
A single passing trial would not prove the intermittent issue fixed. Runtime NOT_RUN and broader acceptance remain unchanged.
