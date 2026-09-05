# Workshop Phase A live state

Latest ruling: Ben approved limited R1a–R1d plus M1/M2 implementation after reviewing pros/cons.
Start with R1b CLI source-generation safety. New Workshop execution stays unavailable until
assembled checks pass; no host install, deployment, merge, R1e or downstream delivery authorized.
The pending AWAITING-BEN entry was removed; do not ask for this approval again.

User authorized isolated implementation with internal Luna subagents on 2026-09-04.
Worktree: `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.
Branch: `build/workshop-phase-a-0904`; starting SHA `c372784983038ed3e722e7edb75cec54333efde0`.
All changes remain uncommitted. No push, PR, merge, deployment, shared service restart, or live
DB mutation. Root owns remaining edits; Luna authors and follow-up reviewer have finished.
Do not call or restart agentmemory. Graph recovered on the second resume; root indexed this
worktree in fast mode without persistence. Graph project is
`home-ben-Jarv1s-.claude-worktrees-workshop-phase-a-0904`.

## Active continuation

Ben approved the corrected instrumented Codex diagnostic: "approve, proceed". It found missing
`usage.total_tokens` in the synthetic SSE fixture. Corrected R3 now passes as a negative control:
`view_image` is exposed and attempted, while this container denies its namespace helper and no
image reaches the next request. No sandbox relaxation, real Codex credential or vendor call.
Root also added source-route identity/concrete-selector guards under existing #2277. Ten targeted
checks pass. A proposed separate GitHub task was rejected by automatic review; no issue was
created, and no external publication is needed for this existing task's local safety change.
The next R1a/M2 worker slice needs a tracked task; its concise publication draft is
`docs/handoffs/workshop-r1a-m2-task-draft.md`. Publication approval is pending after the earlier
automatic-review rejection. Same worktree; no agentmemory, worker wiring or Workshop enablement.

## Current result

- #2276: cancellation return guards implemented and regression-tested; issue open.
- #2277: dedicated source-generation RPC and isolated Claude launch policy implemented;
  159 targeted tests passed. Source intent uses fresh sessions, narrow runner inputs, bounded
  output/deadline, verified completion and forced cleanup. Ordinary paths remain covered.
  Root TypeScript and scoped lint pass; repository-wide checks have unrelated failures below.
  Authenticated Claude adapter/RPC/runner/engine proof now passes (continuation below).
  Installed user-config hook exclusion, real engine wall deadline, and actual `createCliRunner`
  generation/live cancellation also pass. Deployment startup and actor isolation remain unproved.
  Source dispatch also rejects empty/default selectors and mismatched provider records.
  Actor isolation, full deployment composition and provider parity remain unproved.
- #2265 A0: local container isolation/resources, authenticated Claude worker/web generation and
  offline browser checks passed. Host-control cancellation, deadline after launcher death and
  restart/replay checks also passed. Recommend the existing host/systemd control pattern with
  source-only build containers. Actual deployment/actor-routing/all-provider CLI and application
  integration remain unproved; no full Phase A go decision. Earlier Bubblewrap denial remains
  recorded as the rejected local mechanism.
- #2266 A1: supplementary state sheet built and browser checked (20 states, four widths,
  keyboard, retained text, recovery, reduced motion, control bounds). Ben approved the
  supplementary states on 2026-09-04: "states look good". The A1 design-review gate is satisfied.
- #2267 A2/A3: shared draft invocation and private KV fixes implemented; isolated live browser
  storage proof passed. This proves a trusted installed draft, not generated Workshop builds.

Supplementary preview: <http://100.64.98.99:8770/docs/superpowers/specs/assets/2026-09-04-workshop/states.html>.
Only staged assets are served; HTTP200 and repository-document HTTP404 checked. Server session
36303; staging path recorded in `/tmp/workshop-phase-a-preview-root`. Original preview untouched.

## Live storage evidence

Command: `JARVIS_IMAGE_TAG=workshop-phase-a-0904 pnpm test:uat workshop-storage`.
R4 log: `/tmp/workshop-phase-a-uat-r4.log`. Exit **0**; **1 passed (2.0m)**.
Project: `uat-3517050_7cbefb15`; image `ghcr.io/motioneso/moss:workshop-phase-a-0904`,
SHA `sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed`.

Proven assertions in `tests/uat/specs/workshop-storage.uat.spec.ts`:

- Real `multi-user` seed, draft installer and owner row; explicit post-seed restart/readiness.
- Owner signs in and opens the real module navigation; real queue save and successful worker
  readback persist across browser reload and app restart.
- Exact persisted pg-boss `data`: actor/module IDs, job kind, manifest hash and word-ID params.
  No extra payload fields; browser request body also checked exactly.
- Second account, first regular user then promoted through the real admin API, cannot navigate,
  invoke or queue the draft. Under the real worker SQL role, both identities see zero KV rows
  and fail insertion with RLS denial while the owner's saved row still exists.
- Exactly one owner KV row and no foreign rows; deduplication and 429 verified.
- Accepted fixture jobs must all complete successfully before removal and after the burst.
  Confirmed removal, reload, then zero KV before deletion prevent a queued-save race being hidden.
- Supported draft DELETE, restart, no discovered module, no installed/staging artifact and zero
  module/KV/nonterminal-job rows. Harness teardown removes remaining job history and all isolated
  containers, volumes and network. Post-run Docker label queries confirmed all absent; fixture
  processes cannot survive their removed container. Standalone no-restart process purge is not proved.

R4's host-side spec assertions were strengthened before Playwright launched; application/fixture
image source was unchanged. Luna reviewed the final assertions. Residual timing boundary: the
fresh dedup test follows restart/privacy checks and expects the initial save's five-second
singleton window to have elapsed; this run passed, but no explicit clock-window wait is encoded.

## Fixes and earlier failures

A2 selects draft owner and admits only that exact active actor with matching manifest/package
hashes, retaining enabled behavior. R2 exposed a second enabled-only gate in settings migration
0157: real `kv.set` was denied by RLS. New additive migration
`packages/settings/sql/0215_module_kv_worker_owner_draft.sql` permits only active admin owner's
current-module draft user storage. Independent reviews found no SQL/security blocker; deactivated
or demoted owners fail closed. Existing enabled policies are unchanged.

R1 (`/tmp/workshop-phase-a-uat.log`) failed the fixture's CommonJS/ESM package mismatch, corrected
by removing package `type: module`. R2 (`/tmp/workshop-phase-a-uat-r2.log`) failed owner KV RLS.
R3 (`/tmp/workshop-phase-a-uat-r3.log`) stopped on duplicate migration 0200 (already owned by news).
Renamed only the unapplied policy to 0215; actual global loader check now passes 206 versions.
R4 applied 0199 and 0215 successfully. Recheck global numbering against main before merge.
All four disposable runs removed their own resources. Incidental pg-boss warnings were not the
first browser failure and must not be described as its cause.

The trusted fixture stages in `/data/modules/.builds/` for atomic rename on the module volume.
Production's default build root is `/data/module-builds`; cross-filesystem installer staging is
still a runtime-design concern. Cleanup intentionally checks the fixture's actual staging root.
Test-only Compose override avoids production's fixed `moss` container name, caps app/DB resources,
and shares the isolated modules volume with seed. Production Compose is unchanged.

## Verification and remaining work

Passed: draft unit tests (4), provisioner unit tests (29), final root `tsc --noEmit` (exit 0),
scoped ESLint including the final UAT spec (exit 0), fixture manifest/build/startup, registry
import, prototype checks, migration uniqueness (206), documentation format and diff whitespace.
Final typecheck log: `/tmp/workshop-phase-a-tsc-final.log`.

File-size check exited 1 for two unchanged Sports files: `packages/shared/src/sports-api.ts`
(1022 lines) and `tests/unit/sports-public-source-reader.test.ts` (1156 lines).
Standalone integration suite and full foundation gate remain unrun. The A2 integration test's
injected membership seam is not SQL evidence; A3 is the real-worker evidence.

GitHub task bodies #2265, #2266 and #2267 carry the evidence; all remain open. Do not build the downstream runtime until A0's
confinement proof and Phase A go/no-go are resolved. Supplementary-state approval is now recorded;
this does not establish confinement or authorize downstream runtime execution.

## Resumed A0 experiment

After Ben reported the prior agent was reaped, root resumed in the same worktree. New files
`tests/uat/workshop-confinement-probe/run-container-proof.py` and `container-cases.mjs` test a
minimal disposable container boundary, keeping provider/toolchain integration unproved.
Luna reviewed the harness; cleanup now attempts every owned resource and verifies the daemon
can report no remaining names/tags. PID evidence uses `pids.events`, not configured `pids.max`.
R1/R2 startup failed because Docker's local log driver rejects compression with one retained
file; both runs cleaned up. R3 disables compression while retaining the 1 MiB log ceiling.
R3 passed filesystem/network/peer checks but its process-tree readiness timed out at 96 MiB/32
PIDs; the precise cause was not captured. R4 at 192 MiB/64 PIDs passed, exit 0:
`/tmp/workshop-a0-container-proof-r4.log`. Candidate digest
`sha256:a3d68638562a5ec09230fefddede1bedffb7fba0984e63f0d00ae2d7fbf33663`.
Nine owned containers and the unique image tag were removed and absence verified; shared cache
retained. Python/Node syntax, scoped ESLint and formatting pass. No shared service changes.
The boundary document records exact observed checks and limits. Next bounded work is a provider
conduit feasibility proof, not the downstream builder. General CLI-runner RPC/MCP sockets must
not be exposed to an attempt as a shortcut. All changes remain uncommitted in this worktree.

## Data-only continuation

`run-container-proof.py --data-only` passed exit 0; log `/tmp/workshop-a0-data-only-r1.log`.
Image `sha256:7b6e6541d6f524e29c536e6e3118b3bcc79c3f713f0ec08dec19a2d7ab1c9eac` contains only
Node/libs, esbuild and public SDK plus the probe. Real HTTP adapter calls to local fixtures for
all three provider kinds returned exact source-only artifacts; source crossed stdin without
credentials and was compiled/invoked with the real SDK inside the restricted container.
Traversal and a compiler read of the existing private sentinel were denied. Three containers
and the image tag were removed and absence verified. Real vendor authentication is not proved.

Luna authored `data-only-provider-proof.ts`; root corrected unavailable root Ajv import, Google's
model-in-URL check, bounded request handling, and actual returned-artifact handoff. It uses public
`@moss/ai` exports and native assertions. Final root tsc passed (`/tmp/workshop-a0-provider-tsc.log`).
Source-only handoff now looks smaller than a new provider proxy. The boundary document records
this recommendation, exact evidence and remaining capability tasks.

Important correction: the earlier claim that all structured CLI generation is Claude-only was
wrong. Only persistent scoped structured streams have that restriction; one-shot engines exist
for all three. The provider-coverage question was withdrawn; do not treat it as an approval or
provider restriction. CLI safety is still unproved: Codex ambient MCP and Gemini native/ambient
tools need attention before trusted data-only generation is claimed safe for those paths.
No real login, live credentials, app service change, production code, commit or deployment.

## Authenticated continuation — passed

Ben selected the existing Claude connection. The trusted provider helper used the exact token
path used by Moss's CLI runner, entirely inside the running Moss container; no credential value
was displayed or copied to the host, builder, prompt, or artifact. No login/configuration change
or service restart was needed. This directly exercised the installed CLI and its stored account,
**not** the production actor-scoped router, CLI-runner RPC, or `CliStructuredAdapter` lifecycle.

`authenticated-claude-proof.mjs` passed, exit **0**, using Claude Code **2.1.183** and resolved model
**claude-sonnet-4-6** (requested alias `sonnet`). A fresh temporary HOME/config directory, empty
setting sources, `disableAllHooks`, disabled auto-memory, no session persistence, empty native
tools and strict empty MCP configuration excluded ambient project/user context. `--bare` was not
used because this installed version explicitly excludes OAuth in bare mode. Observed init:
`tools: ["StructuredOutput"]`, `mcp_servers: []`; only the schema transport tool was available.
The probe checks tool-use records and successful structured completion before accepting source.
Hook suppression is configured, not a hostile-hook execution test. No agentmemory call was made.

The provider process had a 120-second wall deadline, 64 KiB combined output cap and $0.50 CLI
budget setting. Its detached process group was killed in `finally`, and its temporary home was
removed. This is trusted-process cleanup, **not** proof that arbitrarily reparented provider
children cannot survive. Raw provider stderr is discarded; only sanitized evidence is logged.

Actual source artifact: **250 bytes**, SHA-256
`25e95e1f88f27b65df30160d9012f7fe7d038f5050a701e1f95dd57a62722ce3`.
Logs: `/tmp/workshop-a0-claude-generation-r1.log` and `/tmp/workshop-a0-claude-build-r1.log`;
artifact: `/tmp/workshop-a0-claude-artifact-r1.json`. Generation and build both exited **0**.

`run-container-proof.py --data-only --artifact-file <artifact>` passed that exact returned JSON
over stdin to image
`sha256:7b6e6541d6f524e29c536e6e3118b3bcc79c3f713f0ec08dec19a2d7ab1c9eac`.
The generated TypeScript compiled with real esbuild and the public SDK, emitted `worker.ready`,
and answered `word.read` through `module.invoke` with `{word: "quasar"}`. Filesystem/network/profile,
traversal rejection and denied-sentinel compiler probes passed. All three unique containers and
the image tag were removed and absence verified; shared cache retained. This did not rerun the
already-passing resource stress suite. No generated code ran in the trusted provider environment.

Luna reviewed the extension. Malformed shape, traversal, wrong content type, excess fields,
oversized artifacts and symlinks were rejected before Docker. Final guards also reject Python
`-O` and non-regular files without blocking. Syntax, scoped ESLint and formatting passed.

**Still required:** actor-scoped capability/model routing, CLI safety for other providers, full
web compilation, application attempt/revision/stop behavior, and deployment integration. This is
one simple generated worker proof, not the complete Workshop or a Phase A go decision.

Next bounded proof: full web toolchain under this same source-only boundary, then resolve the
remaining routing/lifecycle/other-provider gaps before Ben's Phase A go/no-go. Do not repeat the
successful primitive, storage, HTTP fixture or simple worker proofs without a changed concern.
The Claude selection question was removed from AWAITING-BEN. All edits remain uncommitted in
`~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`; no push, PR, merge, deployment or shared restart.

GitHub #2265 updated with authenticated proof and remaining gaps; issue remains open. Final
scoped lint, syntax, documentation formatting, whitespace and eight unsafe-input checks passed.

## Web and browser continuation — passed

The next authenticated response (same Claude Code 2.1.183 / claude-sonnet-4-6) contained exactly
worker index, web index and CSS: **886 bytes**, SHA-256
`0bcf7e56189b4056be0d7a57d9cff7c2a8cff493819f81b2d3ba0abd4d3e6c06`.
Generation exit **0**, log `/tmp/workshop-a0-claude-web-generation-r1.log`, source
`/tmp/workshop-a0-claude-web-artifact-r1.json`. This source was reused without another model call.

`--data-only --web --artifact-file <source>` passed exit **0**, log
`/tmp/workshop-a0-claude-web-build-r1.log`, image
`sha256:9d062deccdb18749f6562db854f247a38b6445c98e0311c0db2bb28ad4649aa3`.
The actual production web recipe (browser ESM/ES2022, classic JSX, React shims/injection and CSS
text loader) compiled the public module-web-sdk, UI and pinned lucide-react 0.468.0. Metafile
checks rejected retained external imports and bundled real React; the resulting default export
loaded with contractVersion 2, callable Root and expected CSS. Worker invocation still passed.

Adding `--browser` passed exit **0**, log `/tmp/workshop-a0-browser-r4.log`, image
`sha256:a4ae9491d04303b6ca8337495f0aee8e0f32a4b0ae5e2c07d56d9f9786522f08`.
The scratch image adds only cached public Chromium, its observed ldd libraries, Liberation fonts,
Playwright 1.60.0, React/ReactDOM 19.2.7 and scheduler 0.27.0. No app/auth files, volumes, sockets
or environment enter the image. The trusted host-page fixture is bundled inside the container;
generated code is compiled, loaded and rendered there only.

Browser profile: UID/GID 1000, cap-drop ALL, no-new-privileges, read-only root, network none,
**512 MiB/no swap, 128 PIDs, 0.5 CPU, 64 MiB workspace tmpfs**. These are separate recorded
ceilings from the smaller worker profile. Chromium uses `--no-sandbox`; the tested Docker profile
is the isolation boundary, not Chromium's internal sandbox. Baseline filesystem/network and
cgroup checks passed on this image; previous stress checks were not rerun at these larger ceilings.

Real Chromium **148.0.7778.96** loaded a fresh context with blocked service workers and exactly
three intercepted fixture resources. The page rendered Daily word, clicking Show word displayed
quasar, and no unexpected requests/page errors occurred. The module-region screenshot was
visually inspected: `/tmp/workshop-a0-c28fe5761b70-web-proof.png`, **6029 bytes**, SHA-256
`dcbb5265d7a27779eae14f3088210ad43251c4ecd5f0b8640ff0e01bb65a8ef8`.
Only public fixture content is present. This bare proof page is not the Workshop design.

Worker invocation, browser ESM load, traversal and unreadable-sentinel compiler denials passed.
All three unique containers and the image tag were removed and absence verified; synthetic
sentinel unchanged, shared Docker cache retained. Browser context/process close is attempted in
finally; container removal supplies the final process boundary. No shared service was restarted.

R1 failed a Chromium layout assumption and R2 a missing docker-cp container prefix; both removed
one source container before image creation. R3 rendered/clicked successfully but failed screenshot
export through Docker's archive view of the workspace tmpfs. It removed all three containers and
image tag. R4 exports the fixed screenshot through a bounded regular-file read in the running
container and validates PNG signature/hash, then completes the denial and cleanup checks.

Luna implemented/reviewed the two bounded case files; root corrected loader/dependency paths,
ReactDOM aliases, external dynamic import and control harness details. Scoped ESLint, JS/Python
syntax, formatting, whitespace and five malformed-web-envelope rejection checks passed.

**Boundary:** the browser uses a tiny host fixture with real React, not Moss's actual loader,
router, CSS confiner or API. The clicked word is local component state; the worker invocation is
proved separately, not wired to that button. Actor-scoped routing, approval/revision/stop behavior,
other-provider CLI safety, dev/prod orchestration and the integrated Workshop remain unproved.
Do not turn this local browser success into a Phase A go decision or deploy it as the runtime.

Next: tighten the A0 selected deployment contract and divide the remaining actor-routing,
CLI hardening and attempt lifecycle work into R1-owned tasks for Phase A review. Do not restart
from scratch or repeat successful proofs. No current Ben question. No commit/push/PR/merge/deploy.
All work remains in `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.

