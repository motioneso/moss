# Terminal refusal after one-time task-check interpretation

2026-10-16. Canonical specification for #3529. The original local behavior agreement below is retained; its draft/prospective language describes that original fixed-source scope. The observer R2 amendment is an accepted diagnostic design, with documentation-only authority in this window. It does not release an executable or waive any acceptance obligation.

## Problem and bounded outcome

In regular Main chat, a recognized nonrecurring Tasks status-check request can enter structured interpretation, receive an unmatched task selection, then fall through into the classifier or ordinary conversational path. The owner-selected behavior is to finish that creation attempt with a deterministic refusal instead. A valid selection still creates the existing one-time check and confirms the saved record.

This specification proposes a separately bounded **local behavior build with offline tests**. Choosing to authorize it independently of the installed total-call experiment is an owner scope choice. It does not amend, satisfy, waive or replace any original experiment or Stage4 acceptance requirement. The original experiment remains held for installed transport identity, upstream count coverage, asynchronous attribution and public fault-fixture proof. Issue #3528 is harness context only and supplies no product-build authority. This change does not diagnose or resolve the intermittent schema refusal in #3503.

## Admission and terminal behavior

Admission means the existing scheduled-read resolver invokes its interpretation callback for an explicitly recognized, nonrecurring native Tasks status-check request in regular Main. It does not mean a provider request necessarily started. Existing earlier recognition, thread, privacy, attachment, module, mutation, availability and recurrence rules stay unchanged.

| Outcome after admission                                                                                         | Required behavior                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly one owned task and existing supported one-time timing                                                   | Save the same reminder, `tasks.get` source operation and scheduled-read job through existing persistence; return the existing code-written saved confirmation.                                |
| Empty, unmatched, foreign or ambiguous task selection; invalid output shape; unsupported interpreted timing     | Return the existing deterministic invalid refusal; save no schedule/source operation/delivery job; do not enter another interpretation, classifier, conversational or immediate report path.  |
| Preparation, interpretation or provider execution failure                                                       | Return the existing unavailable refusal; save no schedule; stay terminal.                                                                                                                     |
| Stop while admitted interpretation is pending, or aborted admitted attempt followed by unsuccessful persistence | Use existing cancellation; do not fall back or start more model work. The existing transaction stop guard governs rollback before commit. No undo of an already committed result is promised. |
| Refusal persistence unavailable or throws without cancellation                                                  | Return the existing unsaved storage-failure receipt; no false saved confirmation, no fallback.                                                                                                |

The invalid refusal is: “I didn't set a check. Name one task you own and one supported time or cadence; I can only read its status.” The unavailable refusal is: “I couldn't set that check right now, so nothing is set. Try again in a moment.” Unsaved-storage and cancellation wording use their existing code constants and existing manager cancellation result. No model-written receipt is introduced.

The decisive public example is `Check my Synthetic task in 30 minutes`, interpreted as `{"taskId":"22222222-2222-4222-8222-222222222222","timingRequest":"remind me in 30 minutes to check task"}`, where that valid UUID is absent from the owner's candidate list. Exactly one external structured-adapter admission must occur, followed by the invalid refusal, zero schedules/source operations/scheduled-read jobs, and zero fallback engine launches/submissions. HTTP 200 alone is insufficient.

## Internal representation and locality

Reuse `ScheduledReadPlan`, existing persistence and existing refusal/cancellation machinery. Add only `readonly interpretationStarted?: true` to the internal plan. Set it for nonrecurring plans once the interpretation callback is invoked, including success and post-entry error/refusal. Keep it absent on unchanged pre-interpret and recurring paths. It is ephemeral provenance, never persisted schedule data, a public HTTP field, a provider permit or a call counter.

Return a marked invalid plan for a nonrecurring unmatched selection instead of `undefined`. Preserve callback-entry provenance in the generation wrapper's failure result. Retain marked incomplete plans in pre-model routing, and prefer cancellation after unsuccessful persistence for a marked aborted attempt. Keep committed saved results and existing unmarked fallback behavior unchanged. Correct the persistence-port comment and the owning app-map description in `packages/chat/src/reminders/features.ts`.

Keep all existing resolver/factory/port signatures apart from the optional plan field. No migration, provider interface, prompt, model-selection, timing policy, worker, queue-control, budget feature, setting or approval UI change. The model's existing two jobs remain selecting one listed task UUID and expressing timing in the supported reminder form. Feedback remains code-written from saved state. Existing schema descriptions, worked examples and deterministic validation remain; no additional model-authored write or prompt guidance is authorized.

## Exact local verification agreement

