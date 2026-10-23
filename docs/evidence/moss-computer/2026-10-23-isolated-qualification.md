# #3578: isolated desktop qualification evidence

- **Date:** 2026-10-23 UTC.
- **Status:** BLOCKED_BEFORE_LAUNCH. Documentation and read-only readiness advanced; no desktop image pulled or container launched.
- **Parent/task:** #3577 / #3578.
- **Spec:** [Persistent desktop](../../superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md).
- **Plan:** [Isolated qualification](../../superpowers/plans/2026-10-23-moss-computer-isolated-qualification.md).
- **Author/active overnight finish operator:** Codex `/root`.
- **Manual operator:** Ben, proposed for a later confirmed attended session.

## Authority and identities

Ben approved the MC0 direction, settled host/viewer choices, accepted the supplied v7 reference material without further verification, and requested durable spec/plan followed by bounded overnight progress. No product integration or production change is implied.

MC0 inspected source: `8814c9b43101e40619cf1e89055cf4eab2a6ce04`. Documentation branch base: `021fd9a0c`. Production image recorded by MC0: `ghcr.io/motioneso/moss@sha256:74d2208c9c50e48465a177ff99b17e1bbb3e04bab2386d6a0268c922c4d8b8db`; installed build metadata is distinct from source provenance.

Candidate index: `sha256:278797c03b62454aaf05cd1fdeb35dbdc822846855020f9e5233f508a89980d9`. Linux amd64 manifest: `sha256:8ffd561faa3b33df0c076159ca071b44da948ba147f04267ba979553d5c6caa9` for LinuxServer webtop Ubuntu/Xfce. `docker buildx imagetools inspect` exited 0; this was registry inspection only.

Exact-manifest configuration inspection also exited 0: Linux/amd64, entrypoint `/init`, no explicit user, `/config` volume, exposed ports 3000/3001, image version `388f14a2-ls7`, creation metadata `2026-10-20T04:20:10.789255708Z`, and source-revision label `0905ecf6f1aca9ba2d21487acda4799b0c03b857`. These are image metadata, not an observed service user, signed provenance or an executed init/profile test.

## Readiness ledger

| Check                            | Result             | Evidence / limit                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended host                    | PASS               | Existing server; no substitute host.                                                                                                                                                                                                                                                                     |
| Viewer choice                    | PASS               | Server-local first, MacBook Air later.                                                                                                                                                                                                                                                                   |
| Resource snapshot                | PASS_SNAPSHOT_ONLY | Approximately 17 GiB RAM available; swap nearly full; root roughly 13 GiB free/98% used; Docker's separate filesystem roughly 959 GiB free. The two interval samples after vmstat's cumulative first row showed zero swap-in/out. This passes the proposed entry floors at that moment, not runtime fit. |
| Candidate architecture           | PASS_METADATA_ONLY | amd64 manifest returned; no signature/source-provenance or runtime claim.                                                                                                                                                                                                                                |
| Private owner viewing            | UNKNOWN            | No qualified path identified. Upstream documents HTTPS viewing and no default authentication. Loopback alone is insufficient.                                                                                                                                                                            |
| Egress plus viewing              | UNKNOWN            | `network=none` can isolate a guest, but no qualified viewer path into that configuration was identified. An internal bridge alone does not establish restrictions against host/Moss services.                                                                                                            |
| Storage protection               | UNKNOWN            | No enforced quota or fail-closed monitored byte budget qualified.                                                                                                                                                                                                                                        |
| Actual service user/init/profile | UNKNOWN_RUNTIME    | Configuration declares `/init`, no explicit user and `/config`. Desktop-user behavior, cap requirements and actual browser-profile use were not executed.                                                                                                                                                |
| Finish controls                  | PLANNED_ONLY       | Codex `/root` must actively close an automated run; Ben's later manual attendance is unconfirmed. No timed runtime started.                                                                                                                                                                              |

## Runtime cases

Desktop viewing/input, browser/terminal use, saved file/profile replacement, disconnect/reconnect, guest failure, resource measurements and disable/re-enable: **NOT_RUN**. Integrated owner/foreign-owner/unauthenticated HTTP/WS checks: **NOT_RUN, later scope**. Ben's manual acceptance: **NOT_RUN**.

## Failures and limits

An initial connected GitHub search used the historical repository name and returned 422. The actual configured repository is `motioneso/moss`; the corrected search succeeded. No retry loop or access workaround was used. A lowercase PR-template lookup failed; the repository's uppercase template was found and read.

No private hostname/address, secret, environment dump, raw history or full screenshot is retained here. No existing proof instance was reused.

## Closure and next action

Entry gates for private viewing, egress combined with viewing, and storage protection remain unqualified. The plan explicitly stops here before image pull or container launch; no alternate host, unauthenticated listener, new proxy or host firewall change was attempted. Exact-document independent review is recorded separately.

No proof runtime objects, reserved ports or data volumes were created, so there is no runtime cleanup or persistence receipt to claim. No production, Sports, account, credential or shared-setting change was made. #3578 remains open; neither its parent nor any guide stage is complete.

The next proposed assignment is a separately scoped, independently reviewed design for private local viewing combined with enforced egress restrictions and bounded storage for this isolated candidate. It must preserve container/browser sandboxes and remain separate from reusable proof-tool development and the later Moss gateway build. It is not started by this readiness result.
