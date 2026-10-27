# Computer second phase: bound watchdog and first healthy sample

Plan only. No code, runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. Settles handover items 4 and the orphan part of item 5 from the
[handover contract](2026-10-24-moss-computer-prelaunch-handover.md), as a proposal. Independent
review rounds 1 and 2 (both accept with changes) are folded in below. Round 2 changed the
design (create-then-start ordering, a pump process for the heartbeat pipe), so a third review is
required. Nothing here is accepted until the
review of this revision. Limits stay as accepted: 1800s run, 90s heartbeat, 5s bootstrap bound,
5s sample age, gap under 10s.

## Status of claims

| Claim                                                                                | State                              |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| Launcher is root and verifies node, bundle and the running image (PR 3746)           | Verified in code and tests         |
| Launcher can read the Computer's containers through the Docker socket and judge them | Not yet verified                   |
| The record-based lock survives pid reuse and crashes                                 | Not yet verified                   |
| Node `spawn` cannot give `manage` a real pipe on descriptor 0 (it gives a socket)    | Verified by running it, 2026-10-27 |
| A shell pipeline gives descriptor 0 as `pipe:[n]`                                    | Verified by running it, 2026-10-27 |
| The pump pipeline satisfies the loader's single-writer check                         | Not yet verified                   |
| The first healthy sample and lifetime connect fit inside the gateway's 5s window     | Not yet verified, likely does not  |
| Host tool has exited and closed its store before `manage` starts                     | Not yet verified                   |

## Kill gate

Build nothing if any of these cannot be answered from the code or a measurement:

1. Gap A: the launcher can read container IDs and labels from Docker and the generation numbers
   from the store after the bump, and can cross-check the two (section 1).
2. Gap B: `manage` opens the host state store itself, so the host tool must be fully gone first
   (section 3, step 1).
3. The runner question: the pump arrangement in section 2 is accepted by the loader's
   single-writer check, counted across every process on the box, not only the runner.
4. The timing question: with the real startup sequence, the gateway reaches an active lifetime
   within 5s of its own start (section 3). If not, section 3 names the fallback, which changes
   gateway code and needs its own review.

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
6. Starts the heartbeat pipeline and `manage` (sections 2 and 3).
7. Starts the desktop, then the gateway, by full ID. Then re-inspects both and re-compares every
   item in step 2, now including state running. It re-compares again once the lifetime is active.

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

The loader (`trust.ts` `assertHeartbeatPipe`) needs descriptor 0 of `manage` to be a real
anonymous pipe, with exactly one write end, held by the pinned runner. Node `spawn` hands a child
a socket pair (confirmed by running it), and a FIFO opened by path shows as a path, not
`pipe:[n]`. The launcher alone cannot make the pipe.

Mechanism proposed:

- The pinned runner is a small `pump` mode of the pinned bundle, not the launcher.
- The launcher starts one root-owned shell pipeline, `pump | setsid manage`, from pinned absolute
  paths. The shell makes the real pipe. `setsid` puts `manage` in its own group, because
  `main.ts:129-133` refuses a `manage` that shares a pid or group with the runner.
- The pump has no stdio except the pipe on descriptor 1 and one socket pair end from the
  launcher. It writes a frame only when the launcher sends one, and exits on socket close or
  launcher change, so a dead launcher closes the pipe and `manage` fails closed.
- The launcher sends one frame, `{"counter":n,"runId":...}` and a newline, per interval for the
  whole run, one frame per write, counter increasing by exactly one (`supervisor.ts` heartbeat
  handler). The interval is under the 90s limit with margin, set in the build.
- The runner identity in the second config is the pump's pid and start ticks, known before
  `manage` starts.
- The launcher's stdout and stderr go to `/dev/null`.
- Unverified until built: the shell closes its own copies of the pipe ends after forking both
  stages. The build must prove, by scanning `/proc/*/fd`, that the pump is the only writer in
  the whole box, not just the only writer in the runner's table. A test with an extra writer
  must fail the loader.

Fallback if the pipeline cannot be proven: change the loader to accept an authenticated socket
end. That loosens an accepted check and needs its own design review. It is not proposed.

### 3. Handover without a gap

Hold is a lifetime-free idler. It fences nothing and stops nothing.

