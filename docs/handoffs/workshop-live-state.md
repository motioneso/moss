# Workshop live state

Worktree: `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.
Branch: `build/workshop-phase-a-0904`; preserve existing uncommitted changes.

Goal: finish Workshop as far as possible without human testing. All agent work uses
GPT-6 Astra at medium effort. No agentmemory operations. Ben is available for human testing;
continue independent implementation while awaiting his result. Cleanup only resources created for this Workshop task; shared
services/files and unrelated resources remain untouched.

Current compact continuation state: `docs/handoffs/workshop-resume-state.md`.
Read it before the historical checkpoints below; it corrects process-namespace observations.

## Latest checkpoint — D1/D2 persistence green, September 5 09:48 PDT

D2 user-message persistence is implemented, task #2305 (project 2 In progress). Plan:
`docs/superpowers/plans/2026-09-05-workshop-d2-project-feed.md`. New migration 0217 adds a
project counter and owner-scoped feed with composite parent/owner foreign key. Per-project row
locking holds through commit, so forward cursors cannot skip an earlier uncommitted append.
Concurrent client-message replay returns the original record; changed text conflicts. Stored
messages report pending delivery. Trusted event kinds/attempt acknowledgements remain their
owning downstream work, not a generic unvalidated event API.

Combined D1/D2 integration: 11 tests pass, `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-094448.log`,
FINAL rc=0, task DB cleaned. Root TS, test TS, scoped lint, formatting and whitespace checks pass:
`/tmp/workshop-d2-{root-tsc,tests-tsc,lint,format}.log`. Both tables participate in module export
and cascade declarations. No public project/feed route or UI yet.

Full foundation verification advanced beyond prior failures and found an undeclared shared
import in CLI runner. Added its existing `@moss/shared` workspace dependency and updated lockfile
without dependency upgrades (total lock diff six lines for Workshop/CLI runner). Full gate rerun
is active: `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-094526.log`; authoritative wait tool
session 3190. Do not infer green from focused checks.

Next product seam is D5a/U1: existing `packages/chat/src/module-build-start-impl.ts` still calls
`startModuleBuild`, model planning and possible YOLO queue dispatch. Replace via a separately
tracked create-only handoff contract and real route/UI consumers; inspect all result-card callers
before changing its returned DTO. Do not route users to a nonexistent detail page.

## Latest checkpoint — D1 integration green, September 5 09:39 PDT

D1 private project persistence (#2303) is implemented. Six runtime-role integration tests pass:
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-093645.log`, FINAL rc=0. Covers concurrent
idempotency/conflict, two admin owners and forged writes, read-only worker scope, stable pagination,
byte bounds, export scoping and owner deletion cascade. Gate database cleanup completed. Public
routes/UI are still downstream D5a/U1 work. Plan: `docs/superpowers/plans/2026-09-05-workshop-d1-project-persistence.md`.

Earlier baseline repairs now include missing news fixture field, the obsolete Settings view test,
the virtual module settings fixture/alias, sports schema/test splits, eight formatting repairs and
regenerated UI catalogue. Focused baseline checks passed 34 tests. Managed CLI detection now checks
`JARVIS_CLI_TOOLS_PREFIX/bin` before PATH, preserving HOST_CLIS precedence; 22 focused tests passed.
The task container received the rebuilt API and app map; Google Log in is visible in actual Settings.
Full static verification is running; log `/tmp/workshop-resume-static-final.log`.

Human instance remains healthy at `http://127.0.0.1:20001`, project `uat-1761667_8daad470`.
The original helper and gate runner are gone with no sentinel, so their two-hour cleanup timer
is no longer reliable. Do not rely on PID 1761667. Preserve the instance pending Ben's login result;
clean up only this exact Compose project when testing finishes. No real OAuth result has been
received. Google config ID `c60d2197-9906-437e-ba65-3a612432d8fa`; installed Gemini 0.57.0.
Never inspect/log credentials, OAuth codes or authorization URLs. Source dispatch remains gated.

## Latest checkpoint — installed Gemini engine and review fix

September 5 continuation: the earlier overall-goal completion was premature. Ben explicitly asked
to keep going and is now available for human testing. The goal is active. His blanket approval
authorizes continued implementation; historical approval pauses below are not new requests for
permission. Security/ownership/current-attempt validation and real acceptance requirements still
apply. Preparing a fresh disposable instance for provider sign-in while fixing verification
failures. Helper `test:workshop-human-login` has a two-hour backstop and signal-triggered teardown;
state `/tmp/workshop-human-0905-state.json`, owned image tag `workshop-human-0905-0827`.

Authorized offline R1a–R1d/M1/M2 implementation and its bounded proofs are recorded below.
Workshop is not delivery-complete: source dispatch remains Anthropic-only; execution remains
unavailable. R1e/durable authority, downstream UI/promotion, deployment and host installation
retain their gates. No commit/push/merge/issue closure or shared restart occurred.

Latest changes close the installed Gemini **internal engine** composition gap and a review-found
credential leak. Four pinned CLI 0.57.0 cases pass through actual `createScopedSourceEngine`:
selected 2.5 Flash, selected 2.5 Pro with native refresh, forced-tool rejection without publication,
and cancellation after refreshed authentication reaches the source endpoint without publication.
The proof substitutes only the executable/loopback endpoints at spawn; actual engine lifecycle,
input, validation, scope selection and refresh publication run. This is not Gemini RPC or vendor
acceptance. Evidence: `/tmp/workshop-gemini-installed-engine-secret.log`, rc0.

Standards review found raw JSONL credential filtering could miss secrets reconstructed by joined
assistant deltas or JSON Unicode escapes. Final normalized source now checks original and refreshed
access/refresh/ID tokens, including JSON-escaped representation, before accepting the credential
snapshot. Rejection revokes any previously accepted snapshot. Eleven focused policy/store/engine
tests pass in `/tmp/workshop-gemini-secret-regression.log`; independent recheck cleared the finding.
Spec review found no concrete defects and retained the incomplete acceptance status. Reports:
`docs/reviews/2026-09-05-workshop-r1b-standards.md` and
`docs/reviews/2026-09-05-workshop-r1b-spec.md`.

All nine existing OAuth controls pass after the shared fixture changes:
`/tmp/workshop-gemini-oauth-regression-0905.log`, rc0. The deliberately unsafe remote-MCP controls
still reproduce contact; both deny-all variants prevent it. Both proof containers and their private
state were removed. Root TypeScript, scoped ESLint/Prettier and whitespace checks pass in
`/tmp/workshop-gemini-secret-tsc.log`, `/tmp/workshop-gemini-secret-lint.log` and
`/tmp/workshop-gemini-secret-format-final.log`.

