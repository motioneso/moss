# Owned command prerequisite — A2b1

Date: 2026-10-17. Task: #3533; related #3529 and #3503.
Status: canonical contract candidate; independent document review and coordinator approval pending.
The agreed #3529 filename is retained; #3533 tracks this exact five-path prerequisite.
This document grants no implementation, control execution, production integration or runtime acceptance.

## Outcome and boundary

Provide one maintained, builtin-only command owner around the unchanged retained-original core.
A caller must distinguish the actual original's raw outcome from its separate close, captured-stream,
IPC and cleanup disposition. Successful orchestration must never turn a failed command into success.
Direct hermetic controls qualify this shared prerequisite alone: **A2B1_SHARED_COMMAND_PREREQUISITE**.
Production gate, provisioner and runner remain sealed. There is no product UI, module, model guidance,
chat behavior or app-map change; the ownership and completion decisions are deterministic.

## Exact source and existing seams

All citations below refer to immutable commit `bbe1e1256b2fc0300e25196f251ff0a72ad30dd3`,
tree `65ac9d706ffd8ba2491eb4b6dfdde835a74cf1a3`, relative to `~/Jarv1s`.
Graph discovery found provisioner functions but no original-child CJS nodes; exact Git objects establish
these facts. They describe source capabilities and gaps, not installed execution or observed leaks.

| Seam                                                                            | Verified source fact                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/uat-host/original-child.cjs:59–65`                                     | Private one-use reservations reject duplicate nonce/resource keys. These keys are not daemon resource custody.                                                                                          |
| `scripts/uat-host/original-child.cjs:67–97`                                     | Retains actual direct spawn and opaque capability; records error, exit, disconnect, stream and separate close events. Spawn forces shell=false/detached=false.                                          |
| `scripts/uat-host/original-child.cjs:99–116`                                    | Binds actual live identity before release; checks retained identity and nonce/resource before consuming the core reservation.                                                                           |
| `scripts/uat-host/original-child.cjs:118–125`                                   | Signals only the retained live original after PID/birth/PPID/boot checks; only TERM/KILL. No descendant or process-group guarantee.                                                                     |
| `scripts/uat-host/original-child.cjs:127–142`                                   | Snapshot preserves facts; completion rejects missing/late close, faults, open/error streams, connected IPC and terminal/close mismatch. Completion does not itself classify nonzero as success/failure. |
| `scripts/uat-host/original-child.cjs:77–90,144–160`                             | Existing limits: 65,536 bytes per allocated stream, 4,096-byte protocol frames, 64 messages/records. Overflow destroys the stream and preserves a permanent fault.                                      |
| `scripts/run-gate.sh:137–170`                                                   | Production owned foreground refuses before setup effects; control handoff is synthetic only.                                                                                                            |
| `scripts/run-gate.sh:398–425,588–596,673–710`                                   | Legacy start writes state and dispatches detached execution; internal run retains cleanup traps and invokes migrations then gate. An ACK cannot convert it to owned foreground.                         |
| `tests/uat/provisioner.ts:389–405,543–576`                                      | Capture/command helpers resolve at exit, before separate close; accumulated strings are unbounded and retry classification uses stderr available at exit.                                               |
| `tests/uat/provisioner.ts:678–729`                                              | Project selection, port/subnet probing and env preparation precede a separately owned per-attempt reservation. A port candidate is not reservation custody.                                             |
| `tests/uat/provisioned-run.ts:44–70`                                            | Runner uses npx Playwright exit/code fallback; signals schedule teardown and process exit. Separate ownership/close repair remains.                                                                     |
| `tests/uat/provisioner.ts:377–386`; `infra/docker-compose.prod.yml:242–254,452` | Seven helper-listed volumes omit the sports browser socket volume and its one-shot initializer.                                                                                                         |
| `tests/uat/compose-args.ts:9–20`                                                | Compose order is prod, override, then conditional native-sandbox. Selection and input bytes remain protected.                                                                                           |

Core blob: `c1b44aa1a5f201e80850e6c074543291b245de2d`.
Core SHA256: `aab9a8df031d709b3f7829a90c94336bce0055ef1cd8f803baf98345aeaac43f`.
Accepted public admission is a source-only prerequisite; its separate shared promotion remains outstanding.
If accepted source/core changes, refresh pins and mapped affected coverage before a new grant.

## Allowed future candidate

| New path                                                               | Responsibility                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/uat-host/command-owner.cjs`                                   | Caller orchestration using the unchanged core; one owner factory and one run entry.        |
| `scripts/uat-host/command-owner.test.cjs`                              | One direct builtin regression driver, with its own selected fixture mode in the same file. |
| `scripts/uat-host/COMMAND_OWNER.md`                                    | Supported command, contract, ordering, profiles, deadlines, errors, cleanup and limits.    |
| `docs/superpowers/specs/2026-10-17-3529-owned-command-prerequisite.md` | This canonical contract.                                                                   |
| `docs/superpowers/plans/2026-10-17-3529-owned-command-prerequisite.md` | Finite build/control/review and publication decisions.                                     |

