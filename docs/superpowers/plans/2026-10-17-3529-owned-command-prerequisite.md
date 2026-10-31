# Owned command prerequisite — A2b1 plan

Date: 2026-10-17. Task #3533; related #3529 and #3503; agreed #3529 path retained.
Spec: `docs/superpowers/specs/2026-10-17-3529-owned-command-prerequisite.md`.
Status: document candidate pending independent review/coordinator approval; no source or execution grant.

## Decision and verified seams

Build one small shared owner around existing original-child.cjs; keep the regression fixture inside its
single test entry. This removes repeated private completion orchestration without replacing the core.
A production adapter first would reach gate helpers, resource reservations and vendor/native ownership
before their separate contracts are ready. Keeping all logic private would preserve local evidence but
fail durable shared reuse. Therefore qualify the unused shared prerequisite first and keep adapters sealed.

Base commit `bbe1e1256b2fc0300e25196f251ff0a72ad30dd3`,
tree `65ac9d706ffd8ba2491eb4b6dfdde835a74cf1a3`, relative to `~/Jarv1s`.
The spec's seam table is normative; these are the capabilities this plan actually needs:

| Assumption                                          | Current exact proof / boundary                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Real original capability and reserved release exist | `scripts/uat-host/original-child.cjs:59–116`; no reported PID or fabricated child accepted.         |
| Raw terminal differs from close/FD completion       | `scripts/uat-host/original-child.cjs:73–96,132–142`; preserve error/nonzero/signal separately.      |
| Bounded capture and direct-original cleanup exist   | `scripts/uat-host/original-child.cjs:77–90,118–125`; unchanged limits and identity checks.          |
| Source/identity verification exists                 | `scripts/uat-host/original-child.cjs:28–52,99–105`; wrapper must provide exact frozen expectations. |
| Production activation remains unavailable           | `scripts/run-gate.sh:137–170`; synthetic ACK cannot authorize real setup.                           |
| Caller repairs remain independent                   | `tests/uat/provisioner.ts:389–405,543–576,678–729`; `tests/uat/provisioned-run.ts:44–70`.           |
| Resource inventory remains incomplete               | `tests/uat/provisioner.ts:377–386`; `infra/docker-compose.prod.yml:242–254,452`.                    |

Graph discovery found provisioner symbols; no CJS core nodes were available. Immutable Git reads supplied
exact cited source. No assumed production capability is promoted by a fixture. Unsupported fast-native
identity/barrier qualification belongs to the later adapter owner/coordinator, not an implicit implementation step.

## Phase 0 — canonical documents only (current authorization)

1. Authenticate the named owner/route and wait for coordinator START_AUTHENTICATED before repo writes.
2. Create only the spec and this plan, both new at the base. Preserve every preexisting tracked blob.
3. Check contract coverage, exact citations, whitespace, privacy and the two-path diff using text/Git only.
4. Verify no other staged path; stage/commit with both explicit doc paths. Record exact commit/tree,
   parent/base, changed paths, hashes, line counts and clean state in the authorized private report.
5. Deliver compact report pointer and commit to the freshly resolved coordinator; stop for independent
   Standards+Spec document review. This is not source approval, a PR, a push or reusable acceptance.

No installs, source changes, syntax/parser checks, tests, probes, formatter/lint/types, runtime, push, PR,
merge, helpers or subagents are authorized now. No product surface exists, so UI/e2e/app-map additions
would expand scope. All behavioral controls below are future obligations, not commands executed here.

## Phase 1 — future exact five-path candidate, conditional on new grant

Only after approved, committed and normally published canonical spec/plan and task linkage, obtain a
named owner/worktree/path build grant at the accepted exact source. A2a public-admission source acceptance
is a prerequisite, not broad A2b/runtime acceptance. Refresh pins/coverage if source/core changed.

Add exactly `scripts/uat-host/command-owner.cjs`, `scripts/uat-host/command-owner.test.cjs` and
`scripts/uat-host/COMMAND_OWNER.md` alongside these two docs. All other tracked blobs stay identical.
Each executable targets at most 300 physical lines, hard maximum 1,000; stop for a precise split if it
cannot fit. Do not add a sixth path, dependency, separate fixture or copied core implementation.