README reproduction now mounts the shared engine helper and explains engine bundle mode. The
retained public dependency/bundle fixture is `/tmp/workshop-gemini-discovery-ajxzz_21`; it contains
no real credentials and remains useful for future acceptance work. Historical “next” entries below
are chronological; this checkpoint supersedes them. Remaining acceptance is real fresh vendor
login/deployed actor-scoped CLI behavior, an effective Codex policy, and the separate runtime/
deployment/durable-authority gates. Do not weaken those gates or treat synthetic proofs as live
product acceptance.

## Final verification limits and tracker

Broader test TypeScript found an incomplete Workshop planning-provider fixture. Replaced its
type assertion and invalid execution mode with the real DTO fields. Six Settings tests pass in
`/tmp/workshop-settings-fixture-final.log`; scoped lint passes. Test TypeScript now reports only
two unchanged baseline files: missing `NewsHeadline.faviconUrl` in
`tests/unit/news-story-feedback-settings.test.tsx` and obsolete `ChatSettingsView` import in
`tests/unit/settings-setup-link-navigation.test.tsx` (`/tmp/workshop-final-tests-tsc.log`, rc2).

The required full isolated foundation gate was run, not inferred from focused tests. Its first
run found missing browser-global declarations and an unused parameter in Workshop prototype
assets. Fixed those without changing browser behavior; repository-wide ESLint now passes
(`/tmp/workshop-final-lint.log`). The corrected full gate reaches formatting and fails on eight
unchanged sports/photos/connector files:
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-062031.log`, `### FINAL rc=1`, authoritative wait
`/tmp/workshop-final-foundation-verdict-02.log`. It did not reach the full test suite.
Separate file-size check also reports the unchanged 1,022-line `sports-api.ts` and 1,156-line
`sports-public-source-reader.test.ts` (`/tmp/workshop-final-file-size.log`). All reported unrelated
paths were confirmed identical to HEAD. No full-green, CI-green, release or delivery claim.

GitHub #2277 was still Backlog despite this implementation. Corrected project 2 to **In progress**
and verified the issue stays **OPEN**. The remaining provider acceptance is tracked there;
R1a/M2 #2288, R1c #2289, R1d #2293 and M1 #2295 remain the existing capability trackers.
All source/test/prototype/doc changes remain uncommitted in the same worktree.

Final app-map validation passed through the isolated runner:
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-062255.log`, `### FINAL rc=0`, wait
`/tmp/workshop-final-app-map-verdict.log`, rc0. Its cleanup removed the task database retained by
the failed full gate. No Workshop gate is left running. The two installed-proof containers are
absent; no shared resources were removed. Consolidated review:
`docs/reviews/2026-09-05-workshop-offline-verdict.md`.

## Current result — R1a/M2 (#2288)

User approved R1a/M2 task publication; #2288 exists. Ben subsequently approved all necessary actions tonight, with cleanup limited to this task's
resources. R1c publication succeeded as #2289 after that approval. Exact text:
`docs/handoffs/workshop-r1c-task-draft.md`; also recorded in `AWAITING-BEN.md`.
Replaced the interactive worker writer and host compile/install composition with source-only
structured generation, a host acceptance port, and an unconditional unavailable runtime gate.
The gate runs before model/credential access, so queued builds fail safely without provider cost.
The source generator itself is wired into worker composition but execution remains disabled.

- Existing capability router receives `module.workshop` / interactive for authoring and
  `module.workshop.plan` / reasoning for specification. Preserve its binding/pin policy and
  concrete model; reject a selected non-reasoning spec model without rerouting.
- Actor-scoped repository reads plus explicit model/provider owner checks. Active assistant
  provider required. No CLI adapter is passed: provider-global raw tokens have no actor/config
  provenance. Never infer credential ownership from config ownership or existing login-ready state.
- Source is a bounded plain file envelope: canonical allowlisted paths, no duplicate paths,
  links, package scripts/configs, excess fields, binary/NUL content or excess count/bytes.
  No filesystem writes, generated source execution, or claim that generated tests passed.
- Existing five-second activity heartbeat now observes cancellation and aborts active generation.
  Source dispatch also has a 120-second deadline. Late source cannot reach acceptance.
- App-map metadata includes model recovery and unavailable runtime, with no bypass setting.

## Verification

59 tests passed across five suites: source generator/validator, build-step orchestration,
worker cancellation, worker gate/composition import, shared structured routing/cancellation.
Root TypeScript and scoped ESLint passed. Logs:
`/tmp/workshop-r1a-tests-final.log`, `/tmp/workshop-r1a-tsc-final.log`,
`/tmp/workshop-r1a-lint-final.log`. Scoped formatting and diff whitespace pass.

These use fake repositories/providers; they do not prove DB RLS, actual credential provenance,
live API actor routing, deployed startup or an installed Workshop flow. Updated the restart
integration fixture for the source contract but did not run DB tests. `verify-gate` was absent from the skill catalog/global roots at that checkpoint. It was later
found in `.claude/skills/verify-gate/SKILL.md`; M1 used its isolated procedure successfully.
Prior broader static limits remain in the historical handoff. No new provider calls were made.

## R1c public image (#2289) — local checks passed

New files are under `infra/workshop/`: pinned public-toolchain Dockerfile and strict context
allowlist, locked npm dependencies, runtime collector, source validator, fixed compile/test/render
recipes and disposable image proof. Base is public Playwright 1.60.0 noble at manifest digest
`sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948`.
Only Node/Chromium/libs/fonts/public SDK/UI/tokens and tool dependencies enter the scratch image.
No application image extraction, provider CLI, credentials, package manager or host mounts.

- Initial image `sha256:42bed2dff485371a46d905ed62a6ab7984a6e2316966d02b44cee49523e980fe`
  passed real SDK invocation/profile checks, worker/web bundles, offline Chromium render (8,464-byte
  PNG), malformed paths/duplicate/extra command/oversize/dependency rejection, test-output flooding,
  test timeout, peer survival and cleanup of 10 owned containers. `/tmp/workshop-r1c-proof-02.log`.
- First proof failed because Docker create omitted `-i`; source correctly rejected empty stdin.
  Fixed the harness, not the input validator. A bounded synthetic diagnostic identified this.