Final review found no blocker in the passed R4 path. Final screenshot-digest assertion was checked
against the retained renderer record and PNG; only formatting changed after live R4. No need to
rerun the browser without a new functional concern.

GitHub #2265 received a brief status-only update. Automatic approval review rejected posting the
detailed environment/filesystem evidence to the unverified external destination. Root verified
that motioneso/moss is this checkout's Git origin and public, then automatic review approved the
smaller update containing no new internal paths/hashes/logs/environment details. Full evidence
remains local in this worktree. No Ben question remains pending for that update.

## Deployment contract and task split — documented

Continued in the same worktree; documentation only. The boundary document now recommends the
proved source-only shape explicitly: trusted capability-routed generation, validated source into
a fresh networkless container, bounded artifact return and current-authority checks. It replaces
stale provider-in-builder broker language and covers CLI authority, fixed recipes, image/resource
profiles, stop/crash behavior and staging on the installed-module filesystem.

The missing deployment control path is explicit: the probe used host Docker access that the
current dev worker/production app do not have. Do not move the harness into the worker or mount a
Docker socket to claim deployment parity. A0 must compare a fixed-operation host launcher with a
provisioned isolated execution service, name the smallest acceptable mechanism, and prove its
control/deadline/restart/cleanup behavior in disposable dev/prod shapes. New management authority
is a Phase A review tradeoff, not selected or approved here. No current Ben question.

