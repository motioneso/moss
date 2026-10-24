# Vocci enabled package-replacement diagnosis — 2026-10-24

Task #3565; plan
`docs/superpowers/plans/2026-10-24-vocci-enabled-replacement-proof.md` was committed
as `a91ad3eb49d2f09817c1a72ea91c70f1a3f53cf5` before implementation.
Starting main: `fa6e5ed51b8eb4bec5ed011fde83e761f3c69547` (#3622).

## Result and limits

Actual versioned replacement of the disposable upgrade-proof package dispatched
the unchanged production recovery receiver and started the real foreground
service on the authorized Android API 37 phone. The real service reached its
stored retry state against generated credentials and a closed HTTPS loopback
origin. Source identity, exact queue/voice state, encrypted configuration and
retained evidence hashes were unchanged. This is an installed OS dispatch/service
diagnostic, not a real ring/account/upload or production update acceptance.

The unmodified receiver passed, so the plan's kill gate ended the product-fix
line. No production Java or manifest changed. The historical production
`mBroadcastConsumerSkip` cause remains unresolved. Older AOSP source uses that
token as a generic queue-cleanup reason; it does not establish this phone's cause.

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

| Case                               | Exit | Android dispatch | Real service | Stored outcome                              |
| ---------------------------------- | ---- | ---------------- | ------------ | ------------------------------------------- |
| Enabled, Nearby devices granted    | 0    | Delivered        | Present      | `retry_pending` at closed loopback endpoint |
| Disabled                           | 0    | Delivered        | Absent       | `stopped`; disabled choice retained         |
| Enabled, Nearby devices denied     | 0    | Delivered        | Absent       | Actual Nearby devices recovery advice       |
| Enabled, replacement action absent | 1    | Absent           | Absent       | `os_dispatched_replacement_receiver` failed |

Each successful case compared source identity, queue, voice and immutable file
digests before/after replacement. Every installed case, including the failed
negative control, removed only its owned disposable package and confirmed absence.
The negative receipt stays failed; it proves the observer detects a missing OS
recovery path rather than merely successful APK installation.

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

Private build/observer/broadcast receipts remain outside git. The next bounded
slice is actual production signed-replacement verification including the merged
exclusion correction, followed by the remaining recovery queue. See
`docs/superpowers/handoffs/2026-10-24-vocci-production-replacement-continuation.md`.
