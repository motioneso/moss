# #3503 Tasks-creation refusal admission specification

This specification defines the approved target for a bounded creation-only experiment and the minimal
server admission needed to enforce its call limit. It does not reproduce, diagnose, fix or close #3503.
The previous harness-only boundary could not enforce the public Main fallback cap; this design replaces
that boundary with a disposable startup permit, one-use server admission and terminal fallthrough barriers.
Implementation and runtime checks are not complete. N1 remains STOP/RESLICE and runtime NOT_RUN.
Standing Stage 4 authorization covers necessary continuation; exact coordinator technical dispositions
and finite writer, check and runtime grants still delimit each slice. No new routine human approval gate
is required. Additional code paths require a new technical scope disposition.

## Public behavior contract for a later bounded run

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

One provisioning attempt, one owner, one task, one case and one chat POST are permitted; retries and parallel cases are zero.
Setup budget is 300 seconds, creation/observation 120 seconds, cleanup 120 seconds, absolute wall budget 540 seconds.
Enforce monotonic phase deadlines within the absolute budget and complete teardown before the due time.
The cap is ONE structured interpreter generation and ZERO classifier, conversation or report generations,
enforced before an additional adapter dispatch starts. Post-hoc counting is not enforcement.
No implicit build, provider installation/configuration, credential copying, existing-container reuse,
proxy/provider-route change or second live chat is part of this experiment.

## Disposable launch and trust boundary

`tests/uat/run-3503-creation-refusal.ts:prepareN1Launch` owns the prospective host launch.
Claim a fresh shared-range port with `devports` (5180–5299). Create one run directory, mode 0700,
UID/GID 1000, with `permit/` and `state/` children. Pass optional typed `N1ProvisionBinding` to
`provisionForUat`: `{runId,projectName,imageDigest,controlDirectory,overridePath,manifestSha256,claimedWebPort}`.
Validate its paths remain beneath that new run directory. Preserve existing callers' defaults.
Reuse solo-admin isolation/teardown and the existing `installRealChatAuth` injection with a no-op;
do not invoke `bringUpRealChatModel` or write provider pins. The opt-in safe failure collector must
cover provisioning failure as well as case failure; existing callers retain their default collector.

Add an explicit generated compose-override hook to `tests/uat/provisioner.ts`; its current
`buildUatComposeArgs` has two fixed compose files. Every compose command, including teardown, uses
the same override. Pin `jarv1s.image` to the approved OCI digest; set `restart: no` and runtime
`JARVIS_HOST_UID/GID=1000`; mount permit read-only at `/run/moss-n1` and state read-write at
`/run/moss-n1-state`; inject `MOSS_N1_MANIFEST_SHA256`. Disable every N1 provisioner retry and implicit
build. Existing `scripts/start-jarv1s.ts` already forwards environment and launches the resident API
as the runtime UID; no change to that script is included.

The manifest is an approved claim, never self-authenticating image or provider evidence. Before any
provisioning effect, the launcher requires coordinator-frozen artifact and provider witnesses.
The artifact witness records independently reviewed source, control and adapter hashes plus
source-to-image build provenance. Cross-check its approved digest with the local OCI image
descriptor/config and the exact generated compose image reference; labels alone cannot prove provenance.
The provider witness binds this disposable fixture's authorized route, owner, model and capabilities
to a non-generation readiness observation. Check its approved hash, expiry and exact binding.
Missing real witnesses block; do not invent a digest or observation. After UI login, supported
read-only settings recheck the installed route without a model request; mismatch stops before chat.

`N1LaunchManifestV1` fits within 4096 UTF-8 bytes and rejects unknown keys. Its exact fields are:

- `version`: literal 1; `case`: literal `3503-creation-v1`; `runId`: UUID; `projectName`: UAT-validated string;
  `issuedAt`/`expiresAt`: integer UTC milliseconds, expiry no later than issuance plus 540000.
- `sourceCommit`: 40 hex; `sourceDiffSha256`, `adapterSha256`, `artifactWitnessSha256`,
  `providerWitnessSha256`: 64 hex; `imageDigest`: `sha256:` plus 64 hex.
- `actorId`: literal existing `UAT_ADMIN_ID`, `00000000-0000-4000-8000-000000000001`;
  `mainPolicy`: literal `persistent-owned-main`; `promptSha256`: digest of the fixed public prompt;
  `taskPolicy`: literal `one-owned-standalone-nonrecurring-probe`.
- `providerConfigId`/`modelId`: UUIDs; `service`: literal `module.chat`; `capability`: literal `json`;
  `tier`: literal `economy`; `limits`: literal
  `{structured:1,classifier:0,conversation:0,report:0,attempts:1,posts:1,setupMs:300000,observeMs:120000,cleanupMs:120000,wallMs:540000}`.

`apps/api/src/n1-admission-activation.ts:loadN1Activation`, called by `createApiServer` before route
registration, reads fixed `/run/moss-n1/permit.json`. Require a regular non-symlink file, mode 0600,
parent 0700 and UID/GID 1000; check descriptor metadata, content hash against the trusted environment
digest, strict schema, expiry and runtime source-commit build metadata. Runtime metadata is only a
cross-check; host provenance remains mandatory. File AND digest absent preserves ordinary mode.
Either present alone, malformed configuration or a mismatch aborts enabled startup.

