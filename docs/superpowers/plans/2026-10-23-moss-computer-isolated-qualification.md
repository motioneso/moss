# #3578: qualify one isolated persistent Moss Computer desktop

Part of #3577. Implements only the first proof boundary from the [approved design](../specs/2026-10-23-moss-computer-persistent-desktop.md). Ben approved MC0 in conversation and instructed repository-format documentation followed by bounded overnight progress.

## Current seams and decisions

The design's source/ownership table is the seams ledger, pinned to `8814c9b43101e40619cf1e89055cf4eab2a6ce04`. This docs-only branch starts at `021fd9a0c`; no product changes or refreshed-source acceptance are implied.

No qualified Computer gateway/lifecycle candidate was identified. The first outcome therefore qualifies the desktop on the existing server, without claiming Moss owner-route security. Integrated gateway work and its proof stay separate. Do not use another existing proof instance or attach to production networks/volumes.

Candidate: `lscr.io/linuxserver/webtop:ubuntu-xfce`, Linux amd64. Registry inspection on 2026-10-23 returned:

- Index: `sha256:278797c03b62454aaf05cd1fdeb35dbdc822846855020f9e5233f508a89980d9`.
- amd64 manifest: `sha256:8ffd561faa3b33df0c076159ca071b44da948ba147f04267ba979553d5c6caa9`.

Use the manifest digest, not the mutable tag, for any later pull/run. Registry metadata is not a signature, source-provenance attestation or runtime test. Current upstream documentation describes Selkies, HTTPS viewing and no default authentication. The application Dockerfile declares `/config`; that alone proves neither the browser's effective profile path nor persistence.

Exact-manifest image configuration inspection returned amd64/Linux, entrypoint `/init`, no explicit `User`, volume `/config`, ports 3000/3001, version `388f14a2-ls7`, and source-revision label `0905ecf6f1aca9ba2d21487acda4799b0c03b857`. The absent user field does not establish a non-root runtime; actual init/desktop user and profile behavior remain unqualified. No entrypoint was executed.

## Ownership and writable areas

- Coordinator, documentation author and overnight active finish operator: Codex `/root`.
- Independent reviewer: existing `/root/independent_review`; it must not author these documents or the candidate.
- Later manual operator/finish operator: Ben, proposed; confirm availability before that session.
- Owned repository paths: this plan, the companion spec, `docs/evidence/moss-computer/2026-10-23-isolated-qualification.md`, and its independent review record.
- Use one isolated worktree and branch. No shared source, Compose, auth, shell, app-map, packaging, database or Sports changes.
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
