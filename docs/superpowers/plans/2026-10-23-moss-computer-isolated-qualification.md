# #3578: qualify one isolated persistent Moss Computer desktop

Part of #3577. Implements only the first proof boundary from the [approved design](../specs/2026-10-23-moss-computer-persistent-desktop.md). Ben approved MC0 in conversation and instructed repository-format documentation followed by bounded overnight progress.

## Current seams and decisions

The design's source/ownership table is the seams ledger, pinned to `8814c9b43101e40619cf1e89055cf4eab2a6ce04`. This branch started with documentation at `021fd9a0c`; no product changes or refreshed-source acceptance are implied.

At MC0, no qualified Computer gateway/lifecycle candidate was identified. The first outcome therefore qualifies the desktop on the existing server, without claiming Moss owner-route security. Integrated gateway work and its proof stay separate. Do not use another existing proof instance or attach to production networks/volumes.

Initial candidate, subsequently rejected unchanged: `lscr.io/linuxserver/webtop:ubuntu-xfce`, Linux amd64. Registry inspection on 2026-10-23 returned:

- Index: `sha256:278797c03b62454aaf05cd1fdeb35dbdc822846855020f9e5233f508a89980d9`.
- amd64 manifest: `sha256:8ffd561faa3b33df0c076159ca071b44da948ba147f04267ba979553d5c6caa9`.

Use the manifest digest, not the mutable tag, for any later pull/run. Registry metadata is not a signature, source-provenance attestation or runtime test. Current upstream documentation describes Selkies, HTTPS viewing and no default authentication. The application Dockerfile declares `/config`; that alone proves neither the browser's effective profile path nor persistence.

Exact-manifest image configuration inspection returned amd64/Linux, entrypoint `/init`, no explicit `User`, volume `/config`, ports 3000/3001, version `388f14a2-ls7`, and source-revision label `0905ecf6f1aca9ba2d21487acda4799b0c03b857`. The absent user field does not establish a non-root runtime; actual init/desktop user and profile behavior remain unqualified. No entrypoint was executed.

## Ownership and writable areas

- Coordinator, documentation author and overnight active finish operator: Codex `/root`.
- Independent reviewer: existing `/root/independent_review`; it must not author these documents or the candidate.
- Later manual operator/finish operator: Ben, proposed; confirm availability before that session.
- Owned repository paths: this plan, the companion spec, `docs/evidence/moss-computer/2026-10-23-isolated-qualification.md`, and its independent review record.
- Use one isolated worktree and branch. No shared product auth, shell, app-map, deployment, database or Sports changes in the first checkpoint; isolated candidate files are owned under `spikes/moss-computer/`.
- Runtime objects, if entry gates pass, must use a unique `moss-computer-qualification` prefix plus run ID and explicit ownership labels. Allocate any host listener using `devports`; no unreserved port and no listener reachable from LAN/tailnet.

## Step 1: preserve the approved decision

Write the approved design and this decision-based plan in the established spec/plan directories. Keep local paths as `~/Jarv1s` or relative paths, and keep secrets, private hostnames, addresses and raw histories out of the public repository. Open task #3578 under #3577. Independently review the exact document bytes and record the verdict before a runtime launch.

Expected outcome: preserved reviewed spec/plan. This is documentation acceptance only.

## Step 2: qualify readiness before pulling or launching

Record each gate as `PASS`, `FAIL` or `UNKNOWN`. `UNKNOWN` blocks launch.

| Gate               | Required evidence / decision                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate identity | Exact amd64 manifest, image configuration, entrypoint/init and service-user requirements. Review source/configuration without executing image entrypoints first.                                                                                                                                   |
| Private viewing    | A supported, already available owner-controlled local HTTPS/WSS path with no public guest listener. Loopback alone is not an authenticated owner boundary on a shared host. No qualified path means stop.                                                                                          |
| Egress             | Kernel-enforced exclusion of host/LAN/metadata/Moss destinations. Docker `network=none` can isolate egress, but does not by itself provide the viewer path. An internal bridge alone is insufficient. No host firewall alteration or guest-owned firewall as a substitute.                         |
| Host resources     | Proposed conservative entry floors: 12 GiB available RAM, 10 GiB root free and 30 GiB Docker-storage free; no sustained swap-out in the short readiness sample. These are engineering trial gates, not product minima or benchmarks. Keep all image/data staging on Docker's separate filesystem.  |
| Runtime limits     | At most 2 CPUs, 4 GiB RAM, 512 PIDs, no GPU. Fix shared-memory allowance inside the memory budget, init/log behavior, no restart loop and no unbounded log output. Do not enable privileged mode, host namespaces, host devices or Docker socket access.                                           |
| Data/storage       | Dedicated files/profile volumes; actual user/profile location verified. Fix the byte budget (initial proposal 10 GiB), enforcement versus monitored threshold, image/unpack budget and root-write bounds. No quota claim without enforcement; no monitored mode without fail-closed stop behavior. |
| Finish             | Codex `/root` remains active, with a monotonic 60-minute maximum runtime deadline, working stop controls and cleanup on failure. If active supervision cannot be maintained, do not launch. No detached overnight timer or scheduled job substitutes for the closing session.                      |