The public test interface is the real `registerChatRoutes` composition, `POST /api/chat/turn` and `POST /api/chat/turn/cancel`, with the real runtime, resolver, validation, actor-scoped repositories, persistence and disposable PostgreSQL/pg-boss. Replace only external structured-model and chat-engine adapters. Use the real seeded session resolver. Read saved messages through the repository and independently inspect schedule/source/job rows in that owned test environment. These observations prove local behavior and application admissions, not installed behavior or raw upstream requests.

Verification must confine both container and scratch effects. Prospectively add optional `start --no-sweep` in **only** `scripts/run-gate.sh`: leave default behavior unchanged and skip only its global `sweep_gate_containers` invocation when selected; retain ordinary own creation/provisioning and abort/finish/stop cleanup. Add the exact persistent mock-only regression `tests/scripts/test-run-gate-no-sweep.sh`, following the existing `tests/scripts/test-run-gate-own-postgres.sh` fake-tool pattern. Within a 120-second bound, verify no container enumeration or foreign inspection/removal for the opt-in, fake foreign rows unchanged, and ordinary own creation/cleanup after pass/fail/aborted launch; an omitted-flag control must retain the default fake sweep. All fakes, temporary fixture repositories/base commits, state/logs and owned runners are confined to the plan's recorded `N3_MOCK_ROOT` descendants and cleaned after terminal completion. No real Docker is used by that regression. These two exact tooling/test paths supplement the original eight behavior/test/app-map paths and narrow `package.json` script, for eleven prospective paths; no foreign-container deletion authority is requested.

For every real gate, first create `N3_RUN_ROOT` with `mktemp -d /tmp/moss-n3-terminal.XXXXXXXX`, then its owned `tmp`, `chat-home`, `cli-home` and `gate-state` children. Use the plan's exact start: `env N3_RUN_ROOT="$N3_RUN_ROOT" TMPDIR="$N3_RUN_ROOT/tmp" MOSS_CHAT_HOME="$N3_RUN_ROOT/chat-home" MOSS_CLI_HOME_BASE="$N3_RUN_ROOT/cli-home" JARVIS_GATE_DIR="$N3_RUN_ROOT/gate-state" scripts/run-gate.sh start --no-sweep --gate test:integration:scheduled-read-terminal`. Set this process environment **before all runner/test/product imports**, preserve it through the detached gate and Vitest child, and record the absolute root/environment and exact emitted log receipt. The fixture asserts/prints `N3_OWNED_ROOT`/`N3_TMPDIR`; in-test assignment after static imports is insufficient. Classifier scratch created before the engine sentinel, including on a failing fallback, may exist only at `$N3_RUN_ROOT/tmp/jarv1s-structured/<sanitized-service>/persona.md` and its descendant service directory. All fixture temp files remain descendants; never delete the host's shared service scratch directory. Close owned handles/processes on every outcome, wait for the exact terminal gate receipt, preserve evidence privately, remove only that recorded owned root and verify absence. Missing pre-import/inherited isolation is **STOP_IMPORT_TIME_TMPDIR_ISOLATION**; missing opt-in, failed mock confinement, ambiguous ownership or failed cleanup is a finite STOP. No runtime action is taken by this draft.

| ID  | Public case and agreed result                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The absent-UUID example above, separately under real effective gate modes off, shadow and reviewed on: one structured admission, exact invalid refusal, no saved schedule/source/job, no fallback launch/submit. Observe failure on unchanged production source before the fix, at least in off mode.                                                                                       |
| P2  | Adapter returns empty task ID, or user B's real task UUID while user A submits: same terminal invalid result; zero schedules/source/jobs, no source mutation or disclosure. One admission per case.                                                                                                                                                                                         |
| P3  | Adapter returns raw `not-json`, or an object with an extra property: real prepared validation rejects it; one admission, unavailable refusal, zero schedule/source/jobs, zero fallback. Do not bypass validation to force resolver-only shapes.                                                                                                                                             |
| P4  | Adapter selects the owned task but supplies `remind me every day to check task` for a one-time request, or `check task in 30 seconds` without supported reminder wording: invalid refusal, zero schedule/source/jobs/fallback. Existing supported timing semantics are preserved; this is not a new owner/output timing-equality policy.                                                    |
| P5  | External adapter throws a synthetic execution error: one admission, unavailable refusal and zero schedule/source/jobs/fallback.                                                                                                                                                                                                                                                             |
| P6  | External adapter signals entry then waits for its received AbortSignal; send the real cancel route, then adapter rejects on abort: cancellation, zero committed schedule/source/job, no fallback or second admission. Repeat with the adapter resolving the invalid selection on abort to exercise cancellation despite late output. No sleeps or internal stop/resolver/persistence mocks. |
| P7  | Owned task, `in 30 minutes`, valid existing timing output: one admission; existing once-in-1800-seconds confirmation; one matching reminder, one `tasks.get` source operation and one `chat.scheduled-read` job with correct actor/resource/version. No worker/report execution or fallback.                                                                                                |
| P8  | Owned task, `tomorrow at 17:00`, matching supported reminder timing output: existing clock confirmation and one matching schedule/source/job; no fallback. Verify the persisted local time/timezone, not model prose.                                                                                                                                                                       |
| P9  | Absent-UUID response with a scoped real-database insert fault for the reminder-turn transaction: existing unsaved storage-failure receipt, no false saved confirmation, no committed schedule/source/job or partial turn, no fallback. Remove the fault in `finally`.                                                                                                                       |
| P10 | `Check my Synthetic task every 60 seconds`, with matching valid interpretation: retain existing recurring saved confirmation, repeat interval and schedule/source/job behavior, without the new nonrepeat provenance; do not execute a due worker. Unsupported recurring monthly request retains existing pre-interpret refusal and zero structured admissions.                             |

