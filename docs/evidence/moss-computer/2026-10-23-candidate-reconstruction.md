# #3578: candidate reconstructed and retained

- **Outcome:** one new image built, inventoried and archived. Desktop/recovery runtime NOT_RUN.
- **Operator/finish operator:** Codex `/root`, active attendance; no Ben manual acceptance.
- **Independent reviewer:** `/root/independent_review2`, no authorship. Exact-artifact adoption
  verdict belongs in the [review ledger](2026-10-23-independent-review.md).
- **Packet:** [Dispatched reconstruction](../../superpowers/plans/2026-10-23-moss-computer-candidate-reconstruction.md).
- **Receipts:** [Sanitised source/build/archive comparison](2026-10-23-candidate-reconstruction.json).

## Decision and identity

Submit the new image for limited adoption into a later recovery trial. The earlier missing-image
[preflight](2026-10-23-recovery-qualification.md) remains a historical failed attempt; the original
image was not restored and its disappearance is still unexplained. No prior runtime acceptance
transfers to this rebuild.

New Linux/amd64 image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Retained local tag: `moss-computer-qualification:reconstruct-20261023-r2-candidate`.
Source at build: `1ed0fd7da`, with the same seven tracked candidate-file hashes as the earlier trial.
Private derived Dockerfile adds exactly one `com.moss.build` label after the pinned Debian FROM;
its hash and precise derivation are recorded. No tracked desktop code or configuration changed.

## Evidence and limits

| Case                | Result                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prebuild controls   | Independent static readiness PASS. Tiny diagnostic used an already installed immutable image, no network. Actual cgroup readings: memory4 GiB, swap0, CPU quota200000/period100000. Label inherited by RUN container.                                                                       |
| Cancellation        | PASS: intentionally interrupted diagnostic client exited143; supervisor exited0 after verified removal and repeated empty label checks. Diagnostic intermediate image removed.                                                                                                              |
| Desktop image build | PASS: resource-capped legacy Docker builder, finite build client exit0, supervisor exit0, 85.73 seconds including closure. Observed both substantive RUN containers with expected label and limits.                                                                                         |
| Package comparison  | All400 installed Debian package/version records match the final prior `packages-r2.txt` byte for byte, SHA-256 `a0a10591fccf4b375ea47e9ba44b7854c60571f43db388c95472dc505cf07fc9`. Websockify Name/Version/Requires unchanged at0.13.0.                                                     |
| Source bytes        | Packaged entrypoint, fixture and hash-pinned requirements match tracked source bytes. Installed-option build checks completed. No viewer upgrade or browser/security relaxation.                                                                                                            |
| Image configuration | User, environment, JSON-array entrypoint and command match. Observed differences: added run label and `ArgsEscaped` true→absent with the legacy builder. Linux runtime equivalence has not been exercised. Image history/layers and identity differ.                                        |
| Inspection          | Files copied from an explicitly created container with status `created`, PID0; never started, then removed. This establishes filesystem/configuration facts, not desktop usability.                                                                                                         |
| Retention           | Tagged image plus private `candidate-image.tar`, 1,026,041,856 bytes. SHA-256 `48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`. Archived config hash equals the image ID; every uncompressed layer digest matches and tar members were read without extraction/execution. |
| Closure             | Zero checkpoint build/inspection containers. Build clients and supervisor exited. No desktop, viewer, listener, port reservation or keys created. Previous synthetic home preserved; Moss running and healthy.                                                                              |

The deprecated builder was chosen for installed, explicit RUN memory/CPU controls and exact-label
cancellation. This is a run-specific diagnostic/build mechanism, not a reusable proof-tool program
or shipping packaging choice. RUN caps do not cap Docker daemon/base-pull work. Headroom and
sampled storage/log thresholds were monitored; they are not hard disk quotas. No shared builder,
daemon, image cache or production service was stopped/pruned.

Fresh host snapshots before/after: available RAM17,459/18,030 MiB; root free13,522/13,475 MiB;
data-filesystem free987,066/985,137 MiB. Swap was substantially used throughout. These are host
snapshots, not desktop workload measurements or supported-device minima. Apt inputs remain mutable;
matching inventories do not establish reproducible builds or identical package-file bytes.

The final old inventory is `packages-r2.txt`: `packages.txt` describes an earlier image and lacks
four later package records. This baseline distinction was resolved before comparison. An initial
BuildKit history lookup with a full composite reference failed; its short record ID recovered the
old configuration attachment. Neither that attachment nor the prior source was treated as an
available image. No build/recovery success was fabricated from metadata.

## One next proposal and stop

Propose one amended [recovery qualification](../../superpowers/plans/2026-10-23-moss-computer-recovery-qualification.md)
on the same server, pinned to the new adopted image and unchanged Compose/gateway source. Codex
`/root` remains the proposed active automated finish operator; the independent reviewer must not
author corrections. This report does not dispatch runtime.

Before launch, independently review the amended exact packet, fresh host headroom, new run label,
ephemeral proof identities, listener reservation and fail-closed supervisor. Keep the existing guest
2CPU/4 GiB/512PID and gateway0.5CPU/128 MiB/32PID limits, offline guest, read-only roots and default
container protections. Establish substantive baseline rendering/input and affected access/isolation
checks for the new image before crashing it. Diagnose the failed page while open; do not call a
rendering timeout a transport failure. Require a fresh substantive recovered frame and new keyboard
marker, recording the exact recovery action. Preserve failures; two identical failures require a
scope decision. No automatic stack update or security weakening.

Finish actively before60 minutes with heartbeat/deadline/resource safeguards, stop/remove only the
new labelled runtime, release its reserved port, remove ephemeral keys and retain designated home
and this archive. Return independent exact-result review and stop before Moss integration. Existing
owner/session/download, persistence for the rebuilt image, Internet/manual remote and release gates
keep their own evidence requirements. #3578/#3577 remain open and PR3579 draft; no guide stage or
task is marked complete by this checkpoint.