Use the spec's `createCommandOwner(profile)`, `owner.run(request, observations)` and guarded
CommandRun lifecycle signatures. Do not export core capabilities, child construction or state mutation.
The wrapper ticket is created before spawn, held privately, and consumed once with its corresponding
core reservation at release. It is not a serialized Docker/project/port/subnet receipt.

Required implementation decisions:

- Freeze/copy exact profile inputs; verify selected source/dependency bytes and mode before effects.
  Use unchanged core `reserve/spawnOriginal/bind/release/signal/completion/snapshot/done` methods.
  The request carries a candidate profile plus challenge; compare all candidate fields against the
  factory's frozen trusted profile before reservation/spawn, so guard injections cannot redefine it.
- READY is bounded ordinary IPC containing type/nonce/resource; bind actual proc identity while held.
  CommandRun release compares the exact challenge; its genuine receiver is mandatory. Repeated release
  or forged receiver refuses before sending anything. No user-supplied capability or PID fallback.
- Install onHeld after bind and onExit on the actual child after core exit listener registration. onExit
  can synchronously inspect completion when terminal exists but close has not arrived. Snapshots and
  observer views cannot mutate authority. Hook exceptions become owner faults, never ignored success.
- Profiles use `[ignore, pipe, pipe, ipc]`, or `[ignore, inherit, pipe, ipc]` for inherited stdout.
  No extra control FD is needed. Close any allocated unused input/control endpoint explicitly and
  disconnect IPC at the selected fixture's completion; preserve inherited stdout as uncaptured.
- Keep one capture store: core's at-most-65,536-byte stream data, 4,096-byte frames, 64 records.
  No unbounded owner log/JSON/second accumulator. A negative overflow keeps the permanent fault and
  actual destroyed-stream/close disposition; never require successful EOF on the destroyed stream.
- Return raw error/terminal/close/stream/IPC facts, first fault and later faults, pending ownership and
  separate command classification. Expected regression outcome is an additional label. Nonzero 23,
  SIGTERM, timeout and overflow remain failed commands even if their negative controls pass.
- Bound every wait, including core.done; failure finalization uses actual snapshots/events. A rejected
  promise never means cleanup. Dispose owned endpoints without overwriting unresolved ownership.

### Exact fixture and evidence contract before execution

The direct entry is `/usr/bin/node scripts/uat-host/command-owner.test.cjs` from the frozen repository
root. Pin exact Node realpath/version/hash/mode, source commit/tree, owner/test/core bytes and modes,
argv, cwd and minimal env in a private immutable manifest before launch. This is a future command,
not permission to execute now. No inherited NODE_OPTIONS, PATH aliases, provider, browser or DB settings.
Use exact Node and test absolute paths for fixture argv `[testPath, --fixture, caseId]`; no shell/loader.
A minimal frozen env may carry only LANG=C, TZ=UTC and the case's exact nonce/resource challenge.
Node's own IPC channel variables are accounted for by the core environment normalization.

The test file contains both driver and one selected builtin fixture. It uses only builtin IPC, pipes,
timers and fixed output; no imports of TS provisioning, extra processes, Workers, sockets or servers.
Fixture modes await READY/bind/release as appropriate. Fixed output: case 1 stdout `ok\n`; case 2
stderr `failure23\n`; case 8 exactly 65,537 ASCII `x` bytes; case 12 stdout `inherited\n` and stderr
`captured\n`. Other fixtures emit only bounded protocol/fixed observations needed by their case.
The ENOENT case selects one exact absent executable in the private packet, deliberately outside the
executable pin set; pin the driver/core/test and absence expectation and preserve actual spawn error.

Use an explicit private 0700 packet, clear SGID before preflight, artifacts 0600. Evidence schema:
case ID; source/profile/Node pins; original clock origin and deadlines; phase assertion times; genuine
original identity if any; raw error/terminal/close; each allocated FD's bytes/data/end/close/error;
IPC disposition; completion rejection/acceptance; command classification; expected label; first and
later faults; cleanup actions/times; pending ownership; final result; remaining UNRUN IDs.
Keep raw command facts distinct from driver raw exit and expected-outcome labels. Bound serialization;
record an evidence-write failure as RED, retain prior facts and pending state. No credentials, arbitrary
command env/output or machine identities in public docs. No post-seal time claimed before sealing.

### Fixed clocks, process counts and cleanup