The build plan splits R1 into R1a trusted generation, R1b CLI safety, R1c public image, R1d
deployment control and R1e attempt adapter. Each has owned paths, dependencies and exit evidence;
M1/M2 retain routing/configuration ownership and R3/R4 retain durable recovery/stop ownership.
These are local task contracts, not created GitHub issues or permission to execute R1. Existing
router source confirms JSON/tier/model propagation is reusable, but not proof of actor-scoped
execution or cancellation authority. No provider restriction was introduced.

Validation: scoped Markdown formatting, local document links/anchors, task-ID consistency and
whitespace checks passed. No code, provider, Docker or database test was rerun; no agentmemory,
shared service, GitHub, commit, push, PR, merge or deployment operation occurred in this continuation.

## Host-control and CLI-configuration continuation — passed

User asked to keep progressing without repeated stops. Root built and ran the next two bounded
A0 probes in this same worktree, then corrected one stale provider assessment. No production
runtime or deployment files changed. Luna reviewed the control harness and its restart delta.

`run-container-proof.py --control-plane` passed R1 and final R2, exit **0**, log
`/tmp/workshop-a0-control-plane-r2.log`; minimal public image
`sha256:a8d4ebebd3be7346f0b36b24748f4792a5871eb629b931bff9f02c467fed6c81`.
New `control-plane-proof.py` uses fixed synthetic owner/run/lease fixtures and transient user-systemd
units. A disposable trusted client can reach only the private control socket; attempt containers
receive no control/app/auth mount. Six malformed/unauthorized start cases plus cross-owner stop
are denied; duplicate and consumed runs cannot relaunch. Stop removes three detached process
identities. SIGKILL of the launcher leaves systemd's 20-second deadline intact: observed failed/
timeout state and container/process absence without issuing stop, with peer identities unchanged.
Restart retains exclusive host-private claim files, denies consumed/stale runs and stops the peer.
All three unique units, five owned container names and unique image tag were removed and absence
verified; sentinel unchanged and shared image cache retained. No shared service restart.