Resolver-unit cases cover duplicate candidate arrays, empty candidate arrays, invalid primitive/object shape, candidate/timing validation, success, callback-entry provenance and unchanged early/mutation/repeating behavior. Synthetic duplicate candidates are **unit-only**: do not replace the real candidate query to claim public producibility. Manager regressions cover marked terminal plans, successful/failed storage, cancellation after failed save, on/off/shadow routing and unchanged unmarked fallback, missing resolver and attachment/private/side/module restrictions. Mutation and ordinary-chat control behavior is checked at these existing unit/manager seams, not promised as a public no-engine case. Those existing internal-double tests are regressions, never the public integration oracle.

The public fault scope is finite: P5 external adapter error, P6 externally signaled pending-interpretation cancellation, and P9 database-trigger persistence failure. A real provider timeout, transport failure, candidate-query failure, or cancellation precisely during unsuccessful persistence is not publicly reproduced by this local packet. Late-persistence cancellation receives manager regression coverage only. If an agreed public case cannot be realized without an internal mock or a new production seam, stop with its exact case/result and a proposed external fixture; do not substitute a green mock or enlarge scope.

## Counts, holds and completion language

Record external structured `generateStructured` admissions separately from chat-engine factory construction, launch and submit. The fixture counts before accepting work. Its fake engine rejects unexpected launch/submit after recording the attempted entry. The planned behavior requires at most one structured application admission and zero synchronous fallback classifier/conversational/report admissions for an admitted attempt. The chosen counterexample requires exactly one. This is **not raw upstream cap proof**.

Application admissions, CLI/ACP launch/submit and raw upstream provider requests remain distinct. Common completed-turn persistence can enqueue embedding/fact-extraction/summary work. Record that queue inventory; do not suppress existing enqueue behavior. No workers run in this fixture. Enqueue is an attribution/coverage gap, not observed dispatch or a proved cap violation. This separate local scope does not redefine which work belongs to the original experiment's cap or authorize prohibiting embeddings.

A successful local result is **locally code-complete, unverified for shipping/installation** after its exact checks and independent code review. Full foundation/CI, actual installed UI/provider proof, original total-call enforcement/count/async/fault proof, publication and merge remain separate gates. Stage4 remains NOT_ACCEPTED. A failed/missing check is recorded precisely; no issue Done/closure, shipped, installed, fixed-#3503 or Stage4-accepted claim follows.

## Observer R2 amendment: supplemental installed fallback evidence

This diagnostic contract supplements the original N3 behavior and local tests; it changes no app-visible semantics. It does not implement a general budget, raw upstream count cap, new error/remediation, setting, provider policy or queue rule. Application attempts, completed activity, CLI/ACP operations and upstream requests remain distinct. Completed-chat activity alone cannot establish zero failed or aborted fallback attempts. Finding 4 stays hardblocked by the existing live guards until independently accepted executable evidence supplies this contract; accepting these documents is not that release.

### Noninterference and exact version 1 coverage

Disabled by default means no subscriber installation, asynchronous context, I/O, timers or delegate wrappers. When enabled, preserve factory selection, engine objects, arguments, `this`, result/error identity and cancellation. The whole subscriber must be nonthrowing: initialization, validation, serialization, socket/error/timer callbacks and promise rejection handlers included. Every observer failure sets sticky evidence error or renders the observer unavailable; catching publish alone is insufficient. Do not intercept process-wide uncaught exceptions. Observer readiness is separate from product health/readiness. There is no product endpoint, setting, ledger, error or app-map-visible behavior change; any newly proposed user-visible semantics would require a separately reviewed owning app-map change.