- Latest image: `sha256:dbf24bc666f3f966bfccac884b136198c85a33e96e035ca1e49c9288a19a5e1d`.
  Adds bounded no-follow artifact reads, child SIGKILL timeout, and resource preflight.
  Passed extended proof: `/tmp/workshop-r1c-proof-03.log`, output `/tmp/workshop-r1c-proof-03`.
  It uses worker 192 MiB/64 PIDs/0.25 CPU and browser 512 MiB/128 PIDs/0.5 CPU, no swap,
  no network, readonly root, 64 MiB noexec tmpfs, cap-drop, no-new-privileges, no daemon logs.
  Passed real network-route denial and workspace/PID/CPU/OOM stress; peer survived and all
  14 owned containers were removed. Image tool versions: Node 24.15.0, Chromium 148.0.7778.96,
  esbuild 0.25.12, Playwright Core 1.60.0. Full recipe/evidence: `infra/workshop/README.md`.
- Source parser Node test and scoped runtime ESLint pass. Formatting was applied.
- Build log: `/tmp/workshop-r1c-image-build3.log`. Tag `moss-workshop-r1c:0905-local` is ours.
  Public base image and build cache are shared Docker cache: never prune unrelated caches/images.

## Next work and gates

R1c local proof, documentation and scoped checks pass. R1d is tracked by #2293, a minimal
public entry. Automatic review rejected publishing the detailed R1d draft even under the
overnight approval; the safer metadata-only tracker was accepted. Keep the detailed R1d plan
local (`docs/handoffs/workshop-r1d-task-draft.md`); no Ben decision is pending. Do not ask again.
R1d host-control code is now implemented; see the continuation below. Reuse the fixed systemd-run/RuntimeMaxSec/ExecStopPost
mechanism proven in `tests/uat/workshop-confinement-probe/control-plane-proof.py`, not its
synthetic tokens/runs or serial claim logic as production authority. The existing host restart
pattern is in `infra/host/install-restart-unit.sh` and `jarv1s-restart.sh`. R1e and durable
attempt authority retain their design/live-path gates. M1 planning service binding/UI/API migration is now implemented and verified below. Full actor-bound CLI login provenance
and unavailable Codex/Gemini policies remain open.

The acceptance port is deliberately unavailable; it is not an attempt/lease/fencing implementation.
Do not enable it with a flag or restore host compilation. No install, deployment, shared restart,
commit, push, PR, merge or issue closure. All work remains uncommitted in this worktree.

## R1d continuation (#2293)

Implemented `infra/host/workshop-control.py`, `install-workshop-unit.sh`, and `WORKSHOP.md`.
Added optional empty-default dev/prod transport env; production exposes only a private read-only
control directory. Source remains data; actual worker composition still unconditionally unavailable.

- HMAC-authenticated, bounded, expiring start/status/stop/result requests bind run/actor/project/
  revision/attempt/lease/source hash/recipe. Shared service authentication is not live application
  authority; R1e must check that before signing and again before acceptance.
- Atomically persisted resource claims prevent repeat launch. Fixed per-run systemd service has
  independent 60s deadline, control-group kill and exact-container ExecStopPost cleanup. Helper
  additionally bounds wall/stdout/stderr. No generated host paths/commands/mounts/env.
- Standards and Spec reviewers found/fixed fixed-name atomic temp recovery and installer Python
  symlink validation. Both reviewers rechecked and report no remaining blockers. Complete claims
  are now atomically published; tests cover orphaned temporary files and mocked installer rendering.
- Six non-DB Python tests pass (`/tmp/workshop-r1d-unit.log`). Real transport-only proof passed
  compiled render/result and authenticated UID1000 container caller via private read-only socket
  mount (`/tmp/workshop-r1d-transport.log`). No Docker socket or journal in caller container.
- Full lifecycle proof 03 passed all checks, including independent timeout, peer survival and restart fencing. Proof 01 cleanup passed but assertion
  expected systemd timeout when helper's own deadline supplied earlier cleanup. Proof 02 proved
  systemd timeout with frozen helper but peer fixture exited too early. Proof 03 freezes target
  and peer containers explicitly from host, plus target helper, to isolate independent deadline.
  Earlier failures removed all six owned references each. Proof 03 removed all six owned run references and the private caller container; log `/tmp/workshop-r1d-proof-03.log`.
- Dev/prod Compose rendered with synthetic env only; asserts empty optional settings, no privilege
  or Docker mount, and read-only production transport. Python/bash syntax, Prettier and whitespace
  pass. File-size check reports only existing sports-api.ts 1022 / sports-public-source-reader.test.ts 1156. `tsx` CLI IPC is sandbox-denied; `node --import tsx scripts/check-file-size.ts` runs safely.
- Installer is first-install only; documented compatible code update preserves key/config/image/
  prefix/journal after all owned units and containers terminate. Actual install/linger/reboot and
  deployed composition remain unverified. No shared installation, service restart or deployment.

M1 implementation and checks are complete below; next bounded capability work is R1b credential provenance/provider policy.
R1e/durable authority and downstream Workshop delivery remain separately gated by the approved plan.

## M1 planning configuration (#2295) — local checks passed

Implemented shared `WORKSHOP_PLAN_SERVICE_KEY`, real planner reasoning default/requirement,
existing Settings ServiceRow and app-map recovery text. `generateStructured.requiredTier` rejects
incompatible selected bindings/pins before credentials; the R1a specification generator reuses it.
Provider-global CLI auth is unavailable for planning, consistent with the source-generation gate.
No provider fallback is added; normal route policy/pin precedence remains intact.

AI-owned read-through preserves the old planning binding before an admin visits settings. The
admin binding-list API atomically migrates the old key, preserving an explicit new key. Deletion
removes both aliases, so the legacy choice cannot resurrect. No applied SQL migration was edited.
The UI uses automatic-routing wording for module services, omits known-unavailable CLI choices,
and says actual routing/connection are checked during planning; it does not show a guessed model.

- 53 tests pass in five focused unit suites (`/tmp/workshop-m1-unit-final.log`).
- Root TypeScript, scoped ESLint, Prettier, authored-class check and whitespace pass.
  `/tmp/workshop-m1-tsc-final.log`, `/tmp/workshop-m1-lint-final.log`, `/tmp/workshop-m1-format-check.log`.
- Found `.claude/skills/verify-gate/SKILL.md` and `.claude/skills/design-system/SKILL.md` in this
  worktree, correcting the earlier global-root-only skill search. Read both and followed them.
- Waited for the photos lane's recorded gate completion, then ran
  `scripts/run-gate.sh start --gate test:workshop-routing --exclusive` and its `wait --follow`.
  First run failed startup because this worktree lacked `dist/app-map.json`; no tests ran.
  Added the existing `build:app-map` prerequisite to the scoped package script.