The selected design recommendation reuses `infra/host/`'s existing narrow host-control pattern;
proposed R1d files are `workshop-control.py` and `install-workshop-unit.sh` there. Do not reuse the
restart button's world-writable sentinel directory for private control. This proof is user-systemd
255.4 and synthetic client containers, not actual dev/prod application wiring. No source transfer,
real application authority, power-loss persistence or arbitrary hostile-code proof is claimed.

`codex-config-proof.mjs` passed against installed **codex-cli 0.144.5**, no model call or credential
files supplied. Log `/tmp/workshop-a0-codex-config-r1.log` (final negative-control assertion checked
again in R2). Existing native-tool disabling flags retain synthetic user/project MCP registrations;
`-c mcp_servers={}` ALSO retains them. A separate CODEX_HOME still loads trusted-project config;
separate home plus empty neutral cwd lists none. Never use an empty MCP table override as evidence
of exclusion. Native/hook execution, system/managed config, authenticated generation and actual
runner composition remain unproved. Synthetic homes and child groups cleaned up.

Correction: Gemini's engine already writes `tools.core: []`; its **12 existing unit tests passed**,
log `/tmp/workshop-a0-gemini-engine-tests.log`. The inspected app container has no Gemini executable
at its standard installed path. No Gemini package/login was installed. Effective ambient MCP,
hooks/settings and authenticated behavior remain unproved; no provider restriction is authorized.

