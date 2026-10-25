# Computer prelaunch launcher

Plan with code that no production path calls. No Computer runtime, image, Docker, deployment or
production operation. `unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617,
#3618 and #3619 stay open. Builds on the
[prelaunch runner contract](2026-10-25-moss-computer-prelaunch-runner.md) (PR 3692).

## Scope

1. Close the two non-blocking notes on PR 3692.
2. Build the host-only launcher: start the `hold` watchdog, read its start-up byte, refuse any other outcome.

Out of scope: the `prelaunch` sampler body, the bound second phase and first healthy sample
(handover item 4), installed delivery, orphan `hold` cleanup and any runtime packet (item 5).

## 1. Hash covers what runs (note a)

Today the loader hashes `argv[1]`, the 3-line entry `scripts/computer-watchdog.ts`. That file
imports `main.ts`, `trust.ts` and more, so none of the real code is pinned.

- New `scripts/computer-watchdog/bundle.ts` builds one self-contained CommonJS file from the entry
  with esbuild (same approach as `scripts/computer-gateway/build.ts`). It returns the bytes and
  their SHA-256.
- The build refuses unless there is exactly one output and every import left in it is a Node builtin.
- The launcher spawns `node <bundle>`. The prelaunch configuration pins the bundle's hash, which the
  existing loader already checks against `argv[1]`. The loader needs no change.
- The bundle is the unit of trust. A source file changing changes the bundle hash.

## 2. Launcher owns the start-up channel (note b)

- The launcher creates the channel, passes the child end on descriptor 3 and keeps the other end.
  The child never learns of any other holder.
- A Node launcher cannot create an anonymous pipe. `spawn` with a `pipe` stdio entry gives a
  two-way socket pair. See the decision below.
- The launcher accepts exactly one outcome: the single byte `0x01` received within 7s of spawn,
  while the child is still the same process (pid, start ticks, group unchanged). Anything else
  (no byte, a different byte, two bytes, early exit, closed channel, identity change, timeout)
  kills the child and refuses.

## Decision: pipe or socket pair on descriptor 3

| Option | Mechanism                                               | Cost                                                                                |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A      | Socket pair. Loader asserts a socket instead of a pipe. | Loses the write-only flag check. Trust still rests on the launcher owning the peer. |
| B      | Shell wrapper makes a real pipe.                        | A helper process, not the launcher, owns the read end.                              |
| C      | Native helper makes the pipe.                           | New build and delivery burden.                                                      |

Recommendation: A. The write-only check never proved who owns the other end, and the ownership
test (below) covers that. Escalated to the coordinator; A is built unless told otherwise.

## Tests (each seen failing with its protection removed)

- Bundle: contains code from `main.ts` and `trust.ts`; has only builtin imports; hash changes when
  an imported file's content changes (fixture tree); refuses a non-builtin import.
- Ownership: the launcher's own end of the channel is open in the launcher and the child holds only
  descriptor 3. A launcher variant that does not keep its end (or hands the child an end it cannot
  distinguish) fails the test.
- Outcomes: only one byte `0x01` in time with an unchanged identity is accepted. Each other outcome
  above refuses and kills the child.
- Spawn shape: detached, stdio `ignore, ignore, ignore, channel`; removing `detached` fails.
- Real end-to-end run on this host with the real bundle where the host allows it.

## Gates

Independent Security and Standards/Spec acceptance of the exact final head. Removed-protection
failures observed and restored. Full local gate through the verify-gate skill. Green CI on the
exact final head. No change to `unavailableAdmission`.
