# Computer prelaunch runner contract

Plan, with a small code slice that no production path calls. No Computer runtime, image, Docker,
deployment or production operation. `unavailableAdmission` stays the only admission. Parents #3577,
#3616, #3617, #3618 and #3619 stay open. Settles open items 1, 2 and 3 of the
[prelaunch handover handoff](../handoffs/2026-10-25-moss-computer-prelaunch-handover.md).

## Amendments to the accepted handover plan

This plan amends the [handover plan](2026-10-24-moss-computer-prelaunch-handover.md) in one place.

- Line 106 says the `hold` watchdog's stdin must be the runner's heartbeat pipe. That is superseded.
  Before launch there is no runner and no heartbeat. `hold` takes stdin from `/dev/null` and the
  loader asserts it (section 4).
- Lines 147-150 say `hold` acknowledges and a test shows it survives past 5s. That is superseded.
  `hold` acknowledges by writing one byte on descriptor 3, and the launcher accepts that byte, not
  survival past 5s (section 4).

Everything else in the handover plan stands. The sampler keeps stdio pipe, pipe, ignore, reads one
bounded stdin record and returns its sample on stdout, as `collect` does today
(computer-watchdog.ts:39-71). Limits stay: 1800s run, 90s heartbeat, 5s bootstrap bound, 5s sample
age, gap under 10s.

## Problem

The handover plan has a root launcher spawn a lifetime-free `hold` watchdog and a one-shot
`prelaunch` sampler before any container exists. The pinned loader cannot load either today.