The boundary record, plan and probe README include reproduction commands, observed checks and
remaining gates. Existing worker/web/browser/storage proofs were not repeated. No agentmemory,
DB, GitHub, commit, push, PR, merge, shared configuration or deployment operation occurred. The
next step must address the actual integration gaps or bring the concrete Phase A capability plan
for Ben's go/no-go; do not call the assembled Workshop done from these passing local fixtures.

Current decision request: the plan's “Concrete decision after the local proofs” recommends limited
R1a–R1d capability implementation plus M1/M2; it explicitly does not
claim full Phase A go or authorize deployment/merge/downstream Workshop delivery. Await Ben's ruling
before those edits. This is the plan's Ben-owned go/no-go gate, not a missing-login request.

Final continuation validation: Python/Node syntax, scoped ESLint, Markdown formatting, local
links/anchors and diff whitespace passed. Codex final R2 exit **0**; configuration negative control
is explicitly asserted. The plan decision was added to `docs/coordination/AWAITING-BEN.md` and
`needs-ben workshop-phase-a` queued the required notification; await chat or the matching reply
under `~/.needs-ben/replies/`. No automatic approval review rejection occurred in this continuation.

## Limited implementation approved — active

Ben replied "approve" to the concrete scope after the summary/pros/cons. Approval covers R1a–R1d
plus M1/M2, starting with R1b, while new execution remains unavailable pending assembled checks.
Production service installation/deployment/merge and R1e/downstream tasks remain outside scope.
The plan records the ruling and AWAITING-BEN entry is removed. Root is tracing the actual
structured-generation/runner seams and will track the bounded implementation task in GitHub.

## R1b first implementation — cancellation guard (#2276)

Task: <https://github.com/motioneso/moss/issues/2276>, open. Root traced the shared structured
provider entry and CLI adapter before editing; Luna implemented the AI-layer guard and reviewed
root's CLI adapter change. The initial CLI regressions reproduced seven failures (late success
on timeout and factory/submit/read aborts).

The shared AI entry now rejects a post-abort adapter response before parsing, validation, repair
or usage logging. CLI one-shot generation rejects timeout/abort late reads while preserving
recovery after ordinary process-exit failures. Both CLI modes check cancellation at async phase
boundaries, and the public adapter checks again after cleanup. Scoped abort rejects a pending
read immediately through its cancellation race. Exit telemetry cannot report complete after an
abort during cleanup. These are return/dispatch guards, not proof of physical process confinement.

Targeted suite passed 21 tests; scoped ESLint and root `tsc --noEmit` passed before the final
telemetry assertion adjustment (final checks recorded next). Logs:
`/tmp/workshop-r1b-cli-red.log`, `/tmp/workshop-r1b-cancellation-final.log`,
`/tmp/workshop-r1b-cancellation-tsc.log`. Ordinary retained-scope isolation and valid exit-teardown
reply recovery remain covered. No new UI/configuration path was enabled. All edits uncommitted.

Next bounded R1b work is an explicit source-generation policy through the existing AI/CLI runner
seams. `needsStructuredOutput` is shared by ordinary structured callers and cannot itself mean
isolated source generation. Reuse existing engines and fail unavailable where the effective
no-ambient-tool policy has not been proved; no provider fallback/restriction was approved.

## R1b source-generation policy implemented locally (#2277)

Task: <https://github.com/motioneso/moss/issues/2277>, open. All edits remain uncommitted in this
worktree. Ben's existing limited approval still applies; no new decision is pending.

