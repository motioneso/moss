# Computer second phase: bound watchdog and first healthy sample

Plan only. No code, runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. Settles handover items 4 and the orphan part of item 5 from the
[handover contract](2026-10-24-moss-computer-prelaunch-handover.md), as a proposal. Independent
review rounds 1 to 4 (all accept with changes) are folded in below. Round 3 changed the start
order and added a go-gate for `manage`. Round 4 changes are mechanical hardening of the gate,
cleanup and process lookup. Nothing here is accepted until the
review of this revision. Limits stay as accepted: 1800s run, 90s heartbeat, 5s bootstrap bound,
5s sample age, gap under 10s.

## Status of claims

| Claim                                                                                   | State                              |
| --------------------------------------------------------------------------------------- | ---------------------------------- |
| Launcher is root and verifies node, bundle and the running image (PR 3746)              | Verified in code and tests         |
| Launcher can read the Computer's containers through the Docker socket and judge them    | Not yet verified                   |
| The record-based lock survives pid reuse and crashes                                    | Not yet verified                   |
| Node `spawn` cannot give `manage` a real pipe on descriptor 0 (it gives a socket)       | Verified by running it, 2026-10-27 |
| A shell pipeline gives descriptor 0 as `pipe:[n]`                                       | Verified by running it, 2026-10-27 |
| The pump pipeline satisfies the loader's single-writer check                            | Not yet verified                   |
| The gateway connects once to the desktop's guest socket at start, so desktop goes first | Verified in code (no retry)        |
| The first healthy sample and lifetime connect fit inside the gateway's 5s window        | Not yet verified, likely does not  |
| Host tool has exited and closed its store before `manage` starts                        | Not yet verified                   |

## Kill gate

Build nothing if any of these cannot be answered from the code or a measurement:

1. Gap A: the launcher can read container IDs and labels from Docker and the generation numbers
   from the store after the bump, and can cross-check the two (section 1).
2. Gap B: `manage` opens the host state store itself, so the host tool must be fully gone first
   (section 3, step 1).
3. The runner question: the pump arrangement in section 2 is accepted by the loader's
   single-writer check, counted across every process on the box, not only the runner.
4. The timing question: with the fixed order (containers up, then first sample, then lifetime),
   the gateway reaches an active lifetime within 5s of its own start and `manage` finishes its
   first sample within its own 5s (section 3). If not, section 3 names the fallback, which
   changes gateway code and needs its own review.

This plan cannot be built until the prelaunch handover settles the runner, which it lists as
unsettled.

## The problem

Before create, only the lifetime-free `hold` watchdog can exist, because a `manage` watchdog needs
a lifetime binding that holds container IDs (`trust.ts:24-36`, `main.ts:89-93`). After create, the
`manage` watchdog must start from a configuration the loader will trust, and the host tool that
created the containers must not be able to choose what that configuration says.

Three facts from the code shape everything below.

- The gateway container reads the same lifetime secret and both container IDs from its own
  root-delivered config at start (`scripts/computer-gateway/config.ts`, mounted at `/config`).
  It reads it once.
- The gateway closes itself 5s after its own start unless its lifetime handshake is active
  (`gateway-server.ts`, `startupAt + 5000`).
- A `manage` sample needs both containers running (`observe.ts:71`), and `supervisor.ts` starts
  the lifetime connection only after the first healthy sample.

Today the host tool creates and starts the gateway, then the desktop (`operations.ts`, ROLES
order), so the gateway cannot have the desktop ID in its config and its 5s clock is long spent
before any sample can exist. The ordering therefore has to change.

## Proposal

### 1. Create first, start later, secret made by the launcher

The host tool creates both containers without starting them, records both IDs in its store,
reports that create finished, and closes its store and exits. This is a change to the host tool
(`operations.ts` start loop) and is part of piece (a) in the build plan. Then the launcher:

1. Lists every container on the Docker socket, including stopped ones, and refuses unless exactly
   two carry the Computer's labels or names (desktop and gateway) and no other container does.