| Source                                               | Fact                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-watchdog/trust.ts:57-72`           | `parseSupervisorConfiguration` requires an exact key set that includes `runner`, a pinned live process identity.                                   |
| `scripts/computer-watchdog/trust.ts:331-334`         | The loader requires the runner's stdout and stderr to be `/dev/null`, reads the runner from `/proc`, and for non-collectors checks the heartbeat.  |
| `scripts/computer-watchdog.ts:22,33-37`              | Only `observe`, `fence`, `manage` and `collect` exist (line 22). `hold` and `prelaunch` have no entry. Lines 33-37 gate modes on lifetime.         |
| `scripts/computer-watchdog.ts:12-17,78-81`           | The 5s startup timer starts at module load. Only the manage and supervise paths clear it through `acknowledgeStartup()`.                           |
| `scripts/computer-watchdog.ts:20,30`, `trust.ts:272` | Node path is `process.execPath` (trust.ts:272), artifact path is `process.argv[1]` and config path is `argv[2]`. Only the artifact hash is pinned. |

Before launch no runner exists. A runner is the process that later starts the pair, so the
prelaunch phase has no process to pin.

## Fork: what does the loader check before launch

| Option                    | Mechanism                                                                                                    | Cost                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| A. Launcher is the runner | The launcher puts its own identity in the config. Loader unchanged.                                          | The check proves nothing independent, because the checked process is the one that wrote the file.          |
| B. Stub runner process    | The launcher spawns a do-nothing process and pins that.                                                      | One more process to start, pin and clean up. It proves nothing either.                                     |
| C. New runner-less kind   | A `prelaunch` configuration with no `runner`, no lifetime, no capture, loaded by a separate loader function. | Edits security-critical loader code. The runner checks are skipped only for this kind, in a separate path. |

Recommendation: C. The pinned runner ties a watchdog to a live parent. Prelaunch has no such
parent, so A and B would pin a process that vouches for itself. C stays safe only if the existing
loader's runner checks (trust.ts:331-334) are untouched and the new loader is a separate function
with its own types. Security review of the plan found C safe on those terms.

## Contract (option C)

### 1. Configuration kind

- The prelaunch configuration carries the existing keys minus `runner`, `lifetime` and `capture`,
  plus a literal `kind: "prelaunch"`. Exact key set, same private-file rules as today (mode 0600,
  parent 0700, size cap 16384, root-owned trusted chain).
- `parseSupervisorConfiguration` keeps its exact key set and rejects `kind` (trust.ts:57-72, exact
  match). A new `parsePrelaunchConfiguration` is exact on its own set and rejects `runner`,
  `lifetime` and `capture`. Each parser refuses the other's shape on keys alone.
- The configuration pins the run ID, artifact hash and boot ID, as today (trust.ts:27-36).
- The capture checks (trust.ts:312-325) do not apply. `capture` requires `lifetime`
  (trust.ts:271), and the prelaunch kind has neither, so there is no capture root to protect.

### 2. Loader and types

- The checks that do not depend on a runner or capture move into one internal function, unchanged
  in order and content: runtime assertion, config file trust, node and artifact trust, artifact
  hash, namespace anchors, host roots, Docker socket, data, Docker data and monitor roots and their
  overlap rules (trust.ts:263-311), and the identity marker (trust.ts:326-330).
- That function takes only the common fields (`host`, `data`, `dockerData`, `monitor`, `readyUrl`,
  `artifactSha256`, `bootId`, `namespaces`, `runId`) and returns a common deployment.
  `assertNamespaceAnchors` is retyped to take only `bootId` and `namespaces`.
- `loadSupervisorDeployment` calls it, then runs its capture and runner checks as now. Its result
  type, `SupervisorDeployment`, is unchanged.
- New `loadPrelaunchDeployment(configPath, artifactPath, mode)` calls it and nothing runner
  related. It returns a distinct `PrelaunchDeployment` type with no `runner`. That type is not
  assignable to `SupervisorDeployment`, so it cannot reach `revalidateDeployment`
  (trust.ts:349-364) or `observeComputer`, both of which read a runner. The compiler enforces this.
- Mode argument. `hold` requires its own stdin and stdout and stderr to be `/dev/null`. The
  `prelaunch` sampler is treated as a collector, like `collect`: it reads a stdin pipe and writes
  its record to a stdout pipe, so it skips the own-output check, and `assertSupervisorRuntime`
  gets the collector flag for it.
- Existing loader tests run unchanged. A new test removes a shared check and shows both loaders
  refuse, so the extraction cannot silently drop a check.

### 3. Node, artifact and config paths

- Node is `process.execPath` (trust.ts:272), artifact is `argv[1]` and config is `argv[2]`. All are
  checked by `assertTrustedPath` (root-owned chain, no group or world write, single-link regular
  file). The config file is also mode 0600 in a 0700 directory.
- The launcher chooses the three paths for the children it spawns, from its own trusted location,
  never from a request, the host config or the environment. The host config has no path fields
  (`parseHostConfig`, config.ts) and gets none.
- Basis of the claim. These paths are safe from non-root actors only because the whole chain is
  root-owned and not group or world writable. The artifact is also bound by the hash in the
  config. The config itself and the node binary have no content hash. This plan relies on the
  trusted-chain rule for those two and claims nothing stronger. A hash the artifact checks about
  itself only constrains a copy of itself that is already running.
- Verification of the launcher itself, and the exact installed locations, belong to installed
  delivery (item 5 of the handoff). This plan fixes only the derivation rule.

### 4. `hold` mode

- `hold <config>` loads a prelaunch deployment in `hold` mode, acknowledges startup, and idles.
- Descriptors. stdin, stdout and stderr are `/dev/null`, asserted by the loader through
  `readlink /proc/self/fd/N`. A terminal on stdin refuses. Descriptor 3 is a pipe write end held
  by the launcher. The loader asserts that and `hold` writes a single byte to it.
- Acknowledgement. `acknowledgeStartup()` runs once the load has succeeded and `hold` has read its
  own identity with `processIdentity(process.pid)`. It then writes the byte on descriptor 3. The
  launcher counts the hold as acknowledged only when it has read that byte within 7s of spawn (the child's 5s deadline plus 2s for process start and the pipe read) and
  the hold's identity (pid, start ticks, group) is unchanged. A hold that is alive but has not
  written the byte is refused and killed. This is a positive signal, so the 5s deadline timing
  inside the child cannot be misread, and no fixed wait is added to each enable.
- Pre-ack failure. A load that takes 5s or more refuses, as today. Any refusal exits 2.
- Separation. The launcher spawns `hold` detached so it has its own process group. `hold` reads
  its parent with `process.ppid` and `processIdentity`, and refuses if its own pid or its group
  equals the parent's. This compares against the actual parent, because the prelaunch
  configuration pins no runner. The check is a separation guard and makes no trust claim about the
  parent.
- Parent loss. `hold` records its parent pid at start and exits 0 when `process.ppid` changes, checked every 1s on the injected clock. It
  also exits 0 at 1800s of monotonic age, the existing run limit. Item 4 of the handoff may
  shorten that. An orphan is therefore bounded by the next parent check, not by the full cap.
- One per run. The launcher refuses to spawn a second hold for the same run while one is live.
  That rule is built with the launcher (item 5). It is named here so the process count stays bounded.
- No revalidation. `hold` loads once. Its liveness proves only that the process exists. It must
  never be treated as proof that the config or artifact is still intact. The `prelaunch` sampler
  loads the deployment fresh each time and re-reads the hold's identity, and that is the check.

### 5. `prelaunch` mode (config rule only)

- `prelaunch` accepts a prelaunch configuration only. It reads one bounded stdin record and writes
  one record on stdout, as `collect` does. The sample body, nonce and output rules are those of
  the handover plan. This slice defines the accepted kind and loader mode, and does not build it.

## Mode and kind matrix

| Mode        | `runner` config | `prelaunch` config |
| ----------- | --------------- | ------------------ |
| `observe`   | accepted        | refused            |
| `fence`     | accepted        | refused            |
| `manage`    | accepted        | refused            |
| `collect`   | accepted        | refused            |
| `hold`      | refused         | accepted           |
| `prelaunch` | refused         | accepted           |

## Code in this slice

1. `parsePrelaunchConfiguration` and the `PrelaunchConfiguration` and `PrelaunchDeployment` types.
2. The shared-checks extraction and `loadPrelaunchDeployment`.
3. A new `scripts/computer-watchdog/main.ts` that holds the mode dispatch as `runWatchdog(argv,
deps)`, with the clock, exit and descriptors injected. `scripts/computer-watchdog.ts` becomes a
   thin entry that calls it. The pinned artifact hash must cover the bundled code that runs, `main.ts` included. This gives tests a seam, because the entry script today runs
   `main()` on import and exits the process.
4. `hold` mode in `main.ts` with the contract above, and the matrix check.
5. Tests, each seen failing with its protection removed.

Nothing in production calls the new code. The launcher, the sampler, admission and delivery are
later slices, so `unavailableAdmission` is unchanged.

## Tests (removed-protection)

Unit tests use the injected clock through `runWatchdog`. One child-process test checks the real
exit code of the entry script.

- A config with `runner` is refused by the prelaunch parser, and one with `kind` by the old parser.
- A prelaunch config with a lifetime or capture key is refused.
- Each shared check refuses on its own, through both loaders: bad artifact hash, wrong boot ID,
  wrong namespace, untrusted node, untrusted artifact, loose config mode or parent mode, wrong
  identity marker, host root mismatch, Docker socket not a root-owned socket, data, Docker data
  or monitor root untrusted, monitor mode not 0700, and overlapping roots.
- Matrix: `hold` with a runner config and `observe` with a prelaunch config both refuse.
- Type check: a `PrelaunchDeployment` does not compile where a `SupervisorDeployment` is required.
- `hold` refuses when stdin, stdout or stderr is not `/dev/null`, and when descriptor 3 is not a
  pipe write end.
- `hold` exits 2 when the load takes 5s, and writes no byte on descriptor 3 before the
  acknowledgement.
- The launcher-side acknowledgement rule accepts only the byte, and refuses a hold that is alive
  with no byte, a hold that exited at the 5s boundary, and an identity that changed.
- `hold` refuses a group equal to its parent's, and a test with the detached flag removed fails.
- `hold` exits when its parent changes, and at 1800s.
- `hold` never calls the heartbeat check, and `loadSupervisorDeployment` still does.

## Out of scope

The launcher and its own verification, the prelaunch sampler body, admission, the bounded second
phase and first healthy sample (item 4), installed delivery, the runtime packet (item 5), any launch.

## Gates

Independent Security and Standards/Spec acceptance of this plan, then of the exact final head.
Removed-protection failures observed and restored. Full local gate through the verify-gate skill.
Green CI on the exact final head. No change to `unavailableAdmission`.