The retained outer driver boundary fixes the monotonic campaign origin before driver launch and ends
only after report/manifest/evidence sealing, genuine driver terminal and separate close/FD disposition.
The future execution grant must pin that boundary and the clock mapping into driver observations;
missing driver custody is a blocker, not permission to time only fixture work.

Campaign maximum 120 s inclusive; twelve serial case slots at most 8 s each (hard case ceiling 10 s).
Acceptance/work deadline is case origin +5 s; cleanup deadline is the same origin +8 s, both capped by
the campaign deadline. No clock resets or late-success forgiveness. Reserve an entire 8 s case and a
distinct 12 s finalization allowance before the next launch; at most 12 s setup plus 96 s cases leaves
12 s finalization. Freeze remaining UNRUN if time is insufficient, even with no earlier assertion failure.

Begin cleanup immediately on failure or work timeout: TERM via retained capability while genuinely
bound/live, then KILL after at most 250 ms only if still live/identity-owned. Require terminal/close/FD
facts by the original case cleanup deadline. After terminal, dispose endpoints only; retain uncertainty
as RED. No numeric-PID receipt signal, group signal, parent-first destruction or unbounded done wait.

At most two simultaneous workload processes: driver and one direct fixture. At most twelve originals
including driver. Cases other than guard matrix make eleven spawn attempts including ENOENT;
ENOENT normally creates no genuine original. No setup/verification subprocesses inside this campaign.
No retries; first unexpected result freezes all later cases UNRUN. Expected negative results below do
not erase raw failures. Source/identity/capture/ticket/deadline/completion/persistence faults stay explicit.

### Twelve controls — exact obligations

| #   | Behavior and required genuine observation                                                                                                                                                                                                                  | Broken behavior caught                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Held direct original; release once; stdout `ok\n`; raw 0/null, matching separate close, captured EOF and IPC disconnect.                                                                                                                                   | Exit-only or ACK-only success.                                                          |
| 2   | Captured stderr `failure23\n`; raw 23/null, matching close and complete FD disposition; label expected command failure.                                                                                                                                    | Nonzero normalized to driver 0 or late stderr discarded.                                |
| 3   | Released direct builtin self-SIGTERM; raw null/SIGTERM and matching close/FD disposition.                                                                                                                                                                  | Cooked shell/tsx status replacing actual signal.                                        |
| 4   | READY and actual bind prove held live original; cancellation uses retained capability only; real terminal/close/FD evidence.                                                                                                                               | Receipt-PID cancellation or promise rejection mistaken for cleanup.                     |
| 5   | Same original stays held with stdout open; synchronous completion rejects before one release, then actual closure. No descendant.                                                                                                                          | Treating live/open output as completed or inventing a holder.                           |
| 6   | Exact absent executable produces real ENOENT; no invented PID or terminal; record real failed-spawn close and pipe disposal.                                                                                                                               | Fabricated child exit or error discarded.                                               |
| 7   | In actual exit callback after core listener: terminal exists, close absent, completion rejects; then observe actual later close/EOF. Missed interval freezes RED.                                                                                          | Exit-before-close success or injected interval witness.                                 |
| 8   | Genuine fixture writes exactly 65,537 ASCII bytes on captured stdout; retained data <=64 KiB, overflow fault, bounded actual cleanup; core completion still rejects.                                                                                       | Truncation as success, cap expansion or invented EOF on destroyed stream.               |
| 9   | Bound live fixture held beyond original +5 s acceptance deadline; timeout preserved; terminal/FD cleanup by +8 s; late completion still rejects.                                                                                                           | Clock reset, acceptance extended by cleanup or timeout without disposition.             |
| 10  | Guard-only invalid/missing profile/challenge/source pins and forged/missing handle receiver refuse without spawn/release. A handle already consumed in an earlier case refuses a second release; wrong file/argv/env/cwd/nonce are covered. No new launch. | Caller-fabricated authority, mutable profile drift, challenge mismatch or ticket reuse. |
| 11  | Genuine live child sends a bounded lookalike completion frame before terminal; completion remains unavailable until genuine original/close/FD facts.                                                                                                       | Forwarded IPC promoted to authority.                                                    |
| 12  | Inherited stdout profile emits fixed stdout; no captured stdout entry or invented EOF; real stderr capture, terminal/close and IPC disposition.                                                                                                            | False EOF or capture requirement for inherited stdout.                                  |