Before exposing enabled routes create `/run/moss-n1-state/boot.claim` with
`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, and fsync; require state directory 0700, UID/GID 1000.
This one run-owned marker remains until teardown and rejects restart or second API bootstrap even
before a turn. Claim failure fails closed. Never remove/reuse it to retry; no durable product ledger
is introduced. In that boot, synchronously claim the run permit once before the first await of an
eligible turn, and never reopen it.

## Fixture binding and provider admission

Existing solo-admin seeding supplies the fixed synthetic owner. Supported UI signs in, opens Main
and creates the one task. No chat parameter forges owner/task identity or enables activation.
Before generation, check authenticated actor ID against the permit; resolve selected thread and
`getMainThreadState` under that actor; require the same owned persistent non-incognito Main and
freeze its actual UUID in memory. In the resolver's owner-scoped candidate transaction require
exactly one owned candidate with the fixed title; use public `@moss/tasks` `TasksRepository.getById`
to verify owner, `parent_task_id=null` and `recurrence=null`, then freeze its UUID. UI independently
observes creation. Missing fixture or disagreement blocks before dispatch; no manifest rewrite,
private-table bypass or new Tasks API is included.

Chat owns opaque `N1RunPermit`/`N1TurnAdmission` with run/actor/Main/task bindings, clock, signal and
consumed/closed state. At the start of `tryPreModelTurn`, N1 skips other model-capable preprocessors
and enters the existing scheduled resolver/deterministic schedule handling. Nonmatching output or
undefined recognition terminates. An outer `runChatTurn` barrier prevents escape before
`ensureSession`, classifier/shadow, retrieval, rollover, recovery or submit. Successful interpretation
uses normal deterministic creation; schema refusal preserves original diagnostic correlation.
Preparation/provider/storage error, timeout, cancellation or unexpected failure terminates, and
finally closes admission without refund. No fallthrough or retry is allowed.

AI owns exported `PreparedDispatchAdmission = () => 'allow'|'deny'` in `generate-structured.ts`.
Add an optional fourth `prepareStructuredGeneration` argument, captured into `RunOptions.beforeDispatch`,
called immediately before `adapter.generateStructured` in `runPreparedModel`'s attempt.
Denial returns `provider_error` with additive `StructuredFailureReason` `admission_denied`;
the resolver converts it to `N1AdmissionBlockedError`. AI imports no chat capability.
The SAME callback closes over ONE admission across preparations. It checks closed, aborted,
deadline and consumed; allow synchronously sets consumed before transport and never refunds after
rejection or late settlement. Existing per-closure consumed protection and `maxAttempts1` remain unchanged.

Admission denial maps to HTTP 409 with fixed error `Bounded creation check could not continue.`;
original schema refusal keeps its existing response. Admission denial is never REPRODUCED.
Absent configuration retains ordinary behavior. No UI toggle or shared production configuration
change is included. Chat manifest features must describe applicability, error and remediation;
public exports and optional-dependency defaults remain compatible in the same eventual product PR.

## Evidence, results and cleanup

Disable traces, screenshots, video, raw console dumps and full application/Postgres/transcript/response capture on every path.
Persist only run ID, frozen source/artifact/adapter identities, UTC window, HTTP status, durations, counts and synthetic existence booleans.
Refusal fields are only event, stage, errorClass and known host-schema validation.keyword/schemaPath; reject unexpected fields/values.
Never persist prompt/output/candidate content, arbitrary keys, instancePath, params, messages, credentials or raw DB/job records.
Scope any diagnostic collection to the exact project and run window; retain filtered records only. No capture fallback may emit full content.
Exit 0 means NOT_REPRODUCED; exit 1 means exact target REPRODUCED; exit 2 means BLOCKED/INCONCLUSIVE, including cleanup failure.
Stop the browser/workers and remove only the run-owned project, volumes, network and temporary files; release its port.
Include the run control directory and boot marker in owned cleanup; stop dispatch on cancellation.
Complete teardown before the due time; verify owned resources are absent. A failed cleanup overrides any otherwise successful verdict.
Do not sweep other resources. Report only safe owned resource identifiers if cleanup cannot finish.

## Acceptance and remaining technical holds

The companion plan specifies exactly five new and fifteen amended code files, nine bounded offline
groups and separate guard-on/off proof. No code or runtime is accepted by these documents.
Fake I/O controls are offline evidence only; they cannot substitute for the original live Main trial.
Require independently reviewed exact implementation, real check exits and source/artifact/installed
correspondence. Earlier nominated source `70562d7df460737497124bf83c27849025ef372c` cannot contain
this new admission design and is not certified here. Freeze adapter identity and authoring base separately.
Actual artifact provenance, disposable provider readiness/binding, total-call/background coverage,
time interruption, complete safe collection and all-path cleanup proof remain unmet technical holds.
Approval, labels, manifests and fake controls supply none of those facts.
The narrow pre-reproduction experiment sits outside R05 repair selection; original R05-C1/P2 entry stays unmet.
A single passing trial would not prove the intermittent issue fixed. Runtime NOT_RUN and broader acceptance remain unchanged.