Before changing anything, capture production container identity and an authorised non-secret health baseline. Recheck after proof closure. Read only allowlisted configuration fields; no environment/credential dumps or account changes.

Record failed entry gates and stop immediately. Do not pull an image merely to discover a known missing private-viewing path. Do not disable container security profiles (including seccomp/AppArmor) or the browser sandbox to make this image work; such incompatibility returns `BLOCKED_BEFORE_LAUNCH`. Investigating supported source/configuration is allowed; writing a custom proxy, gateway, browser driver, cleanup daemon or reusable harness is separate work.

Expected outcome: either a separately reviewed launch entry sheet or `BLOCKED_BEFORE_LAUNCH`. Do not spend the entire overnight window retrying readiness.

## Step 3: isolated runtime qualification, only after all gates pass

Use synthetic data and an explicit run ID. Confirm the exact configuration with the independent reviewer before launch. The operator actively attends execution and finishes within 60 minutes; no soak duration is required for its own sake.

| Case                     | Required observation and receipt                                                                                                                                                         | What the case detects                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Desktop/browser/terminal | Actual visible desktop and real input through the selected viewer. Label any browser automation as automated. Ben's manual case stays `NOT_RUN` until attended.                          | An HTTP page or healthy process without a usable desktop cannot pass.           |
| Designated file          | Save a synthetic file as the desktop user and record its hash and volume identity.                                                                                                       | Ephemeral-root writes or wrong UID/mount cannot pass.                           |
| Browser profile          | Create a nonsecret bookmark or equivalent marker through the actual browser; record effective profile path.                                                                              | Touching an arbitrary directory does not establish browser-profile persistence. |
| Actual replacement       | Remove the proof container, recreate from the identical digest/configuration and same dedicated volumes, record different IDs, and verify both markers through the real desktop/browser. | Restarting the same container or changing the candidate invalidates the case.   |
| Disconnect/reconnect     | Disconnect viewer, confirm desktop remains running, reconnect and inspect the same session state.                                                                                        | A viewer-owned ephemeral desktop fails.                                         |
| Guest failure            | Stop/fail only the proof guest, confirm Moss remains healthy and recover/reconnect without data loss.                                                                                    | Coupled lifecycle or accidental production intervention fails.                  |
| Disable/re-enable        | Stop only the proof companion, retain volumes, re-enable and verify markers.                                                                                                             | Coupled stop/delete semantics fail.                                             |
| Resources                | Baseline/idle/peak CPU, memory, swap activity, PIDs, image/data/log growth, startup and reconnect timing.                                                                                | A configured limit is not evidence of actual resource behavior.                 |

Use bounded textual and executable receipts; do not capture or review screenshots for the repository's live-path gate. No rewritten responses, pre-canned UI, external website sessions, provider calls or installed-package changes. Record exact commands and exit codes without piping verification output.

## Step 4: final controls and receipts

On success, failure, timeout or interruption, the active finish operator stops the exact labelled proof desktop, verifies it is stopped and no owned listener/process remains, confirms production identity/health against baseline, and preserves proof volumes. Do not delete data, prune shared images or stop unrelated services. Failure of stop/cleanup is a material failure, not a passing proof with a note.

The concise evidence report records task ID, authority, inspected source, documentation commit, image digest/configuration hash, run/deployment identity, operators, test classifications, failed/not-run cases, resource measurements, final controls, retained data and next action. Private raw receipts stay outside the public repository. A launch blocked at readiness has no container IDs, no runtime measurements and no persistence pass.

