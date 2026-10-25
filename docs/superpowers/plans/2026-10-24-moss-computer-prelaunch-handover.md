# Computer prelaunch handover contract

Plan only. No code, no runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. This settles the three open items in the
[prelaunch admission plan](2026-10-24-moss-computer-prelaunch-admission.md): the trusted watchdog
identity, the fresh-sample path and the used-sample record.

## Facts from the tree

| Source                                                                               | Fact                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-watchdog.ts:35-44,75-78`                                           | The watchdog process refuses to share a pid or process group with the pinned runner. Modes are `observe`, `fence`, `manage` and `collect`. `observe` rejects a lifetime and `manage` needs one. |
| `scripts/computer-watchdog.ts:46-72`                                                 | `collect` is a one-shot. It reads one bounded JSON record on stdin (run ID, config hash, watchdog identity), runs `observeComputer`, and writes one sample to stdout, capped at 16 KiB.         |
| `scripts/computer-watchdog/supervisor.ts:58-100`                                     | The supervisor spawns that collector with empty environment and stdio pipe, pipe, ignore, and reads the sample over a pipe it owns.                                                             |
| `scripts/computer-watchdog/trust.ts:27-28,243-246`                                   | The pinned configuration holds the run ID and runner identity. `processIdentity(pid)` reads pid, group and start ticks from `/proc`.                                                            |
| `scripts/computer-host.ts:7-8`, `scripts/computer-host/service.ts`                   | The launch operations run in the opt-in host tool, a different process from the watchdog. `manage` mode serves only existing-resource operations.                                               |
| `scripts/computer-watchdog/observe.ts:119`, `scripts/computer-host/operations.ts:12` | Without a lifetime the observation skips the pair and fence checks. `assertAdmitted()` takes no arguments.                                                                                      |

## Decision: the launcher spawns the watchdog and a one-shot sampler

Independence is the point of the watchdog, so admission must not sample itself in the launching
process. The contract reuses the pipe model the supervisor already uses.

1. **Identity source.** The launcher process spawns the long-running watchdog and reads its identity
   from `/proc` with `processIdentity` immediately after spawn, from the child handle it owns. The
   sample is never the source of that identity. This answers the open item that `trust.ts` pins no
   watchdog identity: the trust anchor is that the launcher itself created the child.
2. **Fresh-sample path.** After the generation bump (operations.ts:66-70), admission spawns a
   one-shot sampler in `collect` style. The request on stdin holds the run ID, the config hash, the
   watchdog identity from item 1, the admitted generation and a random 128-bit nonce made by the
   launcher. The sample comes back on the sampler's stdout pipe, which only the launcher holds. No
   file, no shared directory and no other local writer is involved, so the file-forgery and
   file-permission concerns do not arise.
3. **Used-sample record.** The nonce is single use and lives in the launcher's memory for the one
   request. The sample must echo the nonce, the generation and the boot ID (trust.ts:35). A new
   spawn is needed for each admission, so a replayed byte string from an earlier pipe cannot match
   a fresh nonce. A launcher restart drops the nonce, and the old sample then has no matching
   request. No durable record and no change to the host state file (state.ts:62) are needed.

## Sampler contract

- Same host-only observation as the prelaunch admission plan, including the stop-marker and enabled
  checks moved out of the lifetime early return, and the floors RAM and root at least 8 GiB and
  data at least 30 GiB.
- Verifies that the supplied watchdog identity is a live process with the same start ticks
  (`readComputerProcess`). A dead or replaced watchdog refuses. The sampler cannot see heartbeat
  state, so it proves only that the watchdog process exists.
- Reads `measuredAtMs` before any I/O. The launcher rejects a sample older than 5s, a future time,
  equal timestamps, a wrong nonce, wrong generation, wrong run ID or wrong boot ID.
- Output is one exact-key record under 16 KiB. Extra keys, a second record, or trailing bytes refuse.
- The sampler has a hard wall-clock limit well under 5s. The launcher kills it on timeout and
  refuses.

## Launcher rules, each with a removed-protection test

1. Identity read after spawn matches a second read at the check. A swapped pid refuses.
2. A sample with a wrong nonce, generation, run ID or boot ID refuses, one test per field.
3. A sample older than 5s refuses at `assertAdmitted` (operations.ts:75) and again just before the
   desktop create (line 100).
4. A malformed, oversized, truncated or duplicated record refuses, one test per case.
5. A sampler that exits non-zero or hangs refuses. Stderr is ignored by the spawn model
   (supervisor.ts:65-69), so it carries no verdict.
6. Two concurrent admissions each get their own nonce and neither accepts the other's sample.

## Still open, and why launch stays blocked

- The bound second phase. After create the watchdog needs a configuration that carries the container
  IDs, and the post-launch loader requires that configuration to be pinned before use. Where the
  binding comes from, without letting the host mint its own trust, is the next contract. Rule 8 of
  the prelaunch admission plan (post-launch sample within 10s) depends on it.
- The first complete healthy sample from the long-running watchdog's own journal before launch.
  This plan checks that the watchdog is alive and current, not that it has finished a sample cycle.
- Installed delivery of the watchdog and sampler binaries, and any runtime packet.

No security claim here goes beyond what the build proves with the tests above. The pipe ownership
claim in item 2 must be confirmed by reading how Node spawns the child before it is relied on:
the build opens the pipes itself and sets no inheritance of the launcher's other descriptors.

## Gates for the later build

Independent Security and Standards/Spec acceptance of this plan and of the exact final head.
Removed-protection failures observed and restored for each rule above. Full local gate through the
verify-gate skill. Green CI on the exact final head. No change to `unavailableAdmission`.