`sourceGeneration: true` now passes through the shared structured AI input and CLI adapter.
Each source call uses a unique ephemeral session and always closes/purges it. The RPC client
uses the distinct `launchSourceGeneration` operation, with only provider, concrete model,
persona text and bounded schema. Older runners reject that operation without an ordinary-launch
fallback. The runner owns credential lookup and forces the demonstrated source policy; source
calls cannot choose homes, commands, environment, mounts or limits. Source-session active/in-flight
collisions are rejected under the existing admission mutex; ordinary same-key relaunch is preserved.

Claude source launches use direct argv, a fresh private home/config, minimal environment,
empty native-tool/MCP configuration, disabled settings sources/hooks/memory and no persistence.
The engine counts raw stdout plus stderr bytes, decodes UTF-8 across chunks, enforces a 120-second
ceiling and accepts only a successful process close with a matching-model init and validated
structured completion. Other native tool records, changed authority, failed/oversized output and
literal or JSON-escaped credential echoes are rejected with sanitized errors. Kill removes the
owned process group, waits for close and disposes the temporary home. These are CLI launch
controls, not a physical hostile-code sandbox or durable attempt fencing.

Validation: **159 tests passed across twelve targeted suites**, including full local Unix-socket
RPC tests, ordinary Claude behavior, adapter cancellation, narrow payload validation, older
runner rejection, canonicalized credential echoes and existing persistent/relaunch/purge behavior.
A new assembled test exercises real RPC client/server/runner/engine with a synthetic executable
and runner token; source launch, submit, validated read and private-home cleanup all pass.
Its temporary socket uses the existing test-only realpath override; that guard has separate
coverage. Final logs: `/tmp/workshop-source-verified-tests.log`,
`/tmp/workshop-source-verified-lint.log` and `/tmp/workshop-source-verified-tsc.log`.
Scoped ESLint, Prettier and diff whitespace passed; root TypeScript completion is recorded below.

Broader static limits remain: `tsconfig.tests.json` reports existing missing `faviconUrl` and
removed `ChatSettingsView` references in two unrelated tests. File-size checks still flag
`packages/shared/src/sports-api.ts` and `tests/unit/sports-public-source-reader.test.ts`.
The changed runner host remains at 994 lines by replacing stale history with current
invariants. The sandbox blocks Unix-socket listeners, so the RPC tests ran with an approved
sandbox escalation; `node --import tsx` runs the file-size script without tsx's blocked IPC server.
No DB/foundation gate was run. Initial fake-executable failures were traced independently to its
output fixture; tests now write raw file descriptors and use an explicit exit handshake.

Next bounded work: continue R1b with authenticated actual runner composition and the remaining
Codex/Gemini policy proofs, or take R1a/M2's actor/model routing slice with a tracked task before
editing worker composition. Do not claim the current shared runner credential path proves
multi-actor credential isolation. R1a–R1d/M1/M2 integration remains incomplete; R1e and downstream
Workshop delivery remain gated. New Workshop execution is still unavailable. No host service
installation, deployment, shared restart, provider login, provider call, agentmemory operation,
commit, push, PR, merge or issue closure occurred in this continuation.

Runner follow-up: timeout cleanup now kills the captured source engine, including a source
launch that succeeds after its RPC timeout. The regression proves both cleanup attempts and no
registered late engine. Broader host tests caught an ordinary same-key relaunch regression;
the collision guard now tracks source reservations/engines only, preserving ordinary relaunch.
Both that existing test and the assembled source-versus-ordinary collision check pass.

Final root `tsc --noEmit` completed with exit **0** after all runtime and assembled-test changes;
scoped lint and formatting also passed. #2277 remains open with the bounded implementation
status and remaining authenticated/actor/provider-parity acceptance recorded on GitHub.

## Authenticated adapter/RPC/runner continuation — passed

Continued #2277 in this same worktree, with one new proof harness and local evidence docs.
`tests/uat/workshop-confinement-probe/authenticated-source-rpc-proof.ts` bundles current worktree
code and exercises the actual `CliStructuredAdapter` → authenticated Unix-socket client/server →
`CliChatEngineHost` → installed Claude source-policy engine. No fake executable or socket-guard
override. The previously selected existing Claude connection was used inside Moss, with a minimal
environment and a private runner home containing only an in-container credential symlink.
No credential value was copied to the host or printed, and returned source was never executed.

R1 exited **0**, log `/tmp/workshop-authenticated-source-rpc-r1.log`. Installed CLI version checked
separately: **2.1.183**, concrete model **claude-sonnet-4-6**. Expected one-file source envelope:
**84 bytes**, SHA-256 `d7fba43a2cede9ce78cf52e217cc1ce301caa2d7a60bc82fe4c9388f516e337f`.
Assertions passed for exact returned source, closed session, removed source/adapter homes,
no process retaining the source cwd (including deleted directories), and a live peer. Finally
owned sessions/peer, private socket and roots were removed; both named evidence records passed.
The source engine enforces 120 seconds/64 KiB and the harness aborts at 135 seconds.

The proof uses real server/host/engine classes but deliberately omits installer/login services;
startup sweep operates only on its private runner home. Full `createCliRunner` and actual dev/prod
wiring remain unproved. Actor routing/credential isolation, hostile-hook execution, live
abort/timeout, changed-cwd hostile descendants and Codex/Gemini policies remain open. No complete
Phase A go or Workshop execution enablement is claimed.

