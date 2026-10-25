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
test (below) covers that. Coordinator approved A provisionally. It is not final until a fresh
Security reviewer accepts it. If the reviewer rejects A, work stops and is reported.

### Amendment to the runner contract (section 4, PR 3692)

The contract says descriptor 3 is "a pipe write end held by the launcher" and that the loader
asserts `pipe:[n]` and a write-only open mode (trust.ts `assertHoldDescriptors`). This amendment
replaces that with a socket pair.

Why a pipe is not possible from Node. Observed on this host: `spawn` with a `pipe` stdio entry
gives the child `/proc/self/fd/3 -> socket:[n]` with open flags `02` (read-write). Node has no call
that makes an anonymous pipe, so a Node launcher cannot hand a child `pipe:[n]`. An opened FIFO
shows as a path, not `pipe:[n]`.

What A loses.

- The write-only check. A socket end is read-write, so `hold` could read from the launcher's end
  and the launcher's end could be written by anything holding it. The old check also never proved
  the launcher holds the other end.
- The distinct `pipe:[n]` shape. Any socket now passes the shape check, so the shape no longer
  separates the launcher's channel from a socket inherited some other way.

What replaces it.

- Loader asserts descriptor 3 is `socket:[n]`. The rest of the descriptor rules stand.
- The launcher creates the channel and keeps the peer. The launcher accepts the byte only from its
  own end, only as exactly one `0x01`, only within 7s, and only while the child identity is
  unchanged. Trust in the byte rests on the launcher owning the peer, as it did for the pipe.
- A test proves ownership: it fails if the launcher does not hold its end, or if the child ends up
  with a second route to the peer.

Open for the Security reviewer to attack.

1. Can any process other than the launcher write the byte, given only the child holds the other
   end and the launcher keeps its own? Does the read-write socket give `hold` or a descendant any
   capability the pipe did not?
2. Does `socket:[n]` on descriptor 3 let an attacker who controls the child's inherited
   descriptors pass a socket from elsewhere (for example a connection to another process)? Is the
   launcher-side identity check enough to stop that?
3. Is option B or C needed for the first real caller, even if A is acceptable for this host-only
   slice?

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