Version 1 has exactly twelve registered sites: `turn`, `ensure.initial`, `ensure.retry`, `heal`, `factory`, `launch`, `replay.submit`, `submit.initial`, `submit.retry`, `classifier.evaluate`, `shadow.start`, `shadow.run`. All registrations are required before observer Ready. Record entry synchronously before invoking the delegate, including immediate failure; record actual settlement with an outcome enum and abort state. Maintain monotonic sequence, cumulative counters, coverage and sticky errors across all evidence windows; resets cannot erase an attempt.

The new observer module lazily uses `AsyncLocalStorage`. Scope the entire accepted-turn body immediately after minting its existing turn ID, through setup and every terminal, error and finally path. Bind the captured request-thread ID before terminal return and require equality with the independently known owned Main thread. Correlate the accepted actor, thread, surface and turn; unknown context fails proof. Propagate context through initial/retry ensure, asynchronous healing, factory, launch and replay without changing manager/runtime/helper signatures. Track the original healing promise until actual settlement even when admission stops waiting. Track shadow `runAttempt` through its actual finally: a returned `shadow.start` is not proof of classification or settlement.

### Initial-start bootstrap, transport and ownership

Use one narrowly typed opt-in at the existing provisioner/env-writer boundary before initial start. Accept only a 64-hex nonce, bootstrap SHA256, schema version 1 and the shared absolute deadline. Derive the fixed `/app/tests/uat/n3-fallback-observer-bootstrap.mjs` import internally. Reject conflicting scripted-provider configuration and arbitrary inherited `NODE_OPTIONS`. Verify the committed and installed-image bootstrap hash and private env identity before first start. With the option omitted, env output bytes remain identical. No recreation/snapshot API, container transition or unrelated shared signature change is permitted.

The bootstrap may be imported by supervisor, migration, worker, health or query children, but activates only for resolved `/app/dist/server.js`, bound to the API PID, birth and exact container. The bundled observer channel needs no source-loader adapter. Bind the existing first-start producer inventory to exact container/image/source/bundle/bootstrap hashes and auth/socket volume IDs/mounts. Keep its immutable chain and command/raw-exit receipts authoritative, without relabeling or a second recorder.

Keep the nonce directory 0700 and socket 0600. Query the exact bound container only. Frames are capped at 4 KiB, attempts at 256 and buffered metadata at 64 KiB; every operation is bounded by the shared absolute deadline. Transport IDs/enums only, never message content, credentials, tokens or raw errors. Identity ambiguity, overflow, transport loss, reset/restart, concurrency, unclassified work or sticky error makes evidence RED. Preserve the accepted host-lifetime/deadline boundary; process exit never proves an uncertain child closed or licenses resource release.

On success, failure or abort, retain uncertain ownership, private roots, resources and port rather than falsely recording closure. Existing service-plus-slot credential cleanup precedes `down -v`. Require both successful returned teardown and terminal producer absence records, including failure paths. Missing cleanup, evidence or source identity is a hard failure, not an acceptance waiver.

### Evidence windows and sensitivity

Begin each N3 window only with healthy observer identity/coverage and globally zero open turns/attempts. End requires exactly one matched actor/thread/surface/turn begin/end, actual settlement of every descendant, terminal HTTP/UI completion and an acknowledged sequence barrier; an event-loop tick is insufficient. Require identity/sequence continuity, globally quiescent boundaries and no forbidden attempt delta. This observer requirement does not replace the original structured-admission, saved/refused text, actor-scoped schedule/source/job or cleanup assertions.

After both N3 windows, exercise one bounded harmless real ordinary UI turn as a separate positive control. Keep installed provider, model and classifier modes unchanged; create no additional future tasks. Separately, offline tests exercise the actual classifier/shadow callsites with adverse, abort and observer-guard-removal controls. Those controls prove sensitivity, not real installed classification. Neither a shadow start nor the ordinary positive control permits an unsupported classification claim or a provider/model/mode substitution.

The seeded-owner supplemental proof does not prove fresh signup through Settings/provider setup into N3. Primary signup, the existing nine blocking UATs, N1, cancellation/unsaved/fault/due-worker and routine activation obligations remain outstanding where already held. Prior local/full/CI results retain their exact frozen source applicability; none certifies a future observer executable. No live run, push, merge, issue closure or broader activation follows from this amendment.

### Source lock and serial implementation boundary

The plan reserves the accepted prospective fifteen-path union, split into O1 and O2, but this window leases only these canonical spec/plan documents. Preserve executable freeze `5113700e878158212a42b33c42336ee46947beaf` and its accepted lifecycle repair. Product baseline is `966527c413adc752def72f45ce0c54e660ca0615`; the observer contract also cited product-equivalent `e0638457e1612e49bef5bf082ff79fec39954963`. Producer anchor `81e824a73c74bcd17a9ccce8dcb7f8e0b470d961` is superseded and not integratable. Exact replacement **P = `04436bad186750c7b569a30d460b960a464052d1`**, its direct child, is independently accepted as a finite three-path lifecycle repair. Resolve source identity from immutable Git objects only. Producer ownership remains read-only; explicit overlapping-path handover is pending canonical/O1 acceptance. Pinning P grants no executable edits or integration.