2. Inspects each by its full 64-hex ID, never by name. It compares what Docker reports with the
   host store's `state.json`, which is untrusted input. IDs, roles, names and the generation
   labels must agree between the two, or it refuses. Docker's answer wins any later use; the
   store only supplies the request generation. It refuses unless each of these holds. The list is
   "at least these" and is complete only when each item has a test that fails without it.
   - state is created and not running (the running check moves to step 7)
   - creation time is after this run's generation bump
   - image digest equals the pinned digest
   - no extra mounts or devices, and not privileged
   - no host PID mode and no host network mode
   - exact command and entrypoint
   - no restart policy
   - exact label values, including the instance ID taken from the root-written host config
3. A container created before the bump is refused and stays refused. It is never adopted.
4. Generates the 64-hex secret itself. This is the only place the secret is made.
5. Writes two root-owned files, each in the mode its reader already requires, before any
   container starts: the second watchdog config (new name, never rewriting the
   prelaunch file), and the gateway config in the gateway config directory with the same secret,
   binding and container IDs. The gateway config keeps its existing root delivery mode and owner
   (`root:1000`, directory 0750, file 0640), which the gateway loader already re-checks.
6. Starts the heartbeat pipeline with `manage` held at a go-gate (section 2), reads the pump's
   identity, and only then writes the second watchdog config (the runner identity is in it).
   The gate stays closed until both files are on disk.
7. Starts the desktop by full ID and waits, bounded and outside the gateway's clock, until the
   desktop's guest socket accepts a connection. The gateway connects to that socket once at
   start, with no retry (`gateway-server.ts`, `connectComputerGuestWebSocket`, 2s handshake), so
   the gateway depends on the desktop and desktop-first is required, not only allowed. The
   host tool's current gateway-first order has no working dependency on this and is replaced.
8. Starts the gateway by full ID and opens the go-gate at once. Every container is running
   before `manage` reads anything, because its first sample runs at once and a failed sample
   stops the run (`supervisor.ts`, `observe.ts` `checkComputerLogs`).
9. Re-inspects both containers and re-compares every item in step 2, now including state
   running. It re-compares again once the lifetime is active.

What is checked, in plain terms: the launcher is root and verified (PR 3746). It read and judged
the containers itself (not yet verified). Only root can write the config directories, so the gap
between writing a file and a reader loading it sits inside the trust boundary. The SHA-256 is
dropped from launcher memory because nothing compares against it.

Why host-store values are safe to copy. The instance ID comes from the root host config, not the
store. The two resource generations are checked against Docker's names and labels in step 2. The
request generation is read from the store and has no Docker counterpart, but
`assertFencedComputerState` compares it with `state.json` on every sample and the store validates
that no resource generation exceeds it. A wrong value can only make a sample fail closed; it
cannot widen what the watchdog accepts, because the IDs and resource generations that matter
were fixed from Docker.

### 2. Runner and heartbeat

The loader (`trust.ts`) needs descriptor 0 of `manage` to be a real anonymous pipe with exactly
one write end in the runner's own descriptor table (`assertHeartbeatPipe`). It also needs the
stdout and stderr of both the runner and `manage` to be `/dev/null` (`assertNullOutputs`). Node
`spawn` hands a child a socket pair (confirmed by running it), and a FIFO opened by path shows as
a path, not `pipe:[n]`. The launcher alone cannot make the pipe.

Mechanism proposed:

- The pinned runner is a small `pump` mode of the pinned bundle, not the launcher.
- The launcher starts one root-owned shell pipeline. It resolves `sh`, `setsid` and the node
  binary to real paths and runs the same `assertTrustedPath` check on each (no symlink, one hard
  link, root-owned, not group or world writable). A usr-merge `/bin` link or a busybox build
  fails that check, so the launcher uses only resolved paths that pass, and refuses when none do.
- The pump gets the pipe write end on descriptor 3 (`3>&1`), descriptors 0, 1 and 2 on
  `/dev/null`, and one socket pair end from the launcher on descriptor 4. The `manage` stage
  gets the pipe on descriptor 0, `/dev/null` on 1 and 2, and descriptors 3 and 4 closed
  (`3>&- 4>&-`), so it does not inherit the launcher's socket end. The loader's writer count then
  sees exactly one descriptor, 3.