The independent reviewer checks the exact report/candidate. Do not close #3578, merge or claim product completion from documents, configuration inspection or automated substitutes for Ben's manual acceptance.

## Verification commands and expected outcomes

- `git diff --check`: exit 0 for the owned documents.
- Prettier `--check` on only the four owned Markdown files: exit 0. Use the already installed formatter; no dependency install.
- Check relative document links and scan owned files for credentials, private hostnames, addresses and unintended absolute local paths: no findings.
- `docker buildx imagetools inspect` on the exact manifest: exit 0 establishes registry metadata only. It does not pull or run the image.
- Runtime commands are selected only after Step 2 passes and their exact entry sheet is reviewed. No speculative runnable Compose or test framework is authorised by this plan.
- No database-touching test, whole-repository gate or product UAT is appropriate for these documentation/preflight changes. Any later such work must use the repository's verify-gate workflow.

## Determinism boundary

There is no product UI or model call in this assignment. Results and status come from observed receipts, never generated claims. No chat turn injection, model-authored user data or prompt guidance is introduced.

## Kill gate and report/context discipline

Codex `/root` stops on a missing entry gate, production impact, unsafe storage/transport, repeated identical failure, missing finish controls or need for new proof infrastructure. Preserve the failed observation and return the smallest next decision; do not automatically switch candidates or relay to another coordinator.

This assignment has one initial exact-document review and one correction round if needed. Repeated review failure triggers a scope decision rather than another loop. The supplied guide's v7 authority is accepted without inventing unread numeric report limits. Earlier MC0 continued through a context summary; no one-context success is claimed. Keep this follow-on bounded to one context and return a checkpoint before capacity is exhausted.

## Later integrated proof: stop boundary

After a separately scoped and reviewed owner gateway/lifecycle build, prove the real isolated Moss deployment and selected HTTPS/WSS path: owner/foreign-owner/unauthenticated create/status/view/input/reconnect/download requests; expiry/logout/active revocation; confined downloads; real replacement persistence; failures; resources; disable and separately authorised deletion. The MacBook Air viewing path gets its own observed qualification. This paragraph is a dependency boundary, not a dispatch or implementation plan.

## Rulings ledger

- MC0 independent review accepted the two-proof split. It did not accept runtime suitability or an owner-route implementation.
- Ben's overnight instruction permits first-qualification progress. Codex `/root` can close only an actively supervised automated session; it cannot replace Ben's manual acceptance.
- Missing private viewing or enforced egress is a stop, not authority for a new proxy/tooling project.
- Independent document review round 1 required an explicit prohibition on weakening container/browser sandboxes. That prohibition is now explicit; incompatibility blocks launch. The report's proposed next assignment also names egress combined with viewing.
- The final evidence report retains every failure and `NOT_RUN` case and names one next assignment only.

## Implementation amendment: established offline stack

Full autonomous implementation authority supersedes the original missing-transport/storage approval blocker. Preserve the initial blocked receipt as historical evidence. Current next step is independent design review, then one isolated candidate implementation and qualification; do not present the earlier blocked outcome as a current permission requirement.

Candidate ownership: Codex `/root` owns `spikes/moss-computer/Dockerfile`, `entrypoint.sh`, `compose.yaml`, `gateway.conf.template`, and `README.md`, plus these evidence documents. No new Moss module/UI surface is shipped by this internal spike, so no app-map Computer capability is declared.

- Base: Debian bookworm-slim amd64 manifest `sha256:ec31d744f83f4a73447ba045aaab9409997efe5cc706eca4890c1be36cc1606a`; build identity/package inventory must be captured after build. Apt repositories are mutable; a local image ID is the exact candidate, not a reproducible-build claim.
- Packages: standard Xfce desktop, TigerVNC, noVNC, Firefox ESR, terminal, D-Bus and init. Websockify 0.13.0 is a hash-pinned upstream wheel with distro-provided dependencies; Debian 0.10 lacks the required Unix-listener options. No AI provider dependency. Run UID/GID 1000, no sudo, all capabilities dropped, no-new-privileges, Docker default seccomp/AppArmor retained.
- Transport: websockify Unix listener through a socket-only bind directory; separate unprivileged Nginx gateway container on a loopback `devports` reservation, HTTPS/WSS with an ephemeral proof CA/client certificate. No TCP guest/control publishing. Reject missing/foreign certificates and foreign WebSocket origins. Guest has no network, gateway configuration, keys, host socket or production volume. The gateway mounts only the socket directory read-only; symlinks resolve inside the gateway container, where no host sockets are present. Serve packaged noVNC assets directly from the gateway read-only image; guest only serves the fixed WS backend.
- Storage: one dedicated persistent home including explicit Firefox profile and `Files/`; monitored 10 GiB stop threshold. Read-only root, tmpfs `/tmp` and `/run`, bounded shared memory and Docker log size. Do not call this a quota.
- Finish: active operator `/root`, maximum 60 minutes after launch; separate supervisor checks monotonic deadline, host resources and heartbeat at nominal five-second intervals (measurement and shutdown latency add to this), stops on measurement failure, and stops after heartbeat loss (up to90 seconds plus measurement/stop latency). Retain synthetic data at closure, remove labelled containers, stop gateway, release listener, remove ephemeral certificate material.

