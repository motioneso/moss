# #3578: isolated desktop qualification evidence

- **Date:** 2026-10-23 UTC.
- **Current result:** PARTIAL QUALIFICATION. Normal viewing/input, actual replacement persistence and isolated access checks pass. Crash recovery rendering remains unqualified; #3578 and #3577 stay open. No production or installed-product acceptance.
- **Operator/finish operator:** Codex `/root`, active automated supervision. Ben's manual and MacBook Air acceptance: NOT_RUN.
- **Spec:** [Persistent desktop](../../superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md).
- **Plan:** [Isolated qualification](../../superpowers/plans/2026-10-23-moss-computer-isolated-qualification.md).
- **Receipts:** [Bounded machine-readable result](2026-10-23-runtime-receipt.json). [Independent review](2026-10-23-independent-review.md).

## Decision and identities

Ben's later explicit full authority to plan and implement autonomously superseded the initial planning-only/missing-interface approval stop. Provider-agnostic implementation is authorised; passing runtime, security and review gates remains required. This trial implements no AI/provider route.

MC0 inspected source `8814c9b43101e40619cf1e89055cf4eab2a6ce04`; branch base `021fd9a0c`. The installed production image remains separate: `ghcr.io/motioneso/moss@sha256:74d2208c9c50e48465a177ff99b17e1bbb3e04bab2386d6a0268c922c4d8b8db`, with reported embedded commit `85fa42c1df7d1c69fe4ca2c83e34dac6da18f893`, not attested provenance. Installed Compose is under `~/JarvisProd`; it was not changed.

Actual trial image: `sha256:5516b80402f9f4122a8551c6417c197356d73808ddfcf4b78f664c10c1e56c3a`. Debian amd64 base manifest `sha256:ec31d744f83f4a73447ba045aaab9409997efe5cc706eca4890c1be36cc1606a`. Apt inputs are mutable; the image ID and source hashes identify the tested local candidate, not a reproducible build or platform certification. Packages: Firefox ESR 153.5.1, Xfce 4.18.1, TigerVNC 1.12, noVNC 1.3, Nginx 1.22.1; upstream Websockify 0.13.0 wheel pinned by SHA-256.

The selected host remains this server, Ubuntu 24.04/x86_64. Before resumed launch: 16,821 MiB available RAM, 10,927 MiB root free and 979,857 MiB Docker-filesystem free. Swap usage and unrelated host workload vary; snapshots are not benchmarks. No substitute machine, production volume or production network was used.

## Established design and observations

Desktop runs UID/GID 1000, `network=none`, read-only image root, no host devices/socket, all capabilities dropped, no-new-privileges, default Docker seccomp/AppArmor. Observed UID1000, zero effective capabilities, seccomp mode2 and `docker-default`; no non-loopback guest route. Representative metadata/private-address connects returned ENETUNREACH; guest localhost1533 returned ECONNREFUSED. These are bounded checks, not universal network certification.

An isolated Nginx gateway serves packaged immutable noVNC assets; only the WebSocket backend traverses the guest's Unix socket. Its socket mount is read-only, with no host sockets. Only the trusted gateway has a dedicated bridge and a host binding at loopback5180; no desktop TCP port is published. Ephemeral proof certificates authenticate membership in the proof CA. This is not Moss owner authentication, logout or session revocation.

Desktop caps: 2 CPUs/4 GiB/512 PIDs. Gateway adds 0.5 CPU/128 MiB/32 PIDs; the combined configured allowance is 2.5 CPUs/4.125 GiB/544 PIDs, excluding host browser automation. Writable home/socket data uses a monitored10 GiB stop threshold, not a quota, with free-space margin and fail-closed measurement handling. Tmpfs, shared memory and logs have separate bounds.

## Runtime result ledger