- The `manage` stage is `setsid sh -c 'read -r line < "$GATE" || exit 1; [ "$line" = "$TOKEN" ]
|| exit 1; unset TOKEN; exec manage ...'`. `GATE` is a FIFO the launcher creates fresh with an
  exclusive `mkfifo` under a random name in a root 0700 directory, and checks is a FIFO (not a
  file, link or other node) before use. `TOKEN` is a per-run random value the launcher also
  holds, passed in the stage's environment, not its command line. `read` returns on a newline or
  at end of file, so the `||` and the exact compare are what stop an open-and-close or a wrong
  value from releasing the gate. `setsid` gives `manage` its own group, because `main.ts:129-133`
  refuses a `manage` that shares a pid or group with the runner. The shell does not hold the
  gate across `exec`.
- Finding the processes. The pump and the `manage` stage are children of the outer shell. The
  launcher lists the outer shell's children from `/proc` and identifies the pump by pinned exe,
  exact command line, and a pump-sent message on the launcher's socket end that carries the
  per-run token and the pump's own pid, which must equal the pid found. It identifies the
  `manage` stage by the other child, with its group equal to its pid after `setsid`. It
  records pid, start ticks and group for both before writing the config. Anything unexpected
  (extra child, wrong exe, wrong command line, missing token) refuses.
- Go-gate. The pump starts and idles with no config. The launcher writes the pump's pid, start
  ticks and group into the second config, then writes the token and a newline to the gate.
  `manage` does not read its config until `exec`, so it cannot see a config without the runner
  identity. The gate wait is before the `manage` process image starts, so it does not count
  against the 5s bootstrap bound (which counts from `runWatchdog` start).
- The pump writes a frame only when the launcher sends one, and exits on socket close or
  launcher change, so a dead launcher closes the pipe and `manage` fails closed.
- Failure cleanup reaches every stage. `setsid` puts the `manage` stage in its own group and
  session, so killing the outer shell's group does not reach it. On every failure path the
  launcher kills the pump, the `manage` stage and the outer shell each by recorded identity: it
  re-reads pid, start ticks and group, and signals only on a match. A gate-waiter must not
  survive, because anything that later releases it would start `manage`. Test: a failure with
  the gate closed leaves no process from the pipeline.
- The launcher sends one frame, `{"counter":n,"runId":...}` and a newline, per interval for the
  whole run, one frame per write, counter increasing by exactly one (`supervisor.ts` heartbeat
  handler). The interval is under the 90s limit with margin, set in the build.
- The launcher's stdout and stderr go to `/dev/null`.

The loader's writer count covers only the runner's own descriptors. It cannot see an extra writer
held by the shell or any other process. So the box-wide check is a new launcher-side check, not
a loader property. The launcher scans every `/proc/*/fd` and refuses if any process other than
the pump holds the pipe's write end. It runs the scan before the gate opens, and once more after
`manage`'s first healthy sample. On failure it kills every stage by identity, leaves the gate
closed (or stops the run, if past it), and keeps admission refused. This is a start-time check
inside the root trust boundary and is not a standing guarantee. The running watchdog re-checks
only that the runner process exists (`verifyRunner` is `readComputerProcess`), never the pipe,
and root can open `/proc/<pump>/fd/3` later and become a writer. Unverified until built: that the
shell closes its own pipe copies after forking both stages. A test with a planted extra writer
must make the launcher refuse.

No loader change is proposed.

### 3. Handover without a gap

Hold is a lifetime-free idler. It fences nothing and stops nothing.

1. Before starting, settle gap B. `manage` opens the host state store itself and takes
   `daemon.lock` (`managed-host.ts`), and it also becomes the host service. The host tool is a
   one-shot that exits after create. The launcher requires both that the recorded host tool
   process is gone (pid, start ticks, boot ID) and that no process holds the lock path open. The
   lock check alone is racy, so neither suffices alone.
2. Request gap. The host tool is also the request server for enable, disable and status.
   Between its exit and `manage` serving, nothing listens on the host socket, so a request fails
   closed (the connection is refused) and the launcher does not listen. Admission stays refused.
   The build must confirm the host tool leaves no live listener when it exits. `manage` replaces the host tool as the
   request server for the rest of the run.