Before launch, compile/inspect exact image contents and independently review configuration. Stop on browser sandbox incompatibility; do not add disabling flags, privileged mode or unconfined profiles. Failures in two equivalent attempts trigger a candidate/scope decision.

Qualification cases: real noVNC canvas/framebuffer plus keyboard input into terminal/browser; create a synthetic file through terminal input; create an actual browser bookmark/profile preference; close browser cleanly and record file/profile hashes and DB marker; remove container, preserve directory, recreate from exact image ID with a different container ID, reopen browser and verify markers; viewer disconnect/reconnect while desktop persists; guest stop/restart and browser reconnect; unauthenticated/foreign-client HTTP and WS denial, exact-origin WS denial, negative control with origin gate removed; desktop service/user and browser sandbox evidence; idle/interaction/replacement resources and final Moss health. All input is automated unless Ben actually attends. Internet browsing, Moss session isolation and MacBook manual acceptance remain NOT_RUN.

Meaningful verification: `bash -n spikes/moss-computer/entrypoint.sh` (exit 0), resolved `docker compose config` (exit 0), scoped Prettier/whitespace checks, independent exact-candidate review and executable live assertions. This internal image spike has no database or TS changes; no broad database gate is required merely to validate it. Future product integration keeps its own foundation/live-UI gates.

Kill decision owner `/root`: if the maintained components cannot provide a sandboxed browser under the selected default host security, record the failure and revise/split before any further launch. No relay of unchanged retries.

## Qualification design review and retained startup failure

Independent reviewer accepted candidate commit `1f110888f2a6801554cd325d2de8d6db22aca243` with external supervisor SHA-256 `95abc5d8161c9c15d8b1666d1156549b688cf05b6ff3038ffe37c51b0284ffd9`. Prelaunch review corrected fixed Compose identity, omitted socket-directory accounting, Nginx temp paths and a cleanup/receipt ordering bug. Independent design review preferred the minimal Debian/noVNC composition; the separate research investigator preferred the native Selkies 2.1 desktop. The coordinator chose the smaller offline composition because this checkpoint needs only desktop input/persistence, accepting its component-packaging maintenance cost.

The first actual launch failed before browser use: Debian Websockify 0.10 did not recognise `--unix-listen`, despite that option being supported in the newer inspected upstream source. Docker also did not publish the gateway listener on its internal-only bridge in this environment. Both services were immediately stopped. This is failed runtime readiness, not a passing source check. Correct the installed executable to pinned 0.13.0 and verify every supplied option during build. Only the trusted gateway receives a normal dedicated bridge for loopback publishing; desktop remains `network_mode: none`. Re-review the exact correction before retrying.

## Current stop and exact next assignment

Runtime advanced beyond the original blocked readiness result. Current status is partial qualification: accepted cases are recorded in the [evidence ledger](../../evidence/moss-computer/2026-10-23-isolated-qualification.md), with source/image hashes and failure limits. Crash socket reconnection passed before the framebuffer assertion failed; recovered viewing/input remains unqualified. All proof services/ports/keys are closed; home/profile data is preserved.

The single next proposed assignment is [recovery qualification](2026-10-23-moss-computer-recovery-qualification.md), before shared owner integration. Repeated harness/recovery failures triggered this explicit scope stop rather than an unchanged retry or coordinator relay. The automation-server restart is recorded as an exception to the context aim. This checkpoint does not claim full implementation, a one-context success or a completed guide stage.
