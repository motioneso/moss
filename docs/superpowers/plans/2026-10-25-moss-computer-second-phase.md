# Computer second phase: bound watchdog and first healthy sample

Plan only. No code, runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. Settles handover items 4 and the orphan part of item 5 from the
[handover contract](2026-10-24-moss-computer-prelaunch-handover.md), as a proposal. Independent
review round 1 (accept with changes) is folded in below. Nothing here is accepted until the
review of this revision. Limits stay as accepted: 1800s run, 90s heartbeat, 5s bootstrap bound,
5s sample age, gap under 10s.

## Status of claims

| Claim                                                                                | State                              |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| Launcher is root and verifies node, bundle and the running image (PR 3746)           | Verified in code and tests         |
| Launcher can read the Computer's containers through the Docker socket and judge them | Not yet verified                   |
| The record-based lock survives pid reuse and crashes                                 | Not yet verified                   |
| The runner and heartbeat arrangement below                                           | Not yet verified                   |
| Host tool has exited or closed its state store before `manage` starts                | Not yet verified (open question B) |

## Kill gate

Build nothing if any of these cannot be answered from the code:

1. Gap A: the launcher can generate the secret and read the three generation numbers from the
   store itself after the bump.
2. Gap B: `manage` can open the host state store while no other process holds `daemon.lock`.
3. The runner question: one process is named as the pinned runner and the heartbeat pipe
   arrangement below is accepted by the loader.

This plan cannot be built until the prelaunch handover settles the runner, which it lists as
unsettled.

## The problem

Before create, only the lifetime-free `hold` watchdog can exist, because a `manage` watchdog needs
a lifetime binding that holds container IDs (`trust.ts:24-36`, `main.ts:89-93`). After create, the
`manage` watchdog must start from a configuration the loader will trust, and the host tool that
created the containers must not be able to choose what that configuration says.

## Proposal

### 1. The launcher writes the second configuration, from its own reads

The host tool reports only that create finished. The launcher then:

1. Lists every container on the Docker socket, including stopped ones, and refuses unless exactly
   two carry the Computer's labels or names (desktop and gateway) and no other container does.
2. Inspects each by its full 64-hex ID, never by name. It refuses unless each of these holds. The
   list is "at least these" and is complete only when each item has a test that fails without it.
   - the ID matches the launcher's own create record
   - state is running
   - creation time is after this run's generation bump
   - image digest equals the pinned digest
   - no extra mounts or devices, and not privileged
   - no host PID mode and no host network mode
   - exact command and entrypoint
   - no restart policy
   - exact label values
3. Re-reads and re-compares both records after the second watchdog starts.
4. A container created before the bump is refused and stays refused. It is never adopted.
5. Generates the 64-hex secret itself and reads the instance ID and the three generation numbers
   from the store after the bump, never from the host tool's report. The config also holds the
   runner identity, set under the runner section below.
6. Writes the file in the same root-owned directory (file 0600, directory 0700) under a new name.
   It never rewrites the prelaunch file.

What is checked, in plain terms: the launcher is root and verified (PR 3746). It read and judged
the containers itself (not yet verified). Only root can write the config directory, so the gap
between writing the file and the loader reading it sits inside the trust boundary. The SHA-256 is
dropped from launcher memory because nothing compares against it.

### 2. Runner and heartbeat

- The pinned runner is the launcher itself, the only candidate.
- Launcher stdout and stderr go to `/dev/null`.
- The launcher is the only holder of the heartbeat pipe write end. No child inherits it.
- Separation from `manage` holds by pid and process group, and is checked against
  `main.ts:129-133` when built.

### 3. Handover without a gap

1. Before starting, settle gap B: the host tool has exited or closed its store, so `daemon.lock`
   is free for `manage`, and the fenced-state precondition is checked against containers that are
   already running.
2. Start `manage` from the new file while `hold` runs, with the same start checks as `hold`
   (own socket end, one byte, identity unchanged, image check).
3. Wait for the first complete durable healthy sample in `manage`'s journal, no older than 5s
   when read. This wait is the same clock as the 5s bootstrap bound, not a second 5s. It starts
   at the acknowledgement.
4. Switch the lock record to `manage` under the same lock, then kill `hold`. The run is never
   without a watchdog or a record.
5. The 1800s limit counts from the original `hold` start time, so a handover cannot extend the run.
6. Kill `hold` by the child handle plus an identity re-read, never by a bare pid.
7. If the launcher dies, `hold` exits within about 1s because its parent changed. That is existing
   behaviour, not new cleanup. Running containers then fall to the existing watchdog expiry. This
   plan adds nothing for them.

### 4. Failed or half-finished `manage` start

A failed start may have opened the store, written journal entries, or taken `daemon.lock`. Before
the launcher keeps admission refused or retries, it checks that the `manage` process is gone, the
lock is free, the journal holds no sample from the failed attempt, and the container records still
match. If any check fails, admission stays refused and nothing retries. `hold` keeps running.

### 5. One hold per run, and leftovers

- A record file holds the pid, start ticks, boot ID and run ID. A lock file existing does not mean
  held, because the repo's `daemon.lock` stays after a crash.
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
| Pid reuse                           | Recorded pid reused by an unrelated root process, left alone          |
| Group kill                          | Group leader is not the recorded process                              |
| Run limit                           | Handover does not extend 1800s                                        |
| Handover failure                    | `manage` refuses its ack, no sample, stale sample, extra byte         |
| Crash                               | Launcher dies at each step of handover                                |
| Half start                          | Failed `manage` leaves the lock or journal behind                     |

Verification commands when built: the launcher and bundle unit tests, `pnpm typecheck`, prettier
and eslint on touched files, and the gate through `scripts/run-gate.sh`. Live proof on a real
root-owned install belongs to installed delivery and is not claimed here.

## Build plan after acceptance

One PR per piece: (a) container read and second configuration, (b) `manage` start and handover,
(c) record and cleanup. The deferred pieces are hard merge blockers for the Computer feature and
are tracked in #3749.
