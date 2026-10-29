# Vocci enabled package-replacement diagnosis — 2026-10-24

Task #3565; plan
`docs/superpowers/plans/2026-10-24-vocci-enabled-replacement-proof.md` was committed
as `a91ad3eb49d2f09817c1a72ea91c70f1a3f53cf5` before implementation.
Starting main: `fa6e5ed51b8eb4bec5ed011fde83e761f3c69547` (#3622).

## Result and limits

**Correction after #3625:** the dispatch assertion was a false positive. It joined
records selected partly through trailing historical summaries, then searched for
the receiver name and DELIVERED anywhere in that combined text. Unrelated delivery
could satisfy it. The exact enabled and permission-denied target records show
PENDING; the disabled target shows SKIPPED with `mBroadcastConsumerSkip`. Automatic
receiver dispatch is not established, and the earlier product-fix kill-gate
conclusion is withdrawn. Original receipts remain unchanged and superseded.

The installed service, stored outcomes and preservation checks below remain
observations from generated-data runs on Android API 37; they do not establish
that the named replacement receiver was delivered. No production Java or manifest
changed. The historical production skip cause remains unresolved. Older AOSP
source is reference material, not a description of this phone's implementation.
See `2026-10-24-replacement-observer-correction.md` for the parser regression and
strict reevaluation, and the [PR errata](https://github.com/motioneso/moss/pull/3625#issuecomment-6380011834).

## Inputs and executable observations

Both ordinary APKs built the same current production Java sources with the same
disposable signing key. The fixture generates its own encrypted configuration,
pending/frozen/failed/interrupted/completed entries and voice state. It does not
use production files. The negative candidate changes only the private manifest's
package-replacement action; production Java and fixture hashes match separately.

| APK                         | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Baseline, version 1         | `1766ca1be394bb70fa6d5d2fee1a4307ea8ffe57dc39769a68440c1e39fa3c2d` |
| Candidate, version 2        | `d53b7b9f03c3325e7f9b268bf6b405803eb809346ef2f2689dc22a1a73d3cea1` |
| Missing-action candidate, 3 | `e292a34d2704f6e9e45301ef6c43fcd3e3402714426f85172a3ffde927bbb811` |

The documented `recovery.py` command uses explicit authorized serial, private
APK/output paths, a claimed closed devport and one selected case. All ADB calls
carry that serial. No force-stop, shell broadcast, manual Start or instrumentation
occurs between fixture initialization and post-replacement observation. Only new
package-replacement records count.

| Case                               | Original exit  | Exact target state | Real service | Stored outcome                              |
| ---------------------------------- | -------------- | ------------------ | ------------ | ------------------------------------------- |
| Enabled, Nearby devices granted    | 0, invalidated | PENDING            | Present      | `retry_pending` at closed loopback endpoint |
| Disabled                           | 0, invalidated | SKIPPED            | Absent       | `stopped`; disabled choice retained         |
| Enabled, Nearby devices denied     | 0, invalidated | PENDING            | Absent       | Actual Nearby devices recovery advice       |
| Enabled, replacement action absent | 1              | No target record   | Absent       | `os_dispatched_replacement_receiver` failed |

The three originally green cases compared source identity, queue, voice and immutable file
digests before/after replacement. Every installed case, including the failed
negative control, removed only its owned disposable package and confirmed absence.
The negative receipt stays failed. It detects the absent action but did not
establish that the positive cases' dispatch assertion was sound.

Two earlier observer attempts stopped before device mutation: signature tooling
could not find Java, then the external-source negative copy exposed a fixture
provenance-map mismatch. The runner now sets the selected JDK and compares
production Java separately from the fixture. Those failed receipts remain failed.

## Checks and continuation

- Both ordinary builds and the missing-action build exited 0; signatures verified.
- All five existing host suites and the development APK build passed through
  `apps/vocci-delivery/test.sh` (exit 0).
- Python syntax compilation, scoped Markdown formatting and diff checks passed.
  Independent Standards/Spec review and exact-head CI are recorded on the PR.
- Production was not replaced or reconfigured. A read-only package check still
  reported release 20261025; phone timeout remained its original 120000 ms. No
  Bluetooth state, official-app permission or phone timeout change was made.
- No interrupted-chunk, reboot/unlock, offline/out-of-range, ASR, physical sample,
  production hold or endurance claim follows. #3565 and #3584 remain open.

Private build/observer/broadcast receipts remain outside git. Correct the observer
and acceptance interpretation before actual production signed replacement. See
`docs/superpowers/handoffs/2026-10-24-vocci-production-replacement-continuation.md`.