- Corrected gate passed **18 integration tests**, sentinel `### FINAL rc=0`, then removed its own
  database. Log `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-014011.log`; verdict
  `/tmp/workshop-m1-gate-verdict-02.log`. Actual isolated DB/API tests cover legacy migration,
  new-choice preservation, deletion, installed-module binding, selected-tier rejection, and
  existing service routing/provider tests. This is not an installed project UI/vendor login proof.
- Standards: no remaining findings. Spec: corrected misleading default-provider label, rechecked
  clear. Same-project retry in the new project UI and credential provenance remain downstream.
- #2295 is open/In progress on project 2. #2293 remains open. No issue closure, commit, push, PR,
  merge, installation, shared restart, deployment, or execution enablement occurred.

## Remaining runtime fixture verification — passed

With the repository-local verify-gate available, ran the previously unrun restart/queued-worker
fixtures using `test:workshop-runtime`. Initial run passed restart but exposed an incorrect test:
it called the write-risk queue adapter while asserting read-risk denial. Source trace confirmed
that the shared RPC host already rejects read-risk KV mutation; no production permission bug.
Corrected the fixture to exercise the real read-risk briefing adapter and added the matching
write-risk queue save/read/delete assertion. No permission implementation changed.

Corrected isolated gate passed **11 tests** across both suites, sentinel `### FINAL rc=0`, and
removed its own DB: `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-014620.log` and
`/tmp/workshop-runtime-gate-verdict-02.log`. This proves the queue restart seam and actor-scoped
RPC/storage checks with fake execution/provider seams, not a deployed Workshop build.

Remaining authorized capability gaps: actor-bound fresh CLI login provenance and effective
Codex/Gemini source policies. Unsupported/provenance-free CLI paths fail closed. R1e/durable
attempt authority, new-project UI retry, installation/promotion, real deployment and execution
enablement remain separately gated. Do not ask sleeping Ben for another approval tonight.

Final checkpoint: root TypeScript passed after the runtime fixture correction; its scoped ESLint
and whitespace checks passed too (`/tmp/workshop-final-tsc.log`,
`/tmp/workshop-runtime-fixture-lint.log`). Code knowledge graph refreshed in fast mode for this
worktree. No running Workshop gate/owned proof unit is left; both final isolated gates dropped
only their own database. All changes remain uncommitted; retain this worktree and the existing diff.

Next concrete starting point is open R1b task #2277 and the credential-scope review from
`/root/source_credential_scope`: global per-provider token storage has no actor/config provenance.
Any future Workshop CLI binding must come from fresh authenticated login in an isolated login
context, never from existing global token/login-ready state. The current fail-closed route is
intentional until that is available. Previous Codex negative control lives in
`tests/uat/workshop-confinement-probe/codex-source-request-proof.mjs`; installed 0.144.5 candidate
still exposed native tools. Do not repeat authenticated vendor calls using the global token as
actor-isolation evidence, and honor the user's GPT-6 Astra medium restriction for all agent work.

## R1b login handle ownership prerequisite — implemented and verified

The API now checks the clicked CLI configuration's kind/purpose/status and explicit actor owner
before all four login operations, then carries server-derived actor/config scope through RPC.
Runner reuse and poll/submit/cancel require matching scope; stale/foreign cancellation cannot
reap the active login. Dialog cleanup retains scope even when begin resolves after unmount.
Shared app-map text reflects Settings login ownership requirements.

**97 tests across five suites pass**: route ownership-before-RPC, composition, RPC malformed
scope/forwarding, runner scope reuse/denial and UI delayed-cleanup/StrictMode regressions.
Root TypeScript, scoped lint/format/whitespace pass. Logs:
`/tmp/workshop-login-scope-unit-final.log`, `/tmp/workshop-login-scope-tsc-final.log`,
`/tmp/workshop-login-scope-lint.log`. Both reviews clear after fixing the late-begin cleanup.
File-size check still reports only unrelated sports files; changed engine-host is 997 lines,
onboarding-routes 989, login tests 953. No DB/provider/runtime operation or shared change ran.

## R1b fresh CLI credential chain — synthetic proof passed

Bound Claude login now uses fresh isolated HOME/socket/fixed tmux config, captures only the new
flow's token, validates it uncached with an explicit credential environment and bounded process,
and publishes the actor/config credential only while that exact flow is current. Global-ready
shortcuts and echoed pasted credentials cannot mint scope. Cancellation/timeout/late-start tests
pass; polling cannot extend the hard lifetime. The old chat token path remains compatible, with
rollback if scoped publication fails. The two-file write is not a crash-atomic transaction.

Source generation now requests an owner-only provider read against the authenticated DB actor,
propagates its actor/config identity, requires scope over RPC and consumes only the exact scoped
credential path. No global fallback. Concrete model/output policy checks remain enforced.
Production Workshop CLI composition and all Workshop execution remain disabled pending acceptance.

157 tests in eight suites pass (`/tmp/workshop-fresh-source-unit-02.log`); final 36-test subset
passes with two extra race/malformed-scope cases (`/tmp/workshop-fresh-source-final-races.log`).
Actual tmux/fake-CLI proof passes fresh login all the way through source consumption, including
immediate-exit pane retention, no ambient tmux config, exact model and foreign actor/config denial
while a valid global token exists. `/tmp/workshop-fresh-login-source-proof.log`; all owned proof
resources cleaned. No vendor calls or real credential copying occurred.

Isolated DB/API routing gate passes 19 tests and removed its own DB:
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-022946.log`, sentinel `### FINAL rc=0`;
`/tmp/workshop-fresh-source-gate-verdict.log`. Root TypeScript and scoped lint/format/whitespace
pass. Both reviews clear after fixes; known unrelated sports file-size failures remain.
Full evidence, implementation files and acceptance limits: `docs/handoffs/workshop-cli-provenance-task.md`.

Next: audit the approved plan for the next authorized offline implementation now that the
synthetic Claude credential chain is complete. Actual vendor login/deployed behavior, unsupported
Codex/Gemini source policy, R1e durable authority, installation/promotion/deployment and execution
enablement remain unresolved or separately gated. Do not repeat completed login/source work or
use synthetic proof to claim live acceptance. No commit/push/PR/merge/issue closure occurred.

## R1b Gemini installed-policy evidence — offline candidate passed

Added `tests/uat/workshop-confinement-probe/gemini-source-request-proof.mjs` and reproducible
README instructions. Public Gemini CLI 0.57.0 came from the committed shrinkwrap, installed with
scripts disabled into a task-owned temporary fixture. Actual CLI ran against a synthetic local
API in a disposable network-none container; no app data or real credentials were mounted.