No executable implementation may start until this exact producer pin is accepted in the reviewed canonical source-lock amendment and the applicable window has an explicit lease. Preserve the current executable lock until its reviewed amendment; do not widen it automatically, read a mutable producer worktree, or integrate a candidate without authorization. O1 requires its separate six-path grant. O2 integration and overlapping producer-path ownership transfer follow canonical/O1 acceptance and require explicit handover plus its own executable lease. Keep observer composition in the focused helper rather than expanding the 1000-line runner. Implementation, adverse controls, integrated source/image/producer bindings and final executable review are still due.

## O2a structural rider R2 — authorized layout maintenance

The coordinator’s O2a R1 brief and structural rider R2 explicitly authorize this finite continuation on accepted O1 `80ceefc563fb9eeb2df0e89b0fbfb498e128389c`, after conflict-free producer integration at `8fe37b0858a3ccd8f838d4c6ddbf42763708f558` (tree `84d66053e1ba4c0868f51c1ca4c99c3556fff2bc`). P remains exactly `04436bad186750c7b569a30d460b960a464052d1`; the integration freeze and R1 evidence remain immutable. This explicit lease supersedes the historical pending-lease/layout statements above only for O2a, without changing the diagnostic contract or any runtime/acceptance hold.

The following exact structural additions resolve the 999-line provisioner/test constraint without compaction or broad refactoring. Repository paths are under `~/Jarv1s`:

| O2a path                                           | Narrow responsibility                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/uat/provisioner-options.ts`                 | Move the existing options interface intact, retaining the public type re-export; hide narrowly typed observer validation, pin and env preparation. No new lifecycle or cleanup manager.                             |
| `tests/uat/provisioner-lifecycle-fixture.ts`       | Move the existing private `lifecycleFixture` factory intact into a test-only shared helper; no test registration, module mocks or global side effects. Retain all existing assertions, cases and fixture semantics. |
| `tests/uat/n3-fallback-observer-bootstrap.test.ts` | Focused fake/offline subscriber and initial-provisioning controls, reusing the extracted fixture; no importing a test module or duplicating the whole fixture.                                                      |

The complete O2a executable lease is those three paths plus `tests/uat/n3-fallback-observer-bootstrap.mjs`, `tests/uat/provisioner.ts`, `tests/uat/provisioner.test.ts` and `tests/uat/env-file.ts`. All seven files stay at most 1000 lines. Accepted O1’s six files, including its unit file, stay byte-for-byte unchanged. `tests/uat/lifecycle-records.ts` remains exact P. Preserve all 103 retained tests and their original case bodies. This nonsemantic layout amendment is committed separately before source edits and needs no additional plan gate; it adds no user-visible behavior or app-map declaration.

O2a implements only the original nonthrowing subscriber/bootstrap and typed initial-provisioning contract. O2b retains runner/helper/spec wiring, independently owned identity/source/image/producer consumer bindings, windows’ UI/HTTP completion proof and the separate real positive. The original N3 runner/spec hard guards stay unchanged. No consumer relabeling, recreation, arbitrary NODE_OPTIONS, provider/model substitution, weakened bindings, uncaught-exception interception or new lifecycle recorder is permitted. Shared absolute deadlines, private transport, bounded metadata, cumulative correlation/settlement/barrier requirements, decisive offline protection-removal controls and exact restoration remain mandatory. Independent exact-commit review is still required; no Docker/DB/provider/browser/installed/live/socket execution, full gate, CI, push, PR, merge, signup, final O2 acceptance or automatic successor is released.

## O2b serial layout amendment — offline consumer lease

For #3529, the coordinator’s O2b1 R1 brief authorizes a finite offline build on accepted O2a
`c1739462bc364d0665818a25207d253a9039ebc8`. This nonsemantic amendment supersedes only the
historical helper-test placement and unsplit O2b layout. Commit it separately before executable edits.

O2b1 leases exactly two new executable paths under `~/Jarv1s`:
`tests/uat/n3-fallback-observer-runner.ts` for the inert typed consumer, independent receipt and
identity checks, fixed persistent native bridge, cumulative windows and bounded bridge disposal;
and `tests/uat/n3-fallback-observer-runner.test.ts` for dedicated fake-only controls. Each stays at
most 1000 lines without compaction. Expected authoritative pins remain separate from independently
collected installation, API and producer observations. Preserve the version 1 schema, private
channel, immutable chain, source/image/volume identity, actual descendant settlement, external
UI/HTTP completion attestation, barrier and inherited absolute deadline contracts above.

After independent exact-commit O2b1 acceptance, O2b2 requires its own serial ownership transfer
and lease for minimal existing runner and real UI spec composition, plus finite adapter/test
integration changes. O2b1 does not lease those paths or an O1 test edit. The original runner/UI
guards, accepted O1/O2a and exact P bytes remain frozen. O2b1 runs fake-only tests and scoped static
checks; it opens no actual Docker/socket/DB/provider/browser resources and runs no existing runner
selftest, full gate or CI. Freeze local evidence for two-axis independent review. O2b2, runtime,
publication and Stage4 acceptance remain held; no push, PR, merge or automatic successor is granted.

## O2b2 packaging prerequisite R1 — finite static child K

For #3529, the explicit finite packaging grant authorizes only `.dockerignore` and these existing canonical spec/plan documents in one local direct child K of accepted C `cb9420a924a6725f501e03f6155ce0e70228aa92` (tree `5ee00eb9de7e27d473ca0dbb7ebfb6e44873f1d9`). Earlier pending-lease language is superseded only for this three-path prerequisite. K remains subject to independent exact-commit review and coordinator acceptance; this amendment asserts neither acceptance nor installed proof. Accepted P `04436bad186750c7b569a30d460b960a464052d1`, O1 `80ceefc563fb9eeb2df0e89b0fbfb498e128389c`, O2a `c1739462bc364d0665818a25207d253a9039ebc8` and O2b1 C retain their executable bytes and applicability.

### Canonical installed-map reconciliation

The fixed installed map has exactly fourteen duplicate-free keys: the complete four-member accepted fixture union, five inherited product-source checks and five O1 production sources after deduplication. The fixture corroborates required membership; it is not a production map or image proof. All thirteen source members below are normal mode `100644` blobs at C and remain byte-identical. Their source hashes are authoritative frozen Git inputs, independent of observations. The generated bundle has no invented source hash.

| Installed key                                              | Frozen C source SHA256 / generated baseline                         | Role                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `/app/tests/uat/n3-fallback-observer-bootstrap.mjs`        | `cb5e0aad361cd18305d511752bfd05fb40362f4673176225f04d1ef435afd97d`  | initial-start bootstrap                               |
| `/app/tests/uat/lifecycle-records.ts`                      | `aaeed62a44bfd45c1767f7a0ecdb8198227562c22a913187fe2550430d4251e0`  | passive producer source mirror; executes only on host |
| `/app/packages/chat/src/live/chat-session-manager.ts`      | `e8687560858dc953a64ba7017a9aff9175588408f3ec3435fb6e8c08e7c8becc`  | retained manager anchor                               |
| `/app/packages/chat/src/live/chat-session-ports.ts`        | `0195bd5bcd288289b82cc1010463cd99c7049ff98df2729e450cfcf3aa076114`  | inherited product source                              |
| `/app/packages/chat/src/live/pre-model-turn.ts`            | `113ceb8cc90d8005d5d28017a7d197158bd02e01a168b4d0141422958ed6d140`  | inherited product source                              |
| `/app/packages/chat/src/reminders/features.ts`             | `91ca420a38f8fc9bdf9003953e2f26429a5c480dd335248aabd4c9f84d922158`  | inherited product source                              |
| `/app/packages/chat/src/scheduled-reads/generation.ts`     | `b6d4883b3abba7103d07549be68045cdb0bf6b8d77e3c618f725434e42d1979b`  | inherited product source                              |
| `/app/packages/chat/src/scheduled-reads/request.ts`        | `b9f0cde8124905180fcec82ab2665def136bf98038ee4db9b8958eab7e9f0174`  | inherited product source                              |
| `/app/packages/chat/src/live/chat-attempt-observer.ts`     | `9a21cd24d0a1888159c0df855deb1116313c009791db928fa3f536dd520d8af1`  | O1 observer source                                    |
| `/app/packages/chat/src/live/chat-session-turn.ts`         | `d8e4461a87d3785bea18e98bd687843a54ea7401dc69160249eb0c1abce5df84`  | O1 turn hooks                                         |
| `/app/packages/chat/src/live/chat-session-launch.ts`       | `38e75a015cd7a415071cc09e9747c10274ff15344933c8f3c82e067be7e330a2`  | O1 launch hooks                                       |
| `/app/packages/chat/src/live/classifier-gate-lifecycle.ts` | `c4483827a5330ace9dac901fedba8b77d600eae9f312bde447d4c9203fd7290c`  | O1 evaluation hooks                                   |
| `/app/packages/chat/src/live/classifier-gate-shadow.ts`    | `ed0dc5f536d4372718039f6e6606b94414eed4d611d232a4565e1972022d6308`  | O1 shadow hooks                                       |
| `/app/dist/server.js`                                      | Generated; original closed build and image-backed baseline required | API bundle; no static source hash                     |

`/app/tests/uat/lifecycle-records.ts` is a passive exact source mirror. It is never imported or executed by the API container; lifecycle execution, producer source authentication, immutable chain and command/raw-exit/close receipts remain independently host-owned. The mirror must equal both the independently authenticated host producer and exact accepted P source. Omitting it as “host-only” would change the accepted trust contract and is not authorized.

The eleven `packages/chat` members are existing context inputs. The fixed bootstrap uses Node builtins and activates only for resolved `/app/dist/server.js`; no UAT source-loader or transitive provisioner tree is needed. The unchanged `Dockerfile` copies context with `COPY . .`, invokes `pnpm build:api` in the build stage and inherits that stage into runtime. `package.json` maps that command to `tsx scripts/build-app.ts api`, which emits `dist/server.js`. `**/dist` remains excluded from source context; the bundle digest must come from the original fresh closed build and its image-backed never-started original container. The generated `.js.map` is not an additional installed-map key. This finite map does not enumerate every API dependency or image file; the full reviewed repository source/tree/input fingerprint remains mandatory.

Original runner, real UI spec, provisioner, options/env/compose/auth helpers, accepted consumer adapter, future installed collector, fixtures and all unit/UAT tests remain independently source/tree-pinned host/browser orchestration or fake controls. Their exclusion does not justify further carve-ins. Fixed native bridge/readers remain committed host source passed through the reviewed allowlist. `Dockerfile`, `.dockerignore`, manifests/lock, build scripts, compose inputs, private producer channel and actual command receipts retain their independent build/provenance authority. P already fingerprints `Dockerfile` and `.dockerignore` together with commit/tree. A future build binds its actual final O2b2a source identity and fingerprint, never a relabeled C or a purported packaging-built image.

### Exact context delta and static limits

The sole context change inserts exactly `!tests/uat/lifecycle-records.ts` immediately after `tests/uat/*.ts`. Preserve every original byte, newline, rule order and all other exclusion/exception behavior. C ignore SHA256 is `982de9acc88c3e42bf4874c5023b1b931dba76488967c6c48ba10e57eb666570`; K ignore SHA256 is `c212ecfadfe09b4edf283ba9844246b0595cb89ccafacd8371059103069eb938`. Removing that exact inserted line reconstructs C. No wildcard/blanket inclusion, producer edit, Dockerfile change or additional context member is authorized.

Before editing, verify clean owned C, the ordinary producer blob, absent `Dockerfile.dockerignore`, included `tests`/`tests/uat` ancestors and unchanged copy/build/generation stages. Reproduce every source hash from immutable C. Bounded Docker-compatible last-match/ancestor traces must show C includes twelve of thirteen source members and K includes thirteen; only the producer changes. Check all tracked paths using the frozen rule grammar, or an explicit finite-rule proof: the literal negation has only its exact path/descendant domain; the target is a regular tracked file without descendants, parents are included and no later rule rematches it. Unsupported syntax, excluded ancestor, nonregular/missing member, override or extra membership delta is a finite stop.

Adjacent/suffix/nested producer-like paths, provisioner, current/future collector/adapter sources/tests, real UI spec and O1 tests retain their prior membership. Preserve preexisting nested inclusions and every secret/local/runtime exclusion. In-memory removal of this exception must fail the same unchanged required-producer-membership assertion with numeric status, original/proposed/removed/restored input hashes and exact restoration. These checks establish static context membership only; they are not Docker, build-context archive, installed-image, tar or mount security proof. No product test, build or runtime is authorized by this prerequisite. The later dedicated `tests/uat/n3-fallback-observer-installed.test.ts` must consume this same canonical map and check immutable context membership, including failure on in-memory removal of the exact exception; it is not leased now.

### Serial acceptance and retained R2 obligations

Freeze K commit/tree/parent, exact three-path diff, file hashes/blobs/modes, static receipts and clean owned state. Only coordinator acceptance of independently reviewed K and a separately reviewed complete five-path O2b2a brief may establish the new packaging base. `.dockerignore` then returns to frozen status. O2b2a still commits its own narrow two-document serial/provenance amendment separately before executable edits, freezes its own final source commit/tree and binds the future original build to that actual source. No packaging image is claimed.

Every R2 safeguard remains binding: attach to the original build ChildProcess after pre-spawn source/command/daemon freeze; independently observe raw zero exit and separate close before image-built; preserve omitted-option commands/env/errors/defaults. Use the original O2a-created never-started API container and the awaited hook after O2a immediately before original first up, without recreation. Independently verify exact identity/state/source/daemon and empty diff, all mount types and canonical destinations before any cp and again immediately before up, with no intervening async work except original start dispatch and a final deadline check. Reject file/ancestor/root overlays, ambiguous paths and late substitutions; independently reconcile required auth/socket volume identity and P inventory.

Read only fixed map keys with exact original-container cp commands. Strict bounded tar validation requires exactly the requested regular member and rejects links, extras, directory members, malformed/checksum/size/truncated archives, extensions/path overrides and trailing substitutions before hashing. Preserve independently authoritative expected pins versus observed receipts, connected collector/accepted-adapter composition, closed read allowlist, inherited absolute deadline, bounded outputs/closure and uncertain-ownership retention. Every future mount/tar removal witness must fail an unchanged attributable assertion with unrelated protections active, restore exact bytes in `finally` and rerun affected controls; static membership sensitivity cannot substitute for those witnesses.

Original runner/UI and both unconditional guards, P/O1/O2a/O2b1 sources/tests, package/lock/config bytes and original behavior remain frozen. No app-visible behavior or app-map declaration changes. O2b2b, actual Docker/socket/DB/provider/browser/port/process/signal work, full foundation gate, CI, publication, push/PR/merge, guard releases, final O2 and Stage4 acceptance remain held. This finite prerequisite grants no automatic follow-on, successor or source ownership transfer.

## O2b2a R3 — finite offline provenance implementation

The finite execution grant on accepted packaging K
`e2b66b672d625221ddd7139d31046372d94d2e8d` authorizes only this serial offline
slice for #3529. Commit this amendment separately as A before executable edits;
freeze the final candidate F and its tree through A/K after fake controls. A future
original build must bind genuine F, never relabel C/K or claim an offline-built image.

The five owned paths under `~/Jarv1s` are this spec, its matching canonical plan,
new `tests/uat/n3-fallback-observer-installed.ts` (target 750, hard 1000 lines),
new `tests/uat/n3-fallback-observer-installed.test.ts` (target 800, hard 1000),
and only the original-child/pre-first-up seam in `tests/uat/provisioner.ts`
(984 to at most 1000). No compaction, unrelated extraction or sixth path is leased.
The fourteen-key packaging map above and all thirteen source pins are unchanged.
The exact K ignore hash remains
`c212ecfadfe09b4edf283ba9844246b0595cb89ccafacd8371059103069eb938`;
Dockerfile, P/O1/O2a/O2b1, adapter/tests, original runner/UI guards and every
package/lock/config input remain frozen except the expressly reopened provisioner seam.

The optional typed `n3BuildEvidence` requires validated observer opt-in. Prepare
actual argv/cwd/source/root/input/daemon evidence before spawn, attach synchronously
to the original build ChildProcess, retain its birth/group/session/boot identity,
and independently await raw zero exit plus separate close before image-built.
Keep omitted-hook commands/env/retries/errors identical. Await the new pre-start
hook after O2a's original container creation and before original `up --no-recreate`.
Never replace the original build, create owner, lifecycle recorder or host supervisor.

Before any new baseline cp and again immediately before original up, require the
same original never-started container/image/config/source/daemon, empty diff and
canonical all-mount exclusion for every fixed reviewed file and its ancestors,
including `/app` and `/`. Independently authenticate auth/socket mounts and volume
inspect against P inventory. Accept only the single requested regular tar member:
validate name, checksum, size, type, padding and termination; reject links, extras,
path overrides, truncation and trailing archives even when payload hashes match.
Source payload ceilings equal immutable K byte lengths; bundle 64 MiB, aggregate
archives 80 MiB, metadata per command 256 KiB, one cp pending. Archive allowance is
one header plus rounded payload and at most 16 KiB zero termination/padding.

Construct the accepted adapter through verified build/baseline receipts and closed
fixed readers, with independent expected pins. Import/construction stays inert.
Keep source/DB semantics, exact namespace API/socket identity, projected errors,
one inherited absolute deadline, bounded output/closure and uncertain-handle retention.
Fake controls traverse these seams and actual accepted O2a/P/adapter interfaces.
Require immutable K context membership and exception removal in memory, plus
attributable unchanged-assertion guard removals for file/ancestor/final-only mounts
and link/extra-member tars, exact restoration and tested/Git byte correspondence.

Only offline controls and scoped lint/format/types/size/diff checks are authorized;
root nonincremental TypeScript is capped at 120 seconds. Stop at the first finite
cap/source/receipt/context/control limitation; do not claim partial collector completion.
Independent exact-commit Standards and Spec review precedes acceptance. O2b2b,
actual build/Docker/socket/DB/provider/browser/port/PID-signal work, process selftest,
full gate/CI/push/PR/merge/publication and both guard releases remain held. All nine
blocking UATs remain UNRUN here; runtime/release/Stage4 booleans remain false and
Stage4 remains NOT_ACCEPTED. No automatic follow-on or successor is authorized.