Initial root TypeScript caught an unused unknown RPC option and missing union narrowing in the
harness. Removed the ignored option and added a `rawText` shape assertion; these do not change the
passed provider path. README contains exact reproduction commands. No provider call was repeated.
Final root `tsc --noEmit` exited **0**, log `/tmp/workshop-source-rpc-resume-tsc-final.log`.
Scoped ESLint, Prettier and diff whitespace passed. No DB/foundation gate or unrelated test suite
was rerun; this continuation changes only the runnable proof and evidence docs.

No agentmemory, DB, GitHub mutation, commit, push, PR, merge, service restart, installation or
deployment occurred. Existing authorization still applies; no Ben decision is pending. Next
bounded work is the remaining R1b installed-version hostile-configuration/abort/provider checks,
or the already approved R1a/M2 actor-routing slice with a tracked task before worker edits.

## Installed Claude hooks and live RPC cancellation — passed

Resumed the explicit line-451 handoff in the same worktree under existing #2277 authorization.
Only proof harnesses and evidence docs changed. The new
`tests/uat/workshop-confinement-probe/claude-hostile-hooks-proof.ts` uses the real source launch
policy and existing in-container credential. It seeds only its private Claude config with a
synthetic `SessionStart` hook whose sole action writes a marker under the proof root.

The control enables user settings and hooks, requires the marker, and kills its own process
group. The protected run keeps production launch arguments unchanged, requires no marker and
a validated tool-restricted `{word: "quasar"}` response. Both private homes and the proof root
were removed. Log `/tmp/workshop-hostile-hooks-r2.log`, exit **0**, all three named checks passed.
R1 could not access Docker from the sandbox; R2 used approved escalation. No automatic approval
review rejection occurred. This is combined user-config hook exclusion, not individual-flag,
project/managed/plugin-hook or MCP execution evidence.

The existing authenticated RPC harness now accepts `WORKSHOP_PROOF_ABORT=1`. It delegates every
RPC to the real client/server/runner/engine, observes an incomplete read after prompt submission,
captures live source-cwd PIDs, then aborts. R1 observed **one** live process and passed with
`AbortError`, no returned artifact, timeout exit telemetry, removed PID and temporary homes,
closed session and intact peer. Final cleanup removed runner root/socket and peer. Log
`/tmp/workshop-source-rpc-abort-r1.log`, exit **0**, both named checks passed. Cancellation can
occur during CLI startup: no claim that a remote model request had begun or was cancelled.

Installed CLI version was checked separately: **2.1.183**, model **claude-sonnet-4-6**.
The protected hook run performed authenticated generation; the earlier ordinary successful RPC
proof was not repeated. No returned source was executed or exported, and no credential value
left Moss. These runnable native-assertion harnesses are the checks for this proof-only change.
Root `tsc --noEmit` passed, log `/tmp/workshop-r1b-installed-tsc.log`; scoped ESLint passed.
Final scoped Prettier and diff whitespace checks passed. No DB/foundation gate was run.

Remaining R1b work: installed engine wall-timeout, broader hostile configuration/descendants,
Codex/Gemini policy, full runner/deployment composition and actor isolation. The approved R1a/M2
routing slice remains another next bounded task, with a tracked task required before worker
composition edits. Full Phase A/R1e/downstream execution remains gated. No agentmemory, DB,
GitHub mutation, commit, push, PR, merge, shared restart, installation or deployment occurred.

## Real engine deadline and full composition — passed; Codex investigation pending

Ben requested continued work while context remained. The existing RPC harness gained two modes,
with no production changes. `WORKSHOP_PROOF_DEADLINE=1` withholds prompt submission so the real
installed CLI waits on stdin, while actual engine/RPC reads enforce the unmodified 120-second
wall limit. The adapter outer timeout is 130 seconds; the harness abort backstop is 135 seconds.
R1 passed after **120,053 ms** with the engine's timeout error, no external abort/artifact,
removed observed PID/homes/session and an intact peer. Both named checks passed, exit **0**,
log `/tmp/workshop-source-deadline-r1.log`. No model call occurred. This is not a remote-response
timeout proof. The existing live-abort probe still covers prompt submission separately.

`WORKSHOP_PROOF_FULL_RUNNER=1` uses actual `createCliRunner`, including its real installer/login
and persistent-pool wiring. Its tools inventory starts empty under the private proof root, so
startup reconciliation cannot reinstall or sweep shared releases. Only after startup is the
existing Claude executable symlinked into that private prefix. No actual install/login call is
made. Both generation and live cancellation passed through this composition, exit **0**:
`/tmp/workshop-full-runner-source-r1.log` and `/tmp/workshop-full-runner-abort-r1.log`. Generation
returned the same **84-byte** expected artifact/digest as the earlier RPC run; cancellation
removed **one** observed process and returned no artifact. Session/cleanup checks now themselves
use RPC clients; both named cleanup records passed. Installed Claude remains **2.1.183**,
concrete model **claude-sonnet-4-6**. Full deployed startup/reconciliation and actor isolation
remain unproved; these passed fixtures do not authorize deployment.

New `codex-source-request-proof.mjs` uses installed **codex-cli 0.144.5** and a local Responses
fixture, empty synthetic HOME/CODEX_HOME, neutral cwd, no real credentials and no vendor call.
R1 observed `update_plan`, `request_user_input`, `view_image` despite the candidate disable flags,
including `tools.view_image=false`. R2 attempted an actual synthetic-image tool call; both runs
exited **1** after one request, with private-root/process/server cleanup. Logs:
`/tmp/workshop-codex-source-request-r1.log`, `/tmp/workshop-codex-source-request-r2.log`.
Native image-read execution remains **unproved**. Do not interpret the requested tool list as
proof of execution or accept this candidate as safe. Official docs describe the image flag as a
boolean; installed-version behavior must be demonstrated instead of inferred from acceptance.