Four cases establish: unrestricted and project-only `tools.core: []` advertise tools, read the
sentinel, and execute ambient hook/MCP commands. System override removes native tools and blocks
the hook but **MCP still executes**. Installed merge code replaces local admin settings with
remote-admin defaults. A fresh HOME/cwd plus explicit system settings/defaults removes native
tools, rejects the forced file read, and executes neither ambient command. Unsafe cases remain
regression controls, not safety passes. `/tmp/workshop-gemini-source-request-07.log`; final
version-checked proof `/tmp/workshop-gemini-source-request-08.log`.

The fixture proves only the tested `gemini-3.5-flash` request selector. Earlier `gemini-2.5-flash`
produced a 3.5 request; remapping/helper behavior remains unresolved. No Gemini production launch
or ordinary chat code changed. Keep Gemini source unavailable: actor/config-bound fresh Gemini
login, arbitrary model preservation and deployed policy are still unproved. Ordinary chat's
project-only zero-tool claim is contradicted in this invocation and cannot justify Workshop yolo.

Next bounded work: assess provider-specific fresh Gemini authentication and exact-model policy
against R1b before considering implementation. Codex's prior negative tool-policy control remains
open. Do not repeat Claude chain work or cross R1e/downstream/runtime gates.

Final Gemini checkpoint: version-checked four-case proof passed; scoped ESLint, Prettier and
whole-diff whitespace checks passed. Exact owned container absent; public dependency fixture/cache
and its matching pointer removed. Logs retained. No production code or app-map behavior changed.

## R1b validation process cleanup — regression fixed

Audit found that `validateFreshClaudeToken` used `execFile` cancellation, which killed only the
direct validator process. A real synthetic parent/descendant test reproduced an inherited-group
child surviving abort (`/tmp/workshop-validation-tree-red.log`). The validator now spawns its own
process group and kills that group on abort, the 25-second deadline, aggregate 64 KiB stdout/stderr
overflow, and parent exit. It awaits pipe closure and accepts only successful exact `OK` output
while uncancelled. A successful parent cannot leave an inherited-group child holding credentials
or pipes. This is process-group cleanup of trusted CLI validation, not an OS confinement claim
for a process that deliberately creates a different session.

Changed `packages/cli-runner/src/fresh-cli-login.ts` and its existing unit suite only. Ordinary
login routing and the app-map contract are unchanged. Fourteen tests pass, including actual
abort/timeout/overflow/failure/success process trees, unrelated peer survival, missing executable,
pre-abort, credential environment isolation and publication races:
`/tmp/workshop-validation-tree-final-02.log`. An intermediate test fixture's asynchronous output
was not captured; a bounded diagnostic established synchronous fixture output, then the corrected
suite passed. The initial abort regression was independent of that fixture-output issue.

Actual tmux/fake CLI login-to-source proof passes with the new validator:
`/tmp/workshop-validation-tree-chain.log`; all its owned homes/sockets removed. Scoped ESLint,
Prettier and diff whitespace pass. Root TypeScript: `/tmp/workshop-validation-tree-tsc-final.log`.
No DB/vendor operation, shared restart, commit/push/PR/merge or execution enablement occurred.
Remaining Gemini/Codex and deployment acceptance limits from the preceding checkpoint still apply.

## R1b Gemini model/OAuth continuation — 16 offline cases passed

Extended the installed 0.57.0 request proof and added `gemini-oauth-fixture.mjs`. No product code
changed. Detailed configuration, reproduction and evidence limits are in the probe README.

- The 2.5 Flash discrepancy is explicit CLI remapping, while `init.model` still reports 2.5.
  A per-call dynamic model-resolution override preserves tested 2.5 Flash/2.5 Pro/3 Pro Preview
  request IDs. 403/404 responses fail without switching models. Startup model text alone is
  insufficient evidence of the actual provider request.
- Unmodified CLI native `oauth-personal` loading, token-info validation, refresh-token exchange
  and updated private credential file work against synthetic local endpoints. Missing selected-HOME
  credentials fail before source generation despite a valid credential in another synthetic HOME.
  This proves native credential-file behavior, not server actor/config binding or actual consent.
- Minimal fresh HOME attempted `play.googleapis.com` telemetry. Explicit system privacy/telemetry
  disabling, both current auto-update controls and auto-memory disabling remove that observed
  request. Only the disposable network-none container proves external egress denial here.
- Remote admin can inject required HTTP MCP discovery: initialization/tools-list contact occurs,
  but tool advertisement and a forced invocation remain blocked. Remote stdio injection is not
  supported. A fixed empty `GEMINI_EXP` removes discovery but also suppresses remote admin controls;
  it is an experimental comparison, not a selected production policy or authority bypass to adopt.
  Failed intermediate assumptions and corrected evidence are documented; do not claim that the
  remote MCP fixture executed a tool or local command.

Final original/model matrices: `/tmp/workshop-gemini-regression-final.log` (10 cases).
Final native OAuth matrix: `/tmp/workshop-gemini-oauth-proof-08.log` (6 cases). Scoped ESLint,
Prettier and whole-diff whitespace pass. Only public packages/proof scripts were mounted; the
synthetic CA was trusted only inside the disposable process. All owned Gemini containers are
absent and the owned public dependency directory/cache/pointer were removed. Logs remain.

Gemini source remains unavailable: fresh actor/config-bound login publication and actual runner
composition are not implemented; the remote-discovery policy still needs an acceptable contract.
Claude's prior verified chain and process cleanup remain intact. Next: audit the remaining
R1b/R1a–R1d/M1/M2 requirements against current artifacts before choosing another implementation.
Do not enable execution, dispatch R1e/downstream work, alter ordinary chat, or treat these fixtures
as vendor/deployment acceptance. No commit/push/PR/merge/issue closure or shared restart occurred.

## M1 installed settings proof — passed

Added `tests/uat/specs/workshop-planning-settings.uat.spec.ts` and the scoped
`test:workshop-planning-uat` package script. The test uses the real browser sign-in/settings path
and cookie-authenticated APIs in a disposable solo-admin UAT stack. It checks reasoning/JSON
model filtering, saved selection across reload, stale disabled-model display and recovery to
reasoning routing. Synthetic provider configuration points at an unused loopback port; no
provider test/discovery/chat is requested. Real-chat opt-in variables are removed from the run.

Root TypeScript, scoped ESLint, Prettier and whole-diff whitespace passed. The standard isolated
gate at `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-035329.log` completed with sentinel
`### FINAL rc=0`; the exact `wait --follow --log` command also returned exit 0. Chromium passed
the real installed settings test in 5.9 seconds (10.3 seconds including runner startup). This
proves the Settings navigation, eligible model options, actual binding PUT and persistence,
disabled selected-model warning, and recovery through the UI. No provider call or Workshop build
was exercised, and no human testing or shared deployment occurred.

