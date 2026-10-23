# Installed upgrade persistence proof

This optional developer proof builds unchanged production Java sources as
`ai.moss.vocci.upgradeproof`. It refuses to reuse an installed package. The
fixture creates only generated silence, a partial download, frozen normal/voice
uploads, failed/interrupted/completed entries and dummy encrypted configuration.
It never signs in, connects to a real account or ring, or alters the existing
companion. This is persistence proof, not product setup or resumed physical
transfer proof.

Build an immutable pre-wizard source snapshot and the reviewed candidate with
the same disposable signing key, into private directories outside the repo:

```sh
python3 apps/vocci-delivery/upgrade-proof/build.py \
  --source "$BASELINE_SOURCE/apps/vocci-delivery" --out "$PROOF_OUTPUT/baseline" \
  --key "$PROOF_OUTPUT/signing.keystore" --version 1
python3 apps/vocci-delivery/upgrade-proof/build.py \
  --source "$CANDIDATE_SOURCE/apps/vocci-delivery" --out "$PROOF_OUTPUT/candidate" \
  --key "$PROOF_OUTPUT/signing.keystore" --version 2
```

Claim a port with `devports claim vocci-upgrade-proof`; create no listener or
reverse. Pass that port and the explicitly authorized phone serial to `run.py`
using `--port`, `--serial`, `--baseline`, `--candidate`, and a fresh private
`--out` directory. Release the reservation afterward. The runner validates APK
package IDs and digests before installation, records each checkpoint/assertion,
and removes only its own disposable package even on failure.

Actual APK replacement must preserve encrypted configuration, Keystore
decryptability, partial/frozen bytes, source identity, queue state/destinations
and voice enrollment. An unlocked phone is required for actual configured
launcher/Ready traversal and native Start/Stop. Service restart uses a closed
HTTPS loopback origin with dummy credentials; it must fail before owner
confirmation, voice requests, upload or Bluetooth access. Only activity/failure
metadata may change. The upgrade/service path does not mock or intercept Moss
responses; the separate selection contract uses disclosed synthetic link responses.

The manifest retains production receiver declarations. The stopped-install
replacement tests that package replacement does not start disabled delivery;
it does not establish physical boot or enabled background recovery endurance.
The final empty-package selection contract exercises the candidate's actual
Choose another ring control. Its existing proof-package guard is adapted only
to this distinct disposable app ID; the source digest is retained in the build
receipt. Synthetic link responses remain confined to that disclosed contract.

Keep private receipts outside the repository. Record exact source/APK inputs,
passed assertions and limits on the PR; never turn an earlier failed observer
into a passing receipt.

## Recorded checks, 2026-10-23

Baseline source: `7acb4b6b052e06f1b0162f6a1c0bc8b3d8136a7e`.
Candidate product source: `901260d7ea8cea9145fc8f9b513df6be8f6086d4`.
Both APKs use the same disposable signing certificate. Exact APK SHA-256:

| Input     | SHA-256                                                            |
| --------- | ------------------------------------------------------------------ |
| Baseline  | `57f7edc9932c05aaaf96c433d92434ea7866237df258dd43da2ba90100fe5096` |
| Candidate | `496d926fb604f7e6d1f8b7aaccf89edd520cad5ba4d36c997ec70889731856d6` |

Private receipt `run-02` passed actual baseline installation, generated fixture
initialization, APK replacement, encrypted/partial/frozen file digests, source
identity, queue/destination and voice-enrollment equality, and post-upgrade
Keystore decryption. It then failed explicitly at `phone_unlocked_for_actual_ui`
because the phone was locked. The owned package was removed and its absence
confirmed. This partial receipt makes no native UI or service-restart claim.

A separate simulated subprocess control injected installer and force-stop
timeouts. The runner still attempted uninstall, confirmed absence and saved a
failed receipt. That control used no device commands and does not count as
installed product evidence. The initial preflight attempt also found Android's
empty-output exit code 1 for an absent package; the presence check now accepts
that case while rejecting transport error output.

Private receipt `run-04` then passed **26 named assertions**, exit 0, with the
same APKs. Actual configured launcher → Ring setup/Ready skipped sign-in and
retained the hold choice without starting delivery. Actual Start reopened the
generated queue and reached the expected closed-loopback connection failure;
native Stop and process relaunch retained every immutable digest and left
delivery stopped. A fresh installation of the candidate then passed the actual
Choose another ring UI contract: Moss approval retained, lookup reachable again,
discarded candidate unable to verify, and no configuration published. The owned
package was removed with absence confirmed; the temporarily extended screen
timeout was restored to its observed value. No production package, official-app
grant, owner sign-in, real recording or ring operation was involved.

The first unlocked attempt failed at the harness's implicit activity launch.
The corrected runner obtains the actual launchable class from APK badging,
checks the disposable manifest's exported declaration and starts that explicit
component. Package-manager resolution independently identified the same
`ai.moss.vocci.DeliveryActivity`. No production source or APK changed for this
harness correction. Earlier failed receipts remain failed. Enabled recovery,
physical reboot and resumed real pending transfers are not claimed.

The initial host builds failed before APK creation because the Android D8
wrapper could not find Java. The build script now supplies the selected JDK to
both `JAVA_HOME` and `PATH`; subsequent baseline and candidate builds passed.
The old `run_17` observer remains failed with its original unknown assertion
boundary. This replacement evidence covers the synthetic persistence seam;
earlier real physical setup/Meeting/Main observations remain separate proof.