| Case                                                               | Result and exact limit                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real desktop display                                               | PASS: 1280×800 framebuffer, 245 sampled colours; no screenshot artifact.                                                                                                                                                                                                                   |
| Terminal/manual path mechanics                                     | PASS automated: actual noVNC/RFB keyboard command saved `Files/marker.txt`; no claim Ben typed it.                                                                                                                                                                                         |
| Browser/profile                                                    | PASS: local fixture displayed, actual bookmark stored in `places.sqlite`, effective profile under persistent home.                                                                                                                                                                         |
| Browser sandbox                                                    | PASS for offline checkpoint: actual about:support reports content sandboxing true, effective level6, seccomp-BPF and thread synchronisation true. User Namespaces=false with EPERM warning; no full namespace isolation or Internet-browsing claim. No sandbox/security-profile weakening. |
| Isolated HTTP/WS access                                            | PASS: proof client HTTP200/WS101; missing/foreign certificate HTTP400/WS400; authenticated foreign Origin WS403. These are synthetic identities, not Moss owners.                                                                                                                          |
| Security negative controls                                         | PASS: removing mTLS caused the unchanged isolation assertion to fail at missing-client HTTP200; removing Origin gate failed at foreign-Origin WS101. Both runs exited1; restored protection run exited0.                                                                                   |
| Actual container replacement                                       | PASS: different old/new container IDs, same exact image; saved file and actual browser database bytes retained. Browser reopened retained profile; bookmark URL/title and file hash remained correct. IDs/hashes are in the receipt.                                                       |
| Normal disconnect/reconnect                                        | PASS: new authenticated viewer context reconnected to the unchanged desktop.                                                                                                                                                                                                               |
| Abrupt guest failure                                               | PARTIAL: viewer detected disconnect, Moss stayed healthy, socket reconnected. Recovered framebuffer assertion timed out; recovered keyboard case NOT_REACHED. No root cause established.                                                                                                   |
| Resource fit                                                       | LIMITED PASS for synthetic workload: observed idle157.8 MiB, interaction687.2 MiB/340 PIDs; gateway3.1–3.5 MiB. Replacement cgroup peak497,995,776 bytes, zero recorded OOM kills. Samples cover different phases/containers, not a sustained capacity benchmark or product minima.        |
| Fail-closed/final controls                                         | PASS: simultaneous unreadable socket directory and unwritable final-receipt path did not bypass stopping; zero running proof containers within5 seconds. Final attended controls also completed.                                                                                           |
| Internet/Moss auth/download/installer/platform/manual remote cases | NOT_RUN, separate gates.                                                                                                                                                                                                                                                                   |

## Material failures and corrections retained

- Original Webtop candidate was registry-inspected only: amd64 manifest `sha256:8ffd561faa3b33df0c076159ca071b44da948ba147f04267ba979553d5c6caa9`, source label `0905ecf6f1aca9ba2d21487acda4799b0c03b857`. Its Chromium wrappers add `--no-sandbox` under ordinary Docker seccomp; unmodified candidate rejected. No Webtop runtime proof.
- Initial `BLOCKED_BEFORE_LAUNCH` at commit `83ec63b2a` was a real read-only readiness result. It is historical, not the current authority/status. No image/container existed at that checkpoint.
- First assembled launch failed: Debian Websockify0.10 lacked `--unix-listen`. Fix: explicit hash-pinned0.13 executable with installed-option build checks. The internal-only bridge did not publish the listener; a retained old network also survived the Compose edit. The proof-only network was removed/recreated as a normal bridge for the trusted gateway. Guest networking stayed disabled.
- Automation-server interruption safely stopped proof services. Existing receipts were checked before resuming; it is a context-continuity exception, not a one-context success claim.
- Harness failures are not passing UAT: early framebuffer check raced first render; legacy window-title lookup failed twice and was replaced by visible WM_CLASS plus separately asserted title; browser quit did not complete until an actual Alt-F4 confirmation. Actual bookmark/profile checks were performed after close, not inferred from attempted keys.
- Recovery scripts initially asserted a fixed resolution; transport reconnect had already passed. Correcting to any qualifying nonzero canvas still timed out. A built-in Connect-button attempt also failed because that selector was not visible. Retain these failures; do not assert automatic recovery is universally unsupported, claim a root cause, or weaken the check to declare completion.
- Earlier GitHub lookup using the historical repository name returned422; corrected `motioneso/moss` access worked. `agent-reach` binary was unavailable for its optional update check; connected GitHub supplied source research.

## Closure and next action

Both services stopped, proof containers/network removed, reserved port released, and ephemeral proof CA/client/gateway keys removed. The supervisor exited; no proof runtime or unattended timer remains. Production Moss was `running healthy`. Dedicated synthetic home/profile data and the exact local image are retained; no user data deletion or broad image pruning occurred. Repository work is saved in draft PR3579; no merge or installed deployment.

Stop this bounded attempt with recovery unqualified. The [next proposed assignment](../../superpowers/plans/2026-10-23-moss-computer-recovery-qualification.md) isolates recovered viewing/input on this same candidate/host before Moss integration. Full implementation authority persists; this is a scope/review stop after repeated proof failures, not a request for permission or a relay into another coordinator. Do not start another runtime from this report.
