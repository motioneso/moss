# Vocci replacement observer correction — 2026-10-24

Task #3565; #3584 remains open. Production preparation plan `c42c8a5ce` and
observer-correction amendment `4b8f82dcc` preceded implementation. Baseline:
`6960c0c6af7c357eaac6f5d521d01d767ce6bd4e` (#3625).

## Finding and correction

The original observer selected whole dump blocks if they contained the package
and replacement action anywhere. An unrelated block's trailing historical summary
could contain both. It then searched joined selected blocks for the receiver name
and DELIVERED independently. Neither matched the target receiver's actual state.

The new `replacement_broadcasts.py` selects the actual BroadcastRecord header and
Intent's exact action/package, removes trailing historical summaries and reads
DELIVERED only from the exact receiver/package's own delivery-state section.
`recovery.py` uses that parser while retaining its existing new-record, device,
signature, persistence and cleanup guards. No product Java or manifest changed;
no user-visible product behavior or app-map change follows.

Seven standard-library tests exercise valid exact delivery, summary contamination,
PENDING/SKIPPED beside unrelated delivery, another receiver in the same record,
exact action/package and receiver names, and a PENDING→DELIVERED transition.
The original extracted logic exited 1 with four failing tests; corrected logic
exited 0. Both logs are retained privately. `apps/vocci-delivery/test.sh` now
executes this regression suite in the Android CI path.

## Retained real-path evidence

The corrected parser was run against the actual retained private device dumps,
without device mutation, response substitution or receipt rewriting:

| Original case     | Exact target records | Exact receiver state               | Corrected dispatch verdict |
| ----------------- | -------------------- | ---------------------------------- | -------------------------- |
| Enabled           | 1                    | PENDING                            | Fails                      |
| Disabled          | 1                    | SKIPPED (`mBroadcastConsumerSkip`) | Fails                      |
| Permission denied | 1                    | PENDING                            | Fails                      |
| Missing action    | 0                    | Absent                             | Fails                      |

These are reevaluations of original observations, not fresh OS dispatch tests.
The historical service and stored-data observations remain separate; their
association with a successfully delivered target receiver is unproved. The
earlier dispatch acceptance and product-fix kill-gate conclusion are withdrawn.
The predecessor independently confirmed these exact target states and published
[PR errata](https://github.com/motioneso/moss/pull/3625#issuecomment-6380011834)
and [task errata](https://github.com/motioneso/moss/issues/3565#issuecomment-6380011952).

## Production preparation and limits

After explicit predecessor ownership transfer, the authorized phone's current
network endpoint was rediscovered through its exact paired service and its
physical serial verified privately. Read-only preflight observed Android API 37,
installed release 20261025, the existing real delivery service and original
120000 ms screen timeout. After Ben unlocked the phone, actual native diagnostics
reopened saved setup/account and showed delivery enabled, hold/cleanup off, and
three existing queue entries (two complete, one failed). No Start or retry ran.

All five existing host suites and the development APK build passed. Release
20261026 built successfully; APK SHA-256:
`48827ff532cedbd77438f9306399fdb74cc2337357dc3145776ec1f0173e2a4c`.
Its certificate matched the installed companion, all 34 packaged Java sources
matched reviewed merged source, and the actual release manifest disabled
debugging/cleartext and omitted instrumentation. **The candidate was not installed.**
Original official-app Nearby devices revocations and phone timeout were retained.
Two incomplete UI observers are retained separately; smaller, slower scrolls then
captured and asserted all required native controls. They are not replacement runs.

There is no new production replacement, interrupted upload, reboot/unlock,
offline/out-of-range, ASR, hold or endurance acceptance. The next verified fresh
session must use strict dispatch evidence before any post-update UI/manual Start,
preserve a failing observation and investigate it before changing product recovery.
Independent review and required CI results belong on the correction PR.
