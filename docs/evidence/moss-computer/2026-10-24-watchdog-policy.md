# Computer watchdog decision policy evidence

Part of #3618/#3616/#3577. Base `5b10880d016b61f280140c3359c8aad1ad54c0db` (merged packaging
PR#3640); accepted source `708d6a585ed4e920c26f16d19bc4e6cf33c64763`. The
[machine receipt](2026-10-24-watchdog-policy.json) records exact source/test/plan hashes, commands,
exits, immutable review hashes and both removed-protection rounds. The
[plan](../../superpowers/plans/2026-10-24-moss-computer-watchdog-policy.md) and
[successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-supervised-watchdog.md)
preserve independent review → fixes → exact checks/evidence/CI → merge → verified fresh isolated
successor until actual owner integration finishes. No production deployment.

## Implemented and verified boundary

This is a pure **supplied-metadata decision policy**, not an independently running watchdog or
launch admission. It owns strict complete samples, copied distinct process identities, fixed
monotonic run/heartbeat/sample bounds, memory/disk floors, combined home/socket limit, health/log
flags and frozen permanent terminal decisions. Matching supplied metadata does not prove actual
OS identity or independence. No collector, scheduler, supervisor, receiving invalidator, durable
stop-intent writer or cleanup executor is implemented. Host unavailableAdmission and normal API
boot remain unchanged. No product app-map capability or deployment requirement changes.

The actual exported policy is exercised with deterministic clocks and boundary vectors: waiting
until the first complete sample, exact floors, dead/zombie/replaced/missing identities, run mismatch,
invalid/missing/extra/symbol/accessor measurements, unsafe/nonfinite values, stale/future/duplicate
timestamps, backward clock, sample expiry, independent heartbeat, fixed run deadline, operator stop,
first-reason retention, configuration/sample mutation and inspection reentry. This policy execution
is the internal slice's end-to-end seam; it is not live supervision or resource closure.

All three focused files pass **168 tests**: 125 new policy vectors and 43 existing host/client
regressions. Existing host tests use real private Unix IPC and recording Docker HTTP stand-ins.
Final root and tests TypeScript, scoped ESLint max-warnings0, scoped Prettier, file-size and
whitespace checks all exit0. Final checks ran after R2 controls against unchanged before/after
source/test/plan hashes; those final stable-byte checks are authoritative. Initial checks and
the earlier 163-test green source remain retained, including initial TypeScript completion
collected after first-round controls. The scoped frozen offline install already included the
worker dependency set; manifests and lockfile are unchanged.

## Independent review ledger

All reviewers were independent/read-only and authored no fixes; they reviewed pinned Git blobs
while controls temporarily mutated the working source. No disputed blockers remain.

- Plan R1 accepted the bounded contract with a nonblocking discovery-account correction. R2
  accepted exact `1e0ddde4c` before implementation.
- Source R1 on `6d85512d5`: Standards passed. Spec/security found that successful Proxy inspection
  could reenter stop and then overwrite its terminal decision; security also found a constructor
  getter could change validated start time before storage and bypass deadline comparisons.
- Both findings were accepted. Source `708d6a585` snapshots constructor own data/rejects accessors;
  all untrusted sample/process inspection precedes a second clock/terminal check and current
  measurement-history validation. Five regression vectors cover getter noninvocation, stop reentry
  at top-level/runner/watchdog, and newer nested clock/sample history. Standards, Spec and security
  R2 accepted exact corrected source. Immutable R1 reports remain retained.

Exact final evidence acceptance and required green CI remain separate premerge gates.

## Intended removed-protection failures

All controls exit1 at their intended assertions, admitting a state or configuration that the
selected assertion rejects. No compiler error, timeout or unrelated failure is counted. Policy bytes were restored
after every control. The final full suite passes on the restored committed source.

| Removed protection            | Intended observed failure                            |
| ----------------------------- | ---------------------------------------------------- |
| Resource-floor stop           | Each below-floor sample returns healthy              |
| Terminal activity checks      | A later sample replaces the first terminal reason    |
| Process/run identity stop     | Changed/dead/zombie/missing metadata returns healthy |
| Heartbeat independence        | Samples renew heartbeat past the 90-second bound     |
| Pre-update expiration checks  | A late sample revives an expired sampling interval   |
| Post-inspection state recheck | Successful reentrant stop is overwritten by healthy  |
| Constructor own-data snapshot | Changing accessor configuration is accepted          |

Five controls were first run against original source, then all five plus the two review-regression
controls against corrected source. JSON preserves every mutant/original/restored/log hash and exact
command. The constructor control restores the exact original constructor body. Private scripts
record the precise mutations; no runtime authority or test bypass was added to production source.

The supplemental independent replay retained an initial overly specific reentry-harness expectation,
then passed 20 corrected direct-blob vectors. Two draft evidence-assembly assertions misclassified
the constructor throw-assertion log; their correction and the resulting initial missing-JSON format
failure are retained. These harness failures are distinct from candidate source/test results.

## Resources and required continuation

No Docker/image/real guest/DB/browser/TCP server or production operation occurred. Only ordinary
check processes and existing Unix host/client fixtures were started; owned fixture sockets closed.
Accepted r21 persistence was reused without requalification; original r12/r18 causes remain unknown.
Private logs/state/review receipts remain outside ~/Jarv1s in a sibling directory.

Actual root-trusted independent measurement/supervision, synchronous receiving invalidation and
independently verified closure must be accepted before replacing unavailableAdmission. Preserve
exclusive lock/stop intent, immutable full IDs/creation generations, request CAS, pending intents,
root identities and retained failed-cleanup identities; explicitly design unresolved-intent recovery.
Known-ID inspect404 alone reconciles absence. Disable gateway first, retain home, never delete volumes.

Before any image/runtime operation, independently accept a separately committed exact packet and
verify fresh healthy Moss, RAM/root>=8GiB/data>=30GiB and an independent alive watchdog with its first
complete sample. Inherited exact identity/labels, <=1800s run, <=90s heartbeat, nominal5s sampling,
fail-closed measurement/log/home+socket limits, bounded isolation and exact independent closure
remain mandatory. Packaging is not an accepted gateway image/Node24/128MiB fit; TigerVNC, installed
fixed lifecycle and actual owner HTTPS/WSS/chat remain open. Keep parent issues open. After actual
merge, launch and verify a fresh isolated successor with the same continuing authority and gates.