The current worktree image was freshly built as `workshop-planning-0905-0615`. The first UAT
attempt encountered an existing unrelated Docker binding on port 20000. The harness's existing
retry cleaned its own attempt and used port 20001; no harness change or external cleanup was
needed. Both owned projects (`uat-3940859_2a17ed2e`, `uat-3940859_3b56b0c7`) were torn down,
their leak assertions passed, the gate removed its own DB, and the exact owned image tag was
removed. Shared image caches and other UAT resources remain untouched.

No product code changed in this checkpoint. M1 now has installed browser evidence in addition
to its previous unit/API checks. R1b's unsupported-provider policies and actual vendor/deployed
composition remain incomplete; R1e/durable authority, downstream delivery and execution
enablement retain their gates. All work remains uncommitted; no PR or issue was closed.

## R1a assembled HTTP source-routing proof — passed

Extended `tests/integration/ai-structured.test.ts` with the actual worker source generator,
actor-scoped database repository, encrypted synthetic credentials and default production HTTP
adapter against a bounded local Fastify provider. Only the exact synthetic loopback endpoint is
allowed by the test fetch wrapper; redirects and external requests are rejected.

The observed HTTP requests preserve planning/reasoning and authoring/interactive concrete models,
carry the owned synthetic credential only in the authorization header, and contain no native
tools. An admin model pin overrides the authoring binding; an incompatible interactive pin for
planning and a foreign database actor both fail without another HTTP request. Validated source
returns as data; no generated code runs. This joins the previous separate database-ownership and
fake-adapter source tests, but does not prove vendor behavior or deployed worker dispatch.

First gate `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-040626.log` exposed two fixture mistakes:
`baseUrl` belongs beside `credentialPayload`, and fixture models needed disabling before later
automatic-routing assertions. The exact-URL guard prevented a vendor request. Corrected gate
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-040820.log` passed all **20 tests**, sentinel
`### FINAL rc=0`, confirmed by the wait command's exit 0; its DB was removed.