Case 10 retains the earlier opaque handle in the same controller; consumed-ticket guards cannot
create a capability. Profile drift subcases use copies of the previously frozen expected profile and
must refuse against its trusted source/profile expectations; label these guard injections explicitly.
They prove refusal, not OS absence. Exact source pin mismatch subcases require no target evaluation.

### Finite future checks and phase acceptance

After a separate exact grant, freeze candidate bytes before controls. At most one invocation each of
the two explicit CJS syntax checks may be granted: `/usr/bin/node --check scripts/uat-host/command-owner.cjs`
and `/usr/bin/node --check scripts/uat-host/command-owner.test.cjs`, expected exit 0. Any scoped
format/lint invocation must name exact local tool pins and these five paths in that grant; no install,
package-wide script, typecheck or full gate is implied. Current authorization permits none of them.

The hermetic end-to-end phase check is the twelve-case direct entry above, expected driver exit 0
only if all expected comparisons and finalization pass. Inner nonzero/signal statuses stay raw.
Commands are unpiped; capture actual status and bounded output separately. No Playwright/live UI
phase is claimed. Record actual results, never mark written/unrun controls passing.

Verify final exact diff lists only the five allowed new paths, every base tracked blob remains identical,
line/mode limits hold, and tested bytes equal final Git bytes plus pinned core/Node. Preserve the frozen
failed packet if any. A new independent reviewer checks Standards and Spec against that exact candidate
and packet. Only coordinator acceptance may label A2B1_SHARED_COMMAND_PREREQUISITE accepted.

**Kill gate after this phase, owned by the coordinator:** stop adapter progression if any required
control lacks a genuine observation, close/FD state is unresolved at its bound, driver custody/final
writes exceed 120 s, process/line/path caps cannot hold, or correctness requires changing the sealed
core. Keep the failure and UNRUN cases; request a precise split/core amendment and mapped review.
Do not add retries, predicates, framework paths or begin phase 2 to conceal failure.

## Remainders, affected coverage and preservation

No detailed phase 2 implementation is authorized. Later separately reviewed slices own foreground
gate/reservation before any gate DB effect; provisioner callers and a properly leased typed bridge;
reservation before every attempt/retry; runner cancellation/close; same-daemon resource/cleanup proof.
Reconcile accepted collector source and provisioner 984-line base with its <=1,000 cap. Preserve all
default argv/env/stdio/retry/error semantics and optional seams. Inventory the sports socket and init,
other seven volumes, selected network/image/containers/ops and gate DB, including partial/uncertain IDs.
B vendor/native owners, C native-browser membership and D integration remain separately gated.
Host original closure does not certify Docker/native absence or repair any sealed production caller.
The public nine argv, counts 3/4/1, spec budgets 300/300/600/720/720/900/720/600/600 s and monotonic
start 240/UAT 1,200/gate-wait 1,800 s origins including finalization remain fixed. Actual nine UAT are
UNRUN/NONLAUNCHABLE; first-native remains held/cancel-only; no runtime/release/Stage4 acceptance.

Reuse applicable unchanged A1/A2a exact evidence rather than blanket reruns. Map changed mechanisms
to affected coverage. Later provisioner work retains default-no-opt-in effects, fresh retry/partial
creation, source/daemon/port/Compose drift, credential-failure teardown, failure aggregation/env-last,
residual/network identity and original exit-versus-close/cp/up ordering coverage. Exit-only test fakes
need an explicitly reviewed close-event update; no invented closure and no TS provisioner import here.

Maintain the rulings ledger in the authorized private report: reviewed facts/decisions, exact citations,
resolved/invalid findings and remaining gaps, even if later implementation changes. Preserve all
accepted/failed packets, source/branches/worktrees and handoff state. Do not sweep unmerged work.
Track private A1/A2a orchestration promotion explicitly. Independent final review checks durable
shared code/tests/docs, reproducible supported command, ownership/cleanup and limits, exact evidence
pointers and local-only remainder. Before claiming reusable acceptance, follow normal reviewed shared
publication. Report saved locally, recovery-backed, pushed, reviewed and merged separately; a clean
commit/recovery bundle is not off-machine backup or merge proof. Current delivery ends at local
canonical-doc commit/hash report and STOP for independent review, with no push or implementation.
