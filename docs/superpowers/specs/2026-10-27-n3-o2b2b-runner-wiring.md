# N3 O2b2b: runner wiring and guard release

Status: approved by Ben on 2026-10-27 ("let's fix this, I want to get this all done up").
Issue: #3529. Stacks on PR #3793, which restored the offline N3 tooling.

## Problem

`tests/uat/run-scheduled-read-terminal-uat.ts` carries an unconditional guard,
`requireFallbackObserver()`, in its launch, gate and worker paths. It always throws
`N3_FALLBACK_OBSERVER_UNAVAILABLE`, so the live proof for scheduled-read terminal
creation can never run. The guard stays until a complete correlated observer exists.

The observer pieces are built and tested offline: the in-API attempt observer, the
pinned bootstrap, the lifecycle record producer, the installed-image collector
(`InstalledCollector`) and the socket consumer (`N3ObserverConsumer`). None of them is
connected to the live runner or to the real-UI spec. That connection is O2b2b, and the
prior spec held it as a separate lease.

## Scope

1. Worker wiring. The worker builds independent expected pins, passes the observer
   option and the collector into `provisionForUat`, and opens the consumer after
   provisioning succeeds.
2. UI connection. The real-UI spec brackets each chat turn in an observer window
   (two terminal windows and one harmless positive) and hands the runner
   completion receipts.
3. Teardown and time box. Twelve-minute run, two-minute cleanup, credentials removed
   before volumes, uncertain ownership retained and reported.
4. Guard release. `requireFallbackObserver()` is removed in the same change that makes
   it truthful. The pinned base commit moves to current main and the thirteen frozen
   source pins are re-frozen after reading what changed on main.

## Design

### Pre-chosen identity

The collector rejects any project name other than the one in its authority record, and
the provisioner picks a random suffix. A small provisioner seam accepts an optional run
id so the worker can choose the project name before provisioning. Omitting it keeps
current behavior.

### Independent expected pins

The worker computes these before provisioning, not from the observer: lifecycle nonce
and directory identity, its own process identity (the lifecycle producer), the source
freeze (commit, tree, build input fingerprint, root identity), the container daemon
identity, the claimed port, compose file hashes, the image reference, volume names and
the database boundary. The collector and consumer compare observed values with these.
An observer-reported value is never accepted as its own pin.

### Window protocol

The browser test runs in a child process. It cannot call the consumer. The worker and
the test exchange small files in the private evidence directory: the test writes a
window-open request with the actor, thread and mode; the worker opens the window and
writes an acknowledgement; the test runs the turn; the test writes the completion
receipt (HTTP status, UI finish) and the worker closes the window with it. The test
waits for the acknowledgement with a bounded timeout and fails closed.

### Verdict

The run passes only when the Playwright run exits zero, every window closed with a
complete attestation, the observer never went red, cleanup reported zero errors, and
the terminal-creation windows show no unexpected provider attempts. Any uncertainty
retains owned resources and exits nonzero.

## Slices

Each slice fits one session and shares one branch and one pull request.

| Slice | Content                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| a     | Provisioner run-id seam, worker pins, collector and consumer construction, open and close, worker-level fake controls |
| b     | Window handshake between worker and spec, completion receipts, two terminal windows and one positive                  |
| c     | Time box, teardown ordering, credential removal, retained-resource reporting                                          |
| d     | Guard release, base and pin refresh, re-freeze of the frozen source map, self-test rewrite                            |

## Safeguards

- A fresh reviewer session, not the author, reviews the result before merge.
- The guard is released only in slice d, after slices a to c are reviewed as fake controls.
- No faked data and no intercepted responses in the live run. Real chat path only.
- Real-model parts use the CLI subscription sign-in and the cheapest model, never API keys.
- No change to app behavior, so no app-map entry changes.

## Out of scope

Product code changes, other UAT specs, merging, the full nine-case UAT list.