The prior planning-browser fixture had the same misplaced URL. Its earlier UI assertions remain
valid and requested no provider generation, but that earlier configuration did not actually set
the documented loopback provider URL. Corrected both the field placement and an explicit returned
URL assertion. Browser recheck passed at
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-040856.log` using fresh task-owned image tag
`workshop-planning-0905-0409`: one Chromium test passed (7.6 seconds including runner startup),
sentinel and exact wait command both exit 0. The existing port-conflict retry again cleaned its
first attempt and used port 20001. Both owned UAT attempts and the isolated gate DB were removed;
the exact owned image tag was then removed. No shared services or unrelated resources changed.

Root TypeScript and scoped lint/format/whitespace passed after the corrections:
`/tmp/workshop-source-http-tsc-final.log`, `/tmp/workshop-source-http-lint-final.log`,
`/tmp/workshop-source-http-format.log`. No production code changed. Remaining unsupported CLI
policies and deployment/authority gates from the preceding checkpoint still apply.

## R1b Codex app-server alternative — installed candidate rejected

Checked current official configuration/app-server documentation, then exported the pinned public
CLI's experimental protocol schema in a disposable network-none container. A current-docs mention
of temporary structured threads did not establish such a method in the installed 0.144.5 schema.
The schema's `environments: []` offered a concrete alternative to the earlier exec flags.

Added `codex-app-server-source-proof.mjs` and reproducible probe README instructions. Actual
0.144.5 app-server threads against a synthetic local Responses API show: default environments
advertise `update_plan`, `request_user_input`, `view_image`; empty environments remove image
access from the inventory but advertise orchestrator `skills.list`/`skills.read` instead. Empty
selected capability roots do not remove them. Three variants return the exact synthetic model's
structured output and pass the deliberately negative inventory assertions:
`/tmp/workshop-codex-app-server-final.log`, exit 0, including owned-process/home/server cleanup.
No remaining native tool was invoked; do not claim a successful skills read or file-read denial.

Executable SHA256 `058d616bde049c0648b72d53a22a54bf428eeb3f10e76cb4d6d4d4f81b764600`,
version `codex-cli 0.144.5`. Only the copied public executable and proof script were mounted;
no app data, credential file or real model request. An initial container UID mismatch denied
traversal of the private fixture directory; matching UID 1000 fixed inspection without widening
permissions. The two task-owned containers are absent and the owned binary/schema/scratch
directory is removed. Public base image/cache retained. Scoped lint/format/whitespace passed;
lint's statement-style correction did not change proof behavior.

This rules out the tested app-server configurations as a demonstrated source-only policy. It
does not prove that every possible CLI configuration is impossible. Keep Codex unavailable and
do not add a new production app-server adapter on this evidence. Gemini's remote discovery and
fresh scoped-login composition gaps remain; existing execution/deployment/authority gates hold.

## R1b Gemini remote discovery — deny-all candidate passed

Closed the specific remote-discovery policy gap without suppressing remote administrative-control
fetches. Installed 0.57.0 settings source exposed an empty-allowlist inconsistency: CLI enablement
treats `mcp.allowed: []` as deny-all, but the core connection manager only filters a nonempty
allowlist. A real synthetic OAuth attempt reproduced MCP initialization despite the empty list:
`/tmp/workshop-gemini-discovery-proof-01.log` (failed candidate, cleanup passed).

Per-call system settings with both `mcp.allowed: ["workshop-source-disabled"]` and
`mcp.excluded: ["workshop-source-disabled"]` pass. All other names fail the allowlist; that exact
name fails the exclusion list. The expanded OAuth matrix verifies both a differently named
admin-required remote server and one matching the allowlist entry. In both cases the CLI still
fetches remote admin controls, contacts no MCP endpoint, advertises no native tools, denies a
forced MCP call and returns the exact requested model's source. No fixed `GEMINI_EXP` is supplied.
This does not claim every account restriction or deployed behavior was tested.

All **nine OAuth cases** pass in `/tmp/workshop-gemini-discovery-proof-02.log`, exit 0, including
previous token loading/refresh/missing-selected-HOME controls and the retained unsafe empty-list
control. Scoped lint/format/whitespace pass. Updated the existing probe and README; no production
engine, login path, app-map behavior or execution gate changed. The task-owned container is
absent and all in-container synthetic resources were cleaned.

For the next bounded R1b implementation, retain the public dependency fixture at
`/tmp/workshop-gemini-discovery-ajxzz_21` (pinned npm ci, scripts disabled, empty npm configs).
It contains only public packages/cache and is owned by this task; reuse it for actual Gemini
source-launch/composition checks, then remove it. Gemini remains unavailable until fresh
actor/config-bound login publication and actual runner composition are implemented and verified.
Codex and all downstream/deployment/execution gates remain as recorded above.

## R1b Gemini source-launch factory — implemented and verified, not dispatched

Added `packages/chat/src/live/gemini-source-policy.ts` and
`tests/unit/gemini-source-policy.test.ts`. The factory reads one bounded atomic JSON credential
record (`{ account, oauth }`), rejects malformed/oversized/non-file/symlink input, creates a private
HOME with native OAuth/account/settings files, and returns the tested launch arguments/env plus
stdin encoding, strict output validation and disposal. Environment includes no ambient credential,
proxy or experiment configuration. Model pinning, native-tool/hook suppression, telemetry controls
and deny-all MCP intersection match the installed policy proof. No ordinary chat behavior changed.

The output validator accepts only one matching init, successful terminal result and JSON object;
it rejects tool/error events, changed model identity, credential echoes and excessive output.
Shared structured generation still owns schema validation. The factory is an internal primitive,
not a subprocess manager or provenance issuer: its caller must own process-group/time/output
limits and derive the credential path from fresh actor/config-bound login. Runner source dispatch
remains Anthropic-only. No new callable feature means the existing unavailable app-map declaration
remains truthful.

Verification: **3 focused unit tests** (with invalid-result/credential matrices), root TypeScript,
scoped ESLint/format/whitespace passed. Logs: `/tmp/workshop-gemini-source-policy-unit-final.log`,
`/tmp/workshop-gemini-source-policy-tsc.log`, `/tmp/workshop-gemini-source-policy-lint.log`,
`/tmp/workshop-gemini-source-policy-format.log`.

The extended installed probe loads a bundle of the actual factory via `--source-launch`. Three
cases pass in `/tmp/workshop-gemini-source-launch-01.log`, exit 0: selected 2.5 Flash source,
selected 2.5 Pro with native OAuth refresh, and strict rejection of an otherwise successful turn
after a forced/denied MCP call. Stdin task delivery is asserted. All retain admin fetching and
make no MCP discovery contact. The unchanged nine OAuth controls also pass after the harness
extension: `/tmp/workshop-gemini-source-policy-regression.log`, exit 0. Both containers are absent;
all synthetic homes/processes/servers were cleaned. README has reproduction and evidence limits.

Next: connect fresh scoped Gemini login/publication and reuse bounded source subprocess lifecycle
before any RPC availability change. The original credential record stays unchanged by per-call
refresh; durable rotation needs a current-record check so a finishing source call cannot overwrite
a newer login. Keep this unfinished responsibility explicit. Reuse the retained public dependency
fixture `/tmp/workshop-gemini-discovery-ajxzz_21` (now also contains the disposable compiled policy)
for composition tests, then remove it. No deployment, execution enablement, commit, push or merge.

## R1b Gemini scoped publication and stale-refresh fencing — verified primitive

Completed the unfinished credential-store edits. The factory returns a SHA256 version of the
bounded original record and exposes validated private native refresh state only after an accepted
source result with unchanged account identity. A later rejected result revokes that permission.
The public parser normalizes known fields and enforces credential size/type constraints.

`packages/cli-runner/src/gemini-credential-store.ts` reuses the existing hashed actor/config
namespace, publishes through a private unique sibling and atomic rename, and fences refreshes
with the source snapshot version. Current-flow check, version check, rename and terminal callback
have no asynchronous gap. This assumes a single runner is the sole writer, not multi-process CAS
or durable attempt authority. Fresh login publication and ordinary native compatibility are not
connected yet; no source RPC availability changed.

Verification: **5 tests across 2 suites**, including permissions, invalid scope/input, cancellation,
account changes, accepted-result prerequisite, missing foreign scope, stale login snapshots and
concurrent refresh writers. `/tmp/workshop-gemini-refresh-unit.log`, rc0. Root TypeScript and
scoped ESLint pass: `/tmp/workshop-gemini-refresh-tsc.log`,
`/tmp/workshop-gemini-refresh-lint.log`, `/tmp/workshop-gemini-refresh-probe-lint.log`.
The rebuilt actual factory plus pinned Gemini CLI passes all **3 installed cases** with refreshed
native credential assertions and rejection checks in `/tmp/workshop-gemini-source-refresh-proof.log`,
rc0; synthetic resources cleaned. The initial sandbox denied Docker socket access; the authorized
isolated retry passed, with no network, read-only mounts and only synthetic credentials.

Next bounded work: fresh Gemini LoginService context/auth validation/publication, then source
subprocess lifecycle composition. Do not infer fresh provenance from ordinary/global readiness.
Login scope has no model: do not invent a hardcoded feature model for auth validation. Before
source dispatch, ensure output validation also protects tokens rotated during the private call;
the current synchronous result parser only knows the original credential values. Keep engine
host below its file-size limit by reusing existing lifecycle seams. Gemini and Codex stay
unavailable; R1e/downstream/deployment/execution gates remain unchanged. The public package fixture
`/tmp/workshop-gemini-discovery-ajxzz_21` is intentionally retained for the next installed check.

## R1b fresh Gemini login — implemented and synthetic process verified

`LoginService` now treats actor/config-bound Google sign-in as fresh: unique HOME and tmux socket,
explicit environment, private native auth settings and the shared installed tool/MCP restrictions.
It bypasses global readiness, retains existing scope ownership/current-flow checks and hard
lifetime, and validates only private native credential files. Ordinary unbound login is unchanged.
Main wires `validateFreshGeminiCredential`; the app map now describes fresh Claude and Gemini login.

Auth validation uses Google's fixed authenticated user-info endpoint with redirects rejected,
a 25-second deadline, a 16-KiB body bound and abort propagation. It requires the verified email
to equal native account identity and a nonexpired access credential. No feature model is selected,
no global auth probe establishes provenance, and all credential/HTTP failures collapse to failure.
Tests and process proof use synthetic responses only; actual native vendor/browser login is not
proven. The private login CLI still needs installed interactive OAuth proof before broad acceptance.

Extracted the existing Claude publication pattern into `publishFreshCredentialFiles` for its
second real caller. Gemini publishes native OAuth/account compatibility files before its scoped
terminal record. The current-flow check, renames, rollback and callback are synchronous. On
failure it attempts every earlier restore and retains backup data if restoration fails. This
is not a crash-atomic transaction or durable attempt authority. Ordinary settings seeding reuses
`ensureGeminiOnboarded` and preserves existing settings.

The source factory now shares native reads/restrictions with login. `readResult` is asynchronous
and must be awaited after child shutdown: it checks original AND rotated native token echoes,
checks unchanged account identity, and retains the accepted credential snapshot. Refresh reads
return that snapshot rather than rereading mutable files. A rejected result revokes it. This
closes the rotated-token output gap noted in the prior checkpoint; runner composition is still
unfinished and Gemini source dispatch remains unavailable.

Evidence:

- 76 tests across 7 login/source suites, `/tmp/workshop-fresh-gemini-regression.log`, rc0.
- 5 final source/refresh tests, `/tmp/workshop-gemini-rotated-secret-unit-final.log`, rc0.
  Initial run had one outdated reread-vs-snapshot assertion; corrected to verify the accepted
  snapshot plus rejection on the next result validation after account mutation.
- Actual tmux/process proof (existing Claude + new Gemini synthetic CLI, real local account HTTP),
  `/tmp/workshop-fresh-gemini-process-proof.log`, rc0. Validates native capture, account validation,
  scoped/ordinary publication, foreign-scope absence and task-owned cleanup.
- 3 pinned installed source cases, `/tmp/workshop-gemini-fresh-policy-proof.log`, rc0, including
  native refresh and forced-tool rejection with the rebuilt async policy. Container auto-removed.
- Root TypeScript `/tmp/workshop-fresh-gemini-final-tsc.log`, scoped ESLint
  `/tmp/workshop-fresh-gemini-final-lint.log`, final adjustment lint and formatting logs all rc0.
  LoginService is 804 lines; EngineHost unchanged at 997. Final shared publication/rollback
  check passed 17 tests in `/tmp/workshop-fresh-gemini-publication-final.log`, rc0. The task-owned
  installed-proof container is confirmed absent; whitespace check passed.

Next bounded work: integrate Gemini with the existing bounded source lifecycle and scoped refresh
publication, keeping ordinary chat behavior and provider dispatch gates truthful. The public pinned
fixture `/tmp/workshop-gemini-discovery-ajxzz_21` remains for installed composition checks. No human
or real vendor testing, deployment, host installation, shared restart, commit, push or merge.

## R1b shared source lifecycle and Gemini internal composition — verified synthetic candidate

Extracted Claude's existing source subprocess logic into `packages/chat/src/live/cli-source-engine.ts`.
Claude's print engine retains source-method compatibility via delegation; EngineHost's existing
Anthropic source route now constructs the dedicated source engine. Ordinary chat engine selection
is unchanged. Both policies provide stdin encoding; Gemini's async output/rotated-credential
validation and runner-owned refresh callback use the same lifecycle. The private factory
`packages/cli-runner/src/source-engine.ts` derives actor/config credential paths before admission,
so invalid scopes cannot leave a launch reservation behind.

The shared lifecycle limits combined stdout/stderr and elapsed child lifetime, waits for close,
returns no partial source, accepts only one submission, caches validated results, and kills its
own process group on failure, cancellation AND successful parent exit before waiting for pipes.
Cancellation during policy preparation cannot spawn late. Cancellation during asynchronous refresh
makes the store's synchronous current-flow guard false; kill waits for that work before private
HOME disposal. No raw provider errors or stderr cross the response boundary. EngineHost is 998
lines; the new source engine is 202 lines.

IMPORTANT: EngineHost's source provider guard remains **Anthropic-only**. An initial combined
command that would also have enabled Gemini RPC was rejected by automatic approval review because
lifecycle/security verification was not complete. That rejected command did not execute. The safe
alternative kept the guard unchanged and implemented/tested internal Gemini composition directly.
Do not treat these synthetic checks as permission to bypass installed/deployed acceptance gates.

Verification:

- 14 tests across shared source/Gemini composition/RPC suites:
  `/tmp/workshop-shared-source-engine-final-tests.log`, rc0. Includes native refresh publication,
  no partial results, foreign scope denial, cached completion, rejected tool/token/overflow/exit,
  stale-login fencing, cancellation during refresh/preparation, inherited descendants and an
  unrelated live peer surviving cleanup.
- Ordinary Claude/structured-adapter suites passed in
  `/tmp/workshop-source-engine-ordinary-regression.log`; that run's routing suite initially had
  one obsolete Claude-prototype spy for late source launch. Updated it to `CliSourceEngine`;
  all 8 routing tests pass in `/tmp/workshop-source-engine-routing-final.log`, rc0, including
  explicit Gemini RPC denial. No production code was weakened to pass the mock.
- Root TypeScript `/tmp/workshop-shared-source-engine-final-tsc.log`, scoped ESLint
  `/tmp/workshop-shared-source-engine-final-lint.log`, routing lint, formatting
  `/tmp/workshop-source-engine-final-format.log`, and whitespace checks pass.

Diagnostic gotcha: restricted sandbox execution silently dropped synthetic stdin to child Node
processes. The first Gemini composition test therefore returned `received:false`. Bounded tracing
proved policy encoding and parent writes were correct; a minimal child echo reproduced empty input
in the sandbox and succeeded under authorized subprocess permissions. The same composition tests
then passed. Temporary introspection was removed. Use subprocess-capable execution for these
checks; do not change production framing to compensate for the sandbox.

Next: pinned installed Gemini **engine** composition, then evaluate source RPC availability against
its remaining gates. The prior installed proof covers policy-factory/CLI composition, not the new
engine. Reuse the retained public fixture `/tmp/workshop-gemini-discovery-ajxzz_21`. A disposable
bundle of `packages/cli-runner/src/source-engine.ts` exists there as `source-engine.mjs` (817 KiB).
The public chat barrel pulls in CommonJS dependencies: its initial ESM import failed on dynamic
`require("events")`. Rebuilt with esbuild banner
`import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`
and the import now passes in `/tmp/workshop-gemini-engine-bundle-import-final.log`. This is probe
packaging, not a production dependency change. The main repository source remains authoritative.
No deployment, execution enablement, host installation, commit, push, merge or real vendor login.

The actual fresh-login/tmux proof was rerun after extraction and passed in
`/tmp/workshop-shared-engine-fresh-login-proof.log`, rc0: scoped Claude login → new shared source
engine consumption plus fresh Gemini login/publication, foreign-scope absence and complete
proof-owned cleanup. Gemini source execution was not dispatched by this proof.

## Handoff recovery

Restored this file after a documentation script accidentally wrote README text here. Replayed
34 recorded documentation-edit events in memory, excluding the erroneous overwrite; all target
edits and patch contexts recovered without errors. No recorded shell commands or unrelated file
mutations were executed. The recovered history includes the current lifecycle checks and fresh
login proof. Continue with pinned Gemini engine composition; all dispatch/deployment gates above
remain intact.
