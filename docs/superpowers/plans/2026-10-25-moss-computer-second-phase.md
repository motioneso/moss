# Computer second phase: bound watchdog and first healthy sample

Plan only. No code, runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. Settles handover items 4 and the orphan part of item 5 from the
[handover contract](2026-10-24-moss-computer-prelaunch-handover.md), as a proposal for independent
Security review. Nothing here is accepted until that review. Limits stay as accepted: 1800s run,
90s heartbeat, 5s bootstrap bound, 5s sample age, gap under 10s.

## The problem

Before create, only the lifetime-free `hold` watchdog can exist, because a `manage` watchdog needs
a lifetime binding that holds container IDs (`trust.ts:24-36`, `main.ts:89-93`). After create, the
`manage` watchdog must start from a configuration the loader will trust, and the host tool that
created the containers must not be able to choose what that configuration says. Without that, a
host that lies about container IDs gets a watchdog that watches the wrong things.

## Proposal

### 1. The launcher writes the second configuration, from its own reads

The host tool reports only that create finished. The launcher then:

1. Reads the Computer's containers itself through the root-owned Docker socket by fixed label and
   fixed name, refuses unless the set is exactly the expected containers (desktop and gateway),
   each from the pinned image digest, each with the pinned network, mount and resource shape.
2. Builds the supervisor configuration from the pinned prelaunch fields plus those verified IDs.
3. Writes it as a new file in the same root-owned directory (file 0600, directory 0700) under a
   new name. It never rewrites the prelaunch file.
4. Keeps the file's SHA-256 in launcher memory.

Trust rests on three things the launcher can show: it is root and verified (PR 3746), it read the
IDs itself, and only root can write the directory. It does not rest on the host tool's word.

### 2. Handover without a gap

1. Start `manage` from the new file, with the heartbeat pipe the loader needs, while `hold` runs.
2. Accept `manage` only on its own start-up acknowledgement, using the same checks as `hold`
   (socket end the launcher keeps, one byte, 7s, identity unchanged, image check).
3. Wait for the first complete durable healthy sample in `manage`'s journal (`journal.ts`),
   at most 5s after acknowledgement and no older than 5s when read. Bad or late means kill
   `manage`, keep `hold` running, and refuse admission.
4. Only then kill `hold`'s process group. The run is never without a watchdog.

### 3. One hold per run, and leftovers

- The launcher takes an exclusive lock file in the root-owned state directory that records the
  hold's pid, start ticks and run ID. A second launcher or a second run refuses while it is held.
- On start, the launcher reads a leftover record. If a process matches the recorded pid and start
  ticks and its exe and command line match the pinned ones, it kills that group. Any other process
  is left alone and the stale record is removed. Admission stays refused until cleanup finishes.

## Not claimed

- That a hostile root-equivalent host process is stopped. Root can do all of this itself.
- That the containers are healthy beyond what the journal sample measures.
- That the Docker socket answers truthfully if Docker itself is compromised.

## Questions for the Security reviewer

1. Is reading IDs through the Docker socket enough, or must the launcher also check image digests
   and mounts from the inspect record, as step 1 says, and is that list complete?
2. Can a container created before the launcher's read (a lookalike with the right label) pass step 1?
3. Is the lock file safe against a stale record whose pid was reused by another root process?
4. Does starting `manage` while `hold` runs break the loader's runner-separation rule
   (`main.ts:129-133`), and which process is the pinned `runner`?

## Build plan after acceptance

One PR per piece, each with tests seen failing without their protection: (a) container read and
second configuration, (b) `manage` start and handover, (c) lock and cleanup. Live proof on a real
root-owned install belongs to installed delivery and is not claimed here.