Only the two canonical docs may be written at the current boundary. The other three paths require a
separate reviewed build grant. All five are new at the base. Every existing tracked blob must stay
identical: core, public adapters, gate, provisioner, lifecycle/options, package/lock/config and nine UATs.
Each future executable targets at most 300 physical lines, hard maximum 1,000 each. If it cannot fit,
stop with a precise split before adding a sixth path. No duplicate core, global spawn shim, new framework,
loader, helper file, Worker, server, dependency installation or policy bypass.

## Ownership interface and ordering

The future CJS export is `createCommandOwner(profile) -> CommandOwner`.
The only launch entry is `owner.run(request, observations) -> CommandRun`.
These are contract signatures, not implementation bodies:

| Contract                        | Decision                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`                       | Frozen exact executable/argv/cwd/env/stdio, source/dependency pins, expected live identity fields, absolute monotonic acceptance/cleanup deadlines. Validate and copy all mutable inputs before effects.                                                    |
| `request`                       | Contains a candidate profile and challenge. Compare every candidate field to the factory's already frozen trusted profile before reserve/spawn; differing file/argv/env/cwd/stdio/pins/deadlines refuse. Caller copies do not redefine the trusted profile. |
| `challenge`                     | Frozen exact 64-hex nonce/resource pair selected by trusted caller; uniquely reserved before each spawn. No caller-provided child, PID, status, capability or serialized resource receipt.                                                                  |
| `observations`                  | Optional trusted synchronous `onHeld(view)` and `onExit(view)` observations. Views are frozen snapshots, never child objects/capabilities or writable core state. Observer failure becomes a retained owner fault.                                          |
| `CommandRun.release(challenge)` | Guarded one-use release of the internally reserved command ticket and corresponding core reservation, after genuine live bind. Wrong or repeated challenge refuses without sending release.                                                                 |
| `CommandRun.cancel()`           | Records cancellation and initiates bounded cleanup of the same genuinely bound live original. No numeric-PID fallback.                                                                                                                                      |
| `CommandRun.snapshot()`         | Detached bounded evidence view; never ownership authority.                                                                                                                                                                                                  |
| `CommandRun.completion()`       | Synchronous completion inspection against the fixed acceptance deadline and unchanged core predicate; cannot manufacture completion.                                                                                                                        |
| `CommandRun.result`             | Bounded promise of raw facts, command classification and final disposition. No unbounded await of core.done.                                                                                                                                                |

The module privately retains core.spawnOriginal's exact return, command ticket and core reservation.
Handle methods validate their genuine receiver; forged/missing receivers cannot construct capability.
Reserve before spawn; attach actual event observations after core listeners; await a bounded fixture
READY, bind real identity while held, then notify onHeld. READY/forwarded IPC is data, never identity
or completion authority. A valid release consumes both tickets once through core.release.
Source pin failures, candidate profile drift, invalid profile/nonce and duplicate reservation refuse before launch.
Wrong release challenges refuse before release, retain ownership, and do not erase earlier faults.
Missing/bad live identity is RED; fast native commands without a reviewed barrier remain unsupported.

Captured profile: stdin ignored, stdout/stderr piped, IPC allocated. Inherited-stdout profile changes
only stdout to inherit; stderr remains captured. No invented stdout stream/EOF for inheritance.
Dispose unused stdin/control endpoints and IPC explicitly; require actual EOF/close only where the
unchanged core requires it. No extra unbounded accumulator; preserve existing stream/frame caps.

## Results, faults and cleanup

Retain raw spawn error, terminal code/signal/time, separate close code/signal/time, captured FD byte
counts/data/end/close/error, IPC disconnect state, first failure, subsequent faults and pending ownership.
Private evidence may retain genuine identities/profile pins; public docs/receipts exclude credentials,
arbitrary env/output, run identities and machine paths. Data from a child never attests parent state.

Command classification is separate from a regression driver's expected-outcome label. Raw 23/null and
null/SIGTERM remain command failures after complete cleanup. ENOENT preserves the real error,
terminal=null and no invented PID/exit; a real failed-spawn close may still have its own code.
Core completion can describe disposed spawn failure, but cannot turn it into command success.
Overflow retains its fault and at most 64 KiB data (possibly less because chunks are discarded at cap);
completion must reject. Record failure disposition via snapshot and actual close/done evidence without
requiring successful EOF on a destroyed stream. Never truncate away a fault or relax core predicates.

Use one original monotonic clock. Acceptance expires irrevocably at its original deadline; remaining
cleanup reserve does not renew it. Failure/rejected promise is not cleanup. Begin TERM through
core.signal only for the same bound live original; after at most 250 ms, KILL it only if still genuinely
live and identity-owned. After terminal, dispose owned endpoints; never signal a dead/reused PID,
kill a parent above a live child, or operate on process groups. Unknown terminal/FD state remains RED
with exact pending ownership, even if bounded waiting ends. Preserve the first fault through finalization.

## Finite hermetic acceptance

Exactly twelve serial builtin controls are specified in the paired plan; no retries and freeze the
remaining cases UNRUN at first unexpected failure. Driver plus at most one direct fixture: maximum
two simultaneous workload processes, maximum twelve originals including driver. Eleven spawn attempts
include ENOENT, which normally yields no genuine fixture; the guard case launches none.
No pnpm/tsx/esbuild, native/browser/Docker/provider/DB/network/port/server, helper descendant,
explicit Worker or process-group claim. These fixtures do not qualify native descendants or platform absence.

Inclusive campaign maximum is 120 s, including driver launch/setup, all evidence/report/manifest writes
and final cleanup. Each case uses at most 8 s (therefore below the 10 s hard case ceiling), work at most
5 s, with cleanup in the same case. Reserve 8 s before a next launch plus a distinct 12 s finalization
reserve; no deadline resets. Twelve case slots use at most 96 s, leaving 24 s for setup/finalization.
Freeze tested bytes and Node/core/source pins before controls. The retained driver boundary must
include final artifact sealing, actual raw terminal and separate close; do not predate post-seal proof.
Missing any required actual witness is a blocker, never synthesized credit.

## Remainders and publication

A2b2 needs separately bounded proposals for foreground gate/pre-effect gate-DB custody; actual
provisioner command callers and typed bridge if needed; reservation before every UAT attempt/retry;
runner exit/close/cancellation; and same-daemon cleanup/resource proof. Preserve default argv/env/stdio,
error classes/retries and ordered Compose. Reconcile accepted collector changes rather than overwrite
from this older base, and retain the provisioner's 1,000-line ceiling (984 lines at this base).
Inventory gate DB plus selected containers/ops/socket-init/network/image and all eight volumes,
including sports-browser-socket. Preserve failure evidence and credential teardown ordering, partial
creation, exact created IDs and uncertain ownership. Shared/preexisting daemon state is not deletion scope.

B vendor/native owners, C native browser qualification and D accepted integration/offline/collector
bindings remain separate. First native run-uat stays held/cancel-only and production foreground refused.
Public nine argv and counts 3/4/1; per-spec budgets 300/300/600/720/720/900/720/600/600 s;
monotonic start 240 s, UAT 1,200 s and gate-wait 1,800 s origins including cleanup/finalization stay fixed.
All nine actual UAT remain UNRUN/NONLAUNCHABLE; no runtime, release or Stage4 acceptance.

Preserve source histories, local branches/worktrees, all failed and accepted private packets and handoff
state. Reuse only evidence with exact input/coverage correspondence; no blanket A1/A2a rerun for these
new unused-by-production files. Map affected evidence for later common changes. Private orchestration
promotion is separately tracked, not implicitly completed by this module.

Before reuse, shared source/regression/docs must pass fresh independent Standards and Spec review,
coordinator acceptance and normal reviewed repository publication. Document reproducible commands,
ownership/cleanup and limits in COMMAND_OWNER.md. Commit canonical docs first; normal spec/plan
publication precedes source-lane activation, with a separate explicit build/control grant. A locally clean
commit or recovery bundle is neither pushed, reviewed, merged nor an off-machine backup. Track each
state separately. This docs-only candidate stops after commit/hash delivery for independent review.
