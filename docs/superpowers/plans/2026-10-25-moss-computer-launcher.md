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

### Amendment: the acknowledgement ends with the child closing its end (#3710)

The acceptance above was implemented as "one byte, decided at the 7s deadline". That decision
races the event loop: a second byte written just after the first can still be waiting for
delivery when the deadline fires, so the launcher accepted a child it should have refused. This
was seen as a unit test that failed at random on CI, never on a rerun.

The message now has a terminator. The child writes the one `0x01` byte and then closes descriptor 3. The launcher reads until end of file and accepts only a stream of exactly one `0x01` byte that
ended before the deadline. A socket keeps byte order, so everything the child wrote arrives before
its end of file, whatever order the event loop dispatches events in; nothing after the end can
arrive at all. The deadline now bounds how long the whole message may take instead of deciding
the message halfway through it. "Closed channel" above still refuses: an end of file with no byte,
or with any byte other than one `0x01`, kills the child. Closing descriptor 3 after the
acknowledgement changes nothing else: `hold` never uses the channel again, and liveness stays
with the parent-pid poll.

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

What A gains. A pipe write end can be reopened and written through `/proc/<pid>/fd/3` by any
process that may open that path. A socket cannot be reopened that way, so the child's end cannot be
re-attached by a third process.

What neither option covers, and A does not change. The launcher does not verify the bundle file
or the node binary it spawns, and it cannot see the child call exec. A child that has exec'd into
different code can still write the byte. The identity check (pid, start ticks, group) does not
detect an exec. Launcher-side verification of the bundle and node path must be built before the
first real caller exists. Until then this slice proves only that the process the launcher started
wrote the byte, not what code it is running.

What replaces it.

- Loader asserts descriptor 3 is `socket:[n]`. The rest of the descriptor rules stand.
- The launcher creates the channel and keeps the peer. The launcher accepts the byte only from its
  own end, only as exactly one `0x01`, only within 7s, and only while the child identity is
  unchanged. Trust in the byte rests on the launcher owning the peer, as it did for the pipe.
- A test proves ownership: it fails if the launcher gets no end of the channel. It does not prove
  that no other process holds the peer.

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

- Bundle: contains code from `main.ts` and `trust.ts`; fails the build on an import it cannot bundle; hash changes when
  an imported file's content changes (fixture tree);
- Ownership: a launcher that gets no end of the channel (child given `ignore` on descriptor 3)
  refuses, and a launcher that never reads its end accepts nothing.
- Outcomes: only one byte `0x01` in time with an unchanged identity is accepted. Each other outcome
  above refuses and kills the child.
- Spawn shape: detached, stdio `ignore, ignore, ignore, channel`; removing `detached` fails.

## Gates

Independent Security and Standards/Spec acceptance of the exact final head. Removed-protection
failures observed and restored. Full local gate through the verify-gate skill. Green CI on the
exact final head. No change to `unavailableAdmission`.