1. Before starting, settle gap B. `manage` opens the host state store itself and takes
   `daemon.lock` (`managed-host.ts`), and it also becomes the host service. The host tool must
   therefore be fully gone first. The launcher checks that no process holds the lock path open
   and that the recorded host tool process is gone, and refuses otherwise. There is no host
   tool left running after this point; `manage` is the only host service for the run.
2. Start `manage` through the pipeline while `hold` runs. The launcher reads `manage`'s process
   identity before and after, checks its group equals its own pid, and checks that the identity
   is unchanged. `manage` writes no acknowledgement byte (`main.ts`). Its only signal is the
   journal sample, so the launcher treats a fresh durable sample as the signal.
3. The 5s bootstrap bound counts from the `manage` process start (`runWatchdog` start time), not
   from any acknowledgement. It ends at `manage`'s first complete durable healthy sample, which
   must be no older than 5s when read. It is one clock.
4. Timing against the gateway. The gateway's own 5s runs from its start. A sample needs both
   containers running, so the launcher starts the desktop first and the gateway last, and
   everything from the gateway start to an active lifetime must finish inside 5s. That includes
   a sample, the lifetime connect, and the challenge round trips. Whether it fits is a
   measurement (kill gate 4). If it does not fit, the fallback is a gateway change: the 5s window
   becomes a value in the root-written gateway config, or starts when the lifetime socket
   appears. That changes an accepted limit and needs its own review. It is not assumed.
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
- That the pump pipeline has one writer. It is proven only when the box-wide scan test passes.
- That round 2 was complete. Each round 2 finding was checked against main and none was wrong.
  Finding 3 was right that no create record exists, so the plan compares Docker with the
  untrusted store instead.

## Open questions for the reviewer

- A: the launcher reads IDs and Docker facts itself, and copies only the request generation and
  resource generations from the store (section 1). Is that enough, given the cross-checks?
- B: `manage` opens the store and becomes the host service, so the host tool must be gone
  (section 3, step 1). Is the lock-and-process check enough, or must the host tool be a one-shot?
- C: the pump pipeline (section 2). Is a pump plus `setsid` acceptable, or should the loader
  change instead?
- D: killing `hold` with an identity re-read (section 3, step 7). Is the residual pid-reuse race
  acceptable?
- E: the gateway 5s window. If the measurement fails, is a root-configured window acceptable?
- F: launcher started containers by full ID (section 1, step 7). Should `manage` start them
  instead?

## Tests, one per rule

Each is seen failing with its protection removed.

| Rule                                | Test                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| Exactly two containers, none others | A third container with the labels, running and stopped                |
| Lookalike                           | A container with the right label and name but created before the bump |
| Pinned digest                       | Wrong image digest                                                    |
| Mounts                              | Extra mount, extra device, privileged, host PID, host network         |
| Command                             | Different command or entrypoint                                       |
| Restart policy                      | Policy set                                                            |
| Re-read                             | Container changed after `manage` started                              |
| Config source                       | Host tool reports other IDs or generations                            |
| Store against Docker                | Store IDs or generation labels disagree with Docker, refused          |
| Secret delivery                     | Gateway and watchdog configs carry the same secret; a mismatch fails  |
| Gateway window                      | Measured gateway start to active lifetime, against the 5s limit       |
| Pipe writers                        | Extra write end held by any process on the box fails the loader       |
| Pipe liveness                       | Launcher stops sending frames, or dies, and `manage` stops            |
| Atomic acquire                      | Two launchers race for the record, one wins                           |
| Manage never connects               | Both containers are stopped by ID and confirmed stopped               |
| Host tool still running             | Lock held or host tool alive, `manage` is not started                 |
| Pid reuse                           | Recorded pid reused by an unrelated root process, left alone          |
| Group kill                          | Group leader is not the recorded process                              |
| Run limit                           | Handover does not extend 1800s                                        |
| Handover failure                    | `manage` exits early, no sample, stale sample, extra byte             |
| Crash                               | Launcher dies at each step of handover                                |
| Half start                          | Failed `manage` leaves the lock or journal behind                     |

Verification commands when built: the launcher and bundle unit tests, `pnpm typecheck`, prettier
and eslint on touched files, and the gate through `scripts/run-gate.sh`. Live proof on a real
root-owned install belongs to installed delivery and is not claimed here.

## Build plan after acceptance

One PR per piece: (a) host tool create-then-stop ordering, container read and both configurations, (b) pump pipeline, `manage` start and handover,
(c) record and cleanup. The deferred pieces are hard merge blockers for the Computer feature and
are tracked in #3749.