3. Start order is fixed by section 1 steps 6 to 8: pipeline held at the gate, config written,
   desktop up and its guest socket accepting, gateway up, gate opened. `manage` then runs its
   loader checks, opens the store, takes its first sample (both containers already running) and
   starts the lifetime connection, which `supervisor.ts` begins only after that sample.
4. Two clocks run at once. `manage`'s 5s bootstrap bound counts from its process start and ends
   at its first complete durable healthy sample, no older than 5s when read. The gateway's own
   5s counts from the gateway start, which comes first, and ends when its lifetime is active.
   The gateway's budget is the tighter one and covers the gateway's own guest connect, the
   `manage` start, the loader checks, the store open, the first sample, the lifetime connect and
   the challenge round trips. `manage` writes no acknowledgement byte (`main.ts`). The launcher
   reads its process identity before and after, checks its group equals its own pid, and treats
   a fresh durable sample as the signal.
   Whether this fits is a measurement (kill gate 4). If it does not, the fallback is a gateway
   change, reviewed on its own. The gateway reads its window from its root-written config. The
   config parser enforces a hard maximum (set in the build and reviewed with the change), and a
   value above it, or a missing value, is refused or defaults to 5s. The gateway with no active
   lifetime grants nothing, so a longer window adds little exposure.
5. Switch the lock record to `manage` under the same lock, then kill `hold`. The run is never
   without a watchdog or a record.
6. The 1800s limit counts from the original `hold` start time, so a handover cannot extend the
   run.
7. Kill `hold` by the child handle plus an identity re-read, never by a bare pid. The current
   `launchHold` kill is `process.kill(-pid, "SIGKILL")` with no re-read. The build adds the
   re-read: pid, start ticks and group leader must match the record immediately before the
   signal. A residual race between the read and the signal remains while the group is entirely
   gone; it is listed under not claimed.
8. Containers do not stop by themselves when `manage` never connects. `hold` does no fencing,
   and no existing code stops containers in that case. The gateway fails closed on its own (no
   lifetime, no grants, closes at 5s), but the desktop keeps running. So the launcher stops both
   containers by full ID on any failure after step 7 of section 1, and checks they are stopped.
   If the launcher itself is killed, nothing stops the desktop. Under not claimed.
9. If the launcher dies, `hold` exits within about 1s because its parent changed, and the pump
   exits because its socket closed. That is existing behaviour plus the pump rule, not new
   cleanup. A leftover desktop is cleaned by the next launcher start, which stops any container
   pair from an earlier run by full ID before it refuses or proceeds.

### 4. Failed or half-finished `manage` start

A failed start may have opened the store, written journal entries, or taken `daemon.lock`. Before
the launcher keeps admission refused or retries, it checks that the `manage` process and the pump
are gone, the lock is free, the journal holds no sample from the failed attempt, and the
container records still match. It then stops the containers (section 3, step 8). If any check
fails, admission stays refused and nothing retries. `hold` keeps running until the run limit.

### 5. One hold per run, and leftovers

- A record file holds the pid, start ticks, boot ID and run ID. A lock file existing does not mean
  held, because the repo's `daemon.lock` stays after a crash.
- Acquire is atomic. The launcher creates the record with an exclusive create (`O_EXCL`) in the
  root 0700 directory. If it exists, the launcher checks whether the recorded process is live
  (below). A stale record is taken over by `rename` to a unique name, which only one racer can
  win, followed by a fresh exclusive create. The loser sees the file gone or recreated and
  refuses. Two launchers can never both start a `hold`.
- Held means the recorded pid, start ticks and boot ID still match a live process running the
  pinned program.
- Before signalling, the launcher re-reads that process's identity. It signals the process group
  only if the group leader is the recorded process.
- Any other process is left alone and the stale record is removed. Admission stays refused until
  cleanup finishes.

## Not claimed

- That a hostile root-equivalent host process is stopped. Root can do all of this itself.
- That the containers are healthy beyond what the journal sample measures.
- That the Docker socket answers truthfully if Docker itself is compromised.
- That the desktop stops if the launcher is killed outright. The gateway closes itself, the
  desktop does not, until the next launcher start cleans up.
- That a pid is never reused in the instant between the identity re-read and the kill signal.
- That the 5s gateway window is met. It is a measurement, not a result.
- That the pump pipeline has one writer. It is proven only when the launcher's box-wide scan
  test passes. The loader does not check this.
