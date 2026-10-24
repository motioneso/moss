# Computer standalone gateway packaging evidence

Part of #3618/#3619/#3616/#3577. Base `0dc882dc3a8282719cd4cb3118fe21e5146e175e` (merged
PR#3636); accepted source `31983368533b2115f0394d22e925985ba0118f26`. The
[machine receipt](2026-10-24-gateway-packaging.json) records exact source/control/output hashes,
command exits, intended removed-protection failures and immutable independent review rounds.
The [plan](../../superpowers/plans/2026-10-24-moss-computer-gateway-packaging.md) and
[next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-admission-watchdog.md) preserve
the independent review → fix → exact checks/evidence/CI → merge → verified fresh isolated successor
chain until actual owner delivery. No production deployment.

This is **internal opt-in packaging**, not an accepted image or installed Computer. Normal API
boot, host specifications and unavailableAdmission remain unchanged. No image hash is configured,
product app-map capability added or deployment requirement introduced. Independently supervised
admission/watchdog, image qualification/resource fit, actual TigerVNC, fixed lifecycle/closure and
ordinary owner HTTPS/WSS/chat acceptance remain open. Keep parent/product issues open.

## Implemented boundary

`pnpm build:computer-gateway <new-output-directory>` invokes locked esbuild0.25.12 and emits a
single CJS Node24-target bundle plus Dockerfile, .dockerignore and build.json in an exclusive0700
context. It compiles out optional ws native acceleration and rejects any nonbuiltin output import.
There is no runtime node_modules, loader or package-manager step. Compilation permits only the
fixed esbuild compiler child; the CLI neither invokes Docker nor qualifies an image.

The onLoad plugin captures the exact byte buffers given to esbuild. Build tooling/templates,
root/API/lock and relevant vendor package metadata are captured separately before compilation.
All captured inputs are reread before publication and changed/missing inputs reject. Fixed empty
tsconfigRaw prevents automatic repository config discovery. Receipt hashes distinguish compiler
sources from build controls; identical inputs/toolchain produce identical context bytes. Existing
output directories and symlinks reject without altering retained contents. Publication failure
removes only owned output files and its empty directory.

The copied recipe pins a linux/amd64 Node24 slim manifest. Registry metadata indicates Node24.22.1;
this is base metadata, not a built gateway identity. The recipe copies a root-owned0444 bundle,
uses UID/GID1000, an absolute exec-form Node entrypoint, a64MiB V8 heap setting, fixed default
/config/gateway.json and SIGTERM. It has no RUN/install, EXPOSE, VOLUME or readiness claim. V8 heap
is not a whole-process memory limit. Future runtime host specs still enforce network-none,
0.5CPU/128MiB/32PIDs, RO root and private mounts; this slice does not exercise them.

Observed CLI output: gateway.cjs301728bytes, SHA-256
`62fa2f2dcea4b06f81f1ae291647d69f73be6cc6509f7ab92bcede32627c617f`.
The receipt includes58 compiler sources and10 build controls. The minimal Docker context allows
only the recipe and bundle through .dockerignore; the provenance receipt is not copied into the
image. No image ID is invented or accepted.

## Independent review ledger

All reviewers were independent/read-only, authored no fixes and pinned Git source while controls
mutated working build.ts. Raw immutable reports remain private, with SHA-256 hashes in JSON.
Every round and the initial failed check remain retained; no disputed blockers remain.

- Plan R1 blocked an inaccurate no-subprocess claim and post-build-only provenance. Both findings
  were accepted: permit the locked esbuild compiler child, capture actual compiler buffers and
  separate controls, reject changed inputs before publication, and test that boundary. Explicit
  tsconfigRaw prevents unrecorded config discovery. Plan R2 accepted exact20109810e before code.
- Source R1 on45ca4b5: Spec and security passed. Standards blocked seven test inline type-import
  annotations matching scoped ESLint exit1. The accepted correction introduces erased namespace
  type imports; no assertion, mock or runtime behavior changed.
- Source R2 on319833685: Standards, Spec and security accepted the exact corrected source. Final
  required checks, exact evidence acceptance and green CI remain distinct gates.

## Restored verification and observed negative controls

The final four-file30-test suite passes, including six packaging tests and existing process,
channel and guest-WebSocket regressions. The actual emitted bundle runs as a Node child from the
private output cwd with no tsx, NODE_OPTIONS or NODE_PATH. It proves pixel readback, watcher input
exclusion, takeover/key-down, pressed-key release, delayed matching Fence return with stable
control, intentional close, active auth-push pause/closure and TERM endpoint/child cleanup.

Synthetic fresh session lookup and the rfb2 library Fence-extension fixture are disclosed stand-ins.
Host Node22.22.2 execution does not qualify Node24 container behavior, TigerVNC or128MiB fit.
Root/tests TypeScript, scoped lint/Prettier, file-size, whitespace and CLI exits/log hashes are in
JSON. The final root TypeScript check passed against exact source319833685. The first root check
failed only because the scoped install omitted the worker’s declared pino dependency. An already
running repeat was deliberately stopped after that diagnosis; both receipts are retained. A
frozen offline install added the worker dependency set without manifest/lock changes, before
restarting the final exact-source check.

Each control temporarily removed one protection and exited1 at its intended assertion. The
original build.ts hash was restored after every attempt; final behavior checks pass on restored
committed source. No compiler error, timeout or unrelated failure counts as accepted evidence.

| Removed protection              | Intended observed failure                                  |
| ------------------------------- | ---------------------------------------------------------- |
| Builtin-only dependency guard   | Nonbuiltin-external rejection unexpectedly resolved        |
| Captured-input stability reread | Changed-input rejection unexpectedly resolved              |
| Compiled optional ws flags      | Positive closed-context build rejected at dependency guard |

JSON records original/mutant/restored hashes, exact commands, log hashes and mutation definitions.
The external control uses a real esbuild result with one injected nonbuiltin external; the
stability control simulates a changed final filesystem read after real compilation. Neither
changes production entry selection or writes tracked input fixtures. Removing the ws flags
retains optional accelerator runtime dependencies and fails the intended closed-dependency guard.

## Remaining gates and resources

Independent exact final evidence acceptance and required green CI precede merge. After merge,
verify a fresh isolated admission/watchdog successor with actual session/handoff-read execution.
The next dispatch preserves exact committed packet review, healthy Moss, fresh RAM/root>=8GiB/
data>=30GiB and an independent alive watchdog with first complete sample before image/runtime
work; <=1800s monotonic deadline, <=90s heartbeat, nominal5s sampling and exact identity/lock/
stop-intent/closure. No always-successful admission or raw RFB bypass.

Only temporary private Unix/auth/ws/rfb2 fixtures, esbuild compiler children and emitted/source
executable test children were started. No Docker/image/real guest/DB/browser/TCP listener/devport
or production resource was mutated. Owned fixture children/sockets closed. Accepted r21 persistence
was reused without requalification; r12 connection/r18 clipboard causes remain unknown. Logs/live
state remain outside ~/Jarv1s. Actual owner integration remains unfinished.