Automatic approval review rejected the instrumented diagnostic rerun, citing two identical
failure summaries. No rejected process ran. Root asked Ben via async input, added AWAITING-BEN
and queued `needs-ben workshop-phase-a`. That helper needed an approved sandbox escalation to
write its queue. While awaiting the answer, static inspection found an invalid CRC in the PNG
fixture, repaired it and added a native CRC assertion. This is a confirmed fixture defect, not a
confirmed explanation for the CLI failure. The proposed diagnostic now emits at most 1500 bytes
of synthetic-only CLI output and a bounded fixture error; no real credential enters this harness.
Do not rerun that diagnostic until approval arrives. Root continued the unaffected full-runner
work above instead of retrying the blocked operation.

Root TypeScript passed after the full composition changes, log
`/tmp/workshop-full-runner-tsc.log`; scoped lint/bundling passed. Final scoped ESLint, Node syntax, Prettier, synthetic PNG CRC
and diff whitespace checks passed. No DB/foundation gate was run. All source remains
uncommitted; no GitHub mutation, agentmemory, shared service restart, install, deployment, push,
PR or merge occurred. Source generation still fails unavailable for undemonstrated providers.
Next: resolve the pending Codex diagnostic, then its effective native-tool/hook policy; Gemini
installed evidence, actor/model routing and actual deployment acceptance remain open.

## Approved Codex diagnosis and source-dispatch guard — completed locally

Ben replied "approve, proceed" to the specific diagnostic. The single approved run identified
`usage.total_tokens` missing from the local SSE completion event, which made Codex abort after
one request. It also showed the actual `view_image` handler attempting to read the synthetic PNG,
then failing because this container denies Bubblewrap's namespace creation. No image escaped.
The previously repaired PNG checksum was a separate fixture defect, not the observed SSE failure.
Diagnostic log `/tmp/workshop-codex-source-request-diagnosis.log`, exit **1**, bounded synthetic-only
error output. Added `total_tokens`; asserted the specific filesystem-helper error in the second
request and no attached image rather than relaxing the sandbox.

Corrected R3 passed, exit **0**, `/tmp/workshop-codex-source-request-r3.log`: two local fixture
requests, tools `update_plan`, `request_user_input`, `view_image`, native image-read attempt,
namespace denial and no image attached. The CLI then accepted the expected structured result.
Both negative-control and cleanup records passed. This **rejects the candidate source policy**;
it does not prove a successful file read or safe Codex generation. Installed version is 0.144.5;
the synthetic model uses fallback metadata, so real-model behavior remains unproved. The final
harness removes raw diagnostic output. AWAITING-BEN was cleared; no diagnostic approval remains
pending. No real Codex credentials or vendor calls, and no sandbox was relaxed.

The next inspection traced worker model selection and shared AI dispatch. A proposed new
GitHub task for the dispatch guard was rejected by automatic approval review as unauthorized
external disclosure; no issue was created. The existing #2277 contract already requires concrete
routed models and source-only launch validation, so root kept this small safety guard within that
open task and made no external write. R1a/M2 worker composition was inspected but not edited.

`generateStructured` now rejects empty/default source model selectors (including surrounding
whitespace) and credential rows whose provider ID, owner or provider kind disagree with the
selected model, before either decryption or adapter creation. Ordinary requests preserve their
existing default-model behavior. New tests cover CLI/API invalid routes, exact concrete-model
propagation for two synthetic actor contexts, and unchanged ordinary defaults; existing abort
checks remain. Both invalid-route tests initially reproduced accepted success; after the guard,
**10 tests pass**. Logs `/tmp/workshop-source-route-red.log` and
`/tmp/workshop-source-route-green.log`. These are fake-repository dispatch checks, not DB RLS or
per-actor runner credential proof. No new user-facing capability/error/remediation was introduced,
so no app-map addition is needed for this internal guard.

Scoped lint passed. Initial root TypeScript caught the test table widening `provider_kind` to
`string`; made the table a const tuple. Final root TypeScript passed, log
`/tmp/workshop-source-route-tsc-final.log`. Scoped ESLint, Prettier, Node syntax and diff whitespace
passed. Task publication was subsequently approved and #2288 was created. The current
worker-composition result and next work are in [workshop-live-state.md](workshop-live-state.md).
The new source path remains disabled for undemonstrated providers. No shared service restart,
installation, deployment, DB/foundation gate, agentmemory, commit, push, PR or merge occurred.
All changes remain uncommitted in this worktree. Remaining work: effective Codex/Gemini source
policies, actor credential isolation, source-only worker composition and dev/prod acceptance.

## R1a/M2 source-only worker continuation — local checks passed

The user approved #2288 publication and an active goal to finish Workshop as far as possible
without human testing, using only GPT-6 Astra at medium effort. Continue from the compact
[live state](workshop-live-state.md), which supersedes older pending-approval/next-step entries.
The interactive writer and host compile/install path have been removed. Source routing, bounded
file validation, cancellation and an unavailable runtime gate passed 59 targeted tests, root
TypeScript and scoped lint. No live actor-isolation or runtime acceptance claim; no deployment.
