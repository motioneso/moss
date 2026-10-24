# Trusted stopped-pair provisioning evidence

Part of #3618/#3617/#3616/#3577; #3619 remains open too. This is opt-in PREPARE tooling only.
The actual owner integration, installed runtime and launch admission remain unfinished.

Checked source `c53d88263e0d1cdd94c493b810769c103b371f86` descends from accepted plan
`7e933ce9d8314aeac3cceb0894eea2a96f4338c7` and base `1a79c74b4cf4800740340617c67496f70fa762e1`.
Production bytes equal `5df491e4f0a8d69e368a111854a68cf9a6bf0c08`; the final source commit only
isolates publication-close fault injection from consumers and teardown. Both independent reviewers
accepted exact source c53d88263e for Security and Spec/Standards. The
[JSON manifest](2026-10-24-trusted-provisioning.json) records all ten source/test hashes, exact
commands/exits, bundle hashes, 19 sensitivity controls, native summaries and private report/log hashes.
Raw configuration bodies and generated lifetime secrets are excluded.

## Result and trust boundary

The actual publisher acquires existing canonical state, requires exactly both durable full IDs
and their creation generations, and observes an exact never-started Docker pair. It generates one
random lifetime, exclusively publishes supervisor0600 and root-delivered gateway0640/GID1000
configuration, reads both through their actual consumers, and durably publishes a binding/hash-only
prepared receipt. File/directory fsync, close, repeated config/root/state/publication/inventory checks
and the final synchronous stop/deadline checks precede canonical lock release. Failed open/state,
partial persistence, changed inputs or output, stop and expired/interrupted runs retain lock paths.
Retained locks require explicit separately accepted recovery; this tooling never retries or resets.
A prepared file alone cannot authorize launch; successful native completion and separate runtime
admission remain mandatory. The existing launcher and unavailableAdmission remain unchanged.

The gateway reader's additional delivery layout is root-owned0750/GID1000 parent and root-owned
0640/GID1000 file with trusted canonical ancestry; legacy private layout remains supported.
Generic socket-parent policy is unchanged. This internal executable adds no product/app-map
capability, dependency, deployment configuration or default.

## Executed checks

All twelve final checks exit0 at checked source: **592 tests in28 suites**, including46 provisioning
tests; root and tests TypeScript; scoped ESLint zero warnings and Prettier; file-size and whitespace;
provision/host/watchdog/closure builtin-only CJS bundles targeting Node24; gateway context build.
The context build invokes no Docker. An additional actual production CJS nativeUID1000 invocation
silently exits2 with empty stdout/stderr. Native timing and exact hashes are in the JSON manifest.
No foundation or database checks were run.

The 19 final protection-removal runs each exit1 at an intended assertion: strict created State,
complete pair, state inode, failed-open lock retention, publication readback, late stop, equality,
signal latch, artifact revalidation, root-delivered gateway mode, file/directory fsync, file close,
lock descriptor close, native timer, post-sync equality, premature signal exit, reset timer and
namespace anchoring. Every patched source restores byte-for-byte before the final green batch.
Private patches/logs and restored hashes are retained. Earlier rounds are retained: R1 patch driver
stopped at an ambiguous close anchor; R2 close removal failed through consumer/teardown injection,
which was corrected before the final intended-assertion R3 run. Source review R1 findings were
corrected; R2 and the final test-only R3 were independently accepted.

Native tests run the actual production CJS publisher and actual root/gateway consumers. They include
success plus held file/directory fsync with repeated TERM/INT, a scaled2000ms native timer and
measured1995–2700ms bounds from child timer creation. Signals spread across the interval distinguish
absolute expiry from reset timers; the premature-exit and reset-removal controls fail these bounds.
External SIGKILL is test safety only and cannot satisfy exit2/no-signal assertions. Raw native argv,
UID, Node version, timestamps, streams, artifact hashes and completion status remain private.

## Limits and continuation

Root/runtime/namespace/Node-hash and Docker observations use disclosed OS/Unix fixtures. Actual
files, exclusive locks, Unix HTTP, detached runner, /proc identity, parsers, publication/fsync/readback
and native completion execute; none establishes installed root trust or container runtime admission.
Native tests use Node22. Node24 target metadata does not qualify Node24, the image or128MiB fit.
No actual Computer image/runtime/Docker/DB/browser/TCP server operation, installation or deployment
occurred. No production restart or persistence requalification; reuse accepted r21, r12/r18 unknown.

Next follow the [trusted capture dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-trusted-capture.md).
Actual post-start process/provenance capture must respect the managed root's existing lock. Installed
bootstrap/first healthy sample, signing/closure provenance, new-run/reset/uncertain-create quiescence,
real images/Node24/TigerVNC, API leases/dispatch and owner HTTPS/WSS/chat/hostile live acceptance
remain separately gated. All inherited runtime/resource/identity/deadline/isolation/Fence/closure
requirements continue. Exact final HEAD green required CI, independent supplemental acceptance,
protected actual merge and verified fresh isolated successor remain the release gates for this PR.
A merged prerequisite never completes owner delivery.