- That round 2 was complete. Each round 2 finding was checked against main and none was wrong.
  Finding 3 was right that no create record exists, so the plan compares Docker with the
  untrusted store instead.

## Open questions for the reviewer

- A: the launcher reads IDs and Docker facts itself, and copies only the request generation and
  resource generations from the store (section 1). Is that enough, given the cross-checks?
- Settled in round 3 and adopted: A is enough. B is a one-shot host tool plus a gone-process
  check. C is the pump with `setsid` and no loader change. D is acceptable (the unreaped child
  handle blocks reuse for a `hold` this launcher started; the race is for older leftovers). E is
  acceptable only with the window in the root-written gateway config and a hard maximum. F keeps
  container start with the launcher.
- New: is the go-gate FIFO read before `exec` acceptable, or must `manage` itself wait?
- New: is the box-wide writer scan in the launcher enough, given the loader cannot see it?

## Tests, one per rule

Each is seen failing with its protection removed.

| Rule                                | Test                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Exactly two containers, none others | A third container with the labels, running and stopped                 |
| Lookalike                           | A container with the right label and name but created before the bump  |
| Pinned digest                       | Wrong image digest                                                     |
| Mounts                              | Extra mount, extra device, privileged, host PID, host network          |
| Command                             | Different command or entrypoint                                        |
| Restart policy                      | Policy set                                                             |
| Re-read                             | Container changed after `manage` started                               |
| Config source                       | Host tool reports other IDs or generations                             |
| Store against Docker                | Store IDs or generation labels disagree with Docker, refused           |
| Secret delivery                     | Gateway and watchdog configs carry the same secret; a mismatch fails   |
| Gateway window                      | Measured gateway start to active lifetime, against the 5s limit        |
| Pipe writers                        | Extra write end held anywhere on the box makes the launcher refuse     |
| Runner descriptors                  | Pipe on 1 or 2 of the pump is refused by the loader                    |
| Go-gate                             | `manage` never reads a config lacking the runner identity              |
| Gate release                        | Open-and-close, wrong token, no newline, regular file at path: refused |
| Gate FIFO                           | Pre-existing path, non-FIFO node: refused                              |
| Failure with gate closed            | No shell, pump or `manage` process remains                             |
| Stage descriptors                   | `manage` has no descriptor 3 or 4                                      |
| Process lookup                      | Wrong exe, command line, token or extra child: refused                 |
| Pinned shell paths                  | Symlinked or multiply linked `sh` or `setsid` refused                  |
| Scan timing                         | Extra writer after the first sample makes the launcher stop the run    |
| Start order                         | A sample before both containers run fails; the fixed order passes      |
| Request gap                         | Enable, disable, status between host tool exit and `manage` refused    |
| Gateway window cap                  | Window above the hard maximum or missing is refused or defaults        |
| Desktop first                       | Gateway started before the guest socket accepts fails its connect      |
| Pipe liveness                       | Launcher stops sending frames, or dies, and `manage` stops             |
| Atomic acquire                      | Two launchers race for the record, one wins                            |
| Manage never connects               | Both containers are stopped by ID and confirmed stopped                |
| Host tool still running             | Lock held or host tool alive, `manage` is not started                  |
| Pid reuse                           | Recorded pid reused by an unrelated root process, left alone           |
| Group kill                          | Group leader is not the recorded process                               |
| Run limit                           | Handover does not extend 1800s                                         |
| Handover failure                    | `manage` exits early, no sample, stale sample, extra byte              |
| Crash                               | Launcher dies at each step of handover                                 |
| Half start                          | Failed `manage` leaves the lock or journal behind                      |

Verification commands when built: the launcher and bundle unit tests, `pnpm typecheck`, prettier
and eslint on touched files, and the gate through `scripts/run-gate.sh`. Live proof on a real
root-owned install belongs to installed delivery and is not claimed here.

## Build plan after acceptance

One PR per piece: (a) host tool create-then-stop ordering, container read and both configurations, (b) pump pipeline, `manage` start and handover,
(c) record and cleanup. The deferred pieces are hard merge blockers for the Computer feature and
are tracked in #3749.
