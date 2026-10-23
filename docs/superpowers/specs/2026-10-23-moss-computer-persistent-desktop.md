# Moss Computer: one persistent owner desktop

- **Date:** 2026-10-23 UTC
- **Status:** Autonomous implementation authorised; isolated qualification is the first bounded checkpoint. Runtime acceptance is outstanding.
- **Parent:** #3577. First qualification: #3578.
- **Plan:** [Isolated qualification](../plans/2026-10-23-moss-computer-isolated-qualification.md).
- **Authority:** Ben's supplied “Moss next steps after Stage 4, focused planning update 1”, MC0 request, device clarification, acceptance of the supplied v7 material without separate pack verification, instruction to write the spec/plan and proceed overnight, and subsequent explicit full authority to plan and implement autonomously, provider-agnostic and following repository guidelines.

## 1. Problem and outcome

Moss needs one owner-only persistent computer alongside its own runtime. Establish the smallest real execution path before building product integration. MC0 was a planning assignment, not an existing numbered guide task. Its independent review accepted a split between isolated desktop qualification and later integrated ownership proof.

The intended host is the existing server running this work. Other Moss installations run Computer on their own capable hosts. Ben views it from either this server or a MacBook Air. The first isolated qualification uses the server-local viewing path; remote MacBook viewing remains a later qualification case.

## 2. Settled product decisions

1. One desktop remains running alongside Moss once enabled, including after viewer disconnection.
2. The owner can manually use its desktop, browser and terminal first.
3. Designated files and the actual browser profile survive container removal and recreation. Website sessions can expire. Running processes and installed system packages have no persistence promise.
4. New installations select Computer by default, with opt-out and resource disclosure. Existing installations receive an explicit add-on step.
5. Disable stops Computer and retains its data. Data deletion is a separate explicit decision.
6. Agent control, watch/stop/takeover, login handoffs and useful jobs follow in separately bounded work.
7. Preserve the desktop destination; a browser-only trial cannot redefine it.

## 3. Recommended system

```text
Owner's browser
  -> trusted Moss viewer and authenticated HTTPS/WSS gateway
  -> private persistent desktop companion
  -> dedicated Computer files/profile storage

Trusted host lifecycle interface
  -> fixed Computer enable / disable / recreate operations
```

This diagram is the proposed integration, not an observed running path.

Use a separate Linux desktop image and dedicated storage. Do not reuse Moss vault, CLI-auth, model-cache or Sports volumes. LinuxServer webtop Ubuntu/Xfce was the first candidate. Its pinned Chromium launcher adds `--no-sandbox` under default Docker seccomp, so the unmodified candidate is rejected. The authorised research/implementation checkpoint below evaluates established alternatives; no vendor runtime claim is inherited.

The integrated gateway must check the Computer owner on creation, status, view, input, reconnect and download requests, including WebSocket upgrades and active-session revocation. Administrator status alone grants no private-data access. Ticket ownership, expiry and replay semantics require their own reviewed contract.

Trusted viewer assets may use the Moss origin. Guest-controlled HTML, URLs and downloaded content must not acquire Moss-origin execution privileges. Downloads need owner checks, confined path resolution and safe attachment handling. A private network alone does not establish guest egress isolation: enforce restrictions against host, LAN, metadata and Moss service destinations.

Expose no additional public guest-control port. Give the guest no Docker socket, host credentials or production service network. Do not disable container security profiles or the browser sandbox to make a candidate work; incompatibility stops qualification. Use a narrow trusted lifecycle interface; the existing fixed restart sentinel is not a generic Computer controller. Guest failure must leave Moss available.

## 4. Scope and proof split

### First: isolated desktop qualification (#3578)

Qualify the pinned image, service user/init, private viewer, files/profile storage, replacement persistence, recovery and resource fit on the selected host. Use synthetic data only. This first outcome establishes no Moss owner-route security, installed-product integration or platform support claim.

The accepted candidate envelope is at most two CPUs, 4 GiB RAM, 512 PIDs, no GPU and a 60-minute actively supervised runtime window. Storage limits, safe headroom and monitoring/cleanup failure behavior must be fixed before launch. A monitored byte ceiling must never be called an enforced quota.

Ben's overnight instruction authorises continued bounded preparation and safe isolated qualification. Codex `/root` is the active overnight host/finish operator. It may finish an automated session only while actively supervising it and able to perform final controls; no unattended overnight desktop or timer-only completion. Automated input is recorded as automated, not Ben's manual acceptance. Ben is the proposed finish operator for the later manual session; confirm attendance before dispatching that session.

### Later: integrated Moss proof

No qualified Computer gateway/lifecycle candidate has been identified. Prepare and independently review that implementation as separate bounded work before its live proof. The integrated proof must cover owner, foreign-owner and unauthenticated requests through the actual HTTPS/WSS path, session expiry/logout/revocation, download confinement, replacement persistence, failure isolation and disable/re-enable. Test endpoints independently of navigation visibility.

Ben subsequently authorised autonomous implementation, including the missing gateway/storage interfaces. Each bounded candidate still needs independent review and applicable live proof; isolated acceptance does not establish production deployment or release/platform readiness.

## 5. Evidence and system fit

| Class                       | Established fact or limit                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source inspected during MC0 | `8814c9b43101e40619cf1e89055cf4eab2a6ce04`; citations below refer to that revision.                                                                                                                                                               |
| Documentation branch base   | `021fd9a0c`; documentation-only work must not be mistaken for a refreshed product-source review.                                                                                                                                                  |
| Installed production image  | `ghcr.io/motioneso/moss@sha256:74d2208c9c50e48465a177ff99b17e1bbb3e04bab2386d6a0268c922c4d8b8db`.                                                                                                                                                 |
| Installed metadata          | Reported build commit `85fa42c1df7d1c69fe4ca2c83e34dac6da18f893`; embedded metadata is not independently attested provenance.                                                                                                                     |
| Installed configuration     | `~/JarvisProd/docker-compose.prod.yml` and `docker-compose.notes.yml`; distinct from repository Compose.                                                                                                                                          |
| Observed host               | Ubuntu 24.04, Linux x86_64, 16 CPU threads, approximately 17 GiB available RAM; Docker 29.1.3, Compose 2.24.6, cgroup v2.                                                                                                                         |
| Resource limits             | Root filesystem was 97–98% used with roughly 13–14 GiB free, swap nearly full, and Docker's separate filesystem had roughly 959 GiB free. These are snapshots, not benchmarks.                                                                    |
| Historical research         | `~/moss-research/2026-10-04-virtual-desktop-for-moss.md`; vendor/resource claims are historical, and its browser-first recommendation is superseded.                                                                                              |
| Stage 4                     | Final report and planning addendum dated 22 October 2026, task mapping and session ledger were recovered. Acceptance retains amendments, deferred mobile evidence and unrun lifecycle/race cases. Raw execution was not independently re-audited. |
| Guide                       | User-supplied v7 material, source `b16c446fcc729f50f057d3be38d586338d4adb99`, is authoritative. Ben waived separate pack verification. Unread pack contents are not represented as inspected.                                                     |
| Runtime unknowns            | Private viewing, candidate user/init compatibility, profile location, safe resource envelope, integrated transport, egress, persistence and recovery still require actual proof.                                                                  |

## 6. Shared boundaries and ownership

Current named product owners were not established. The qualification operator owns no shared product changes. Reserve one coordinated owner for each boundary before later implementation; package location is not proof of an active assignment.

| Boundary           | Source evidence at the inspected revision                                                                                         | Required future responsibility                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | `packages/auth/src/index.ts:454–519`                                                                                              | Auth/gateway owner; add Computer owner comparison.                                                                                                         |
| HTTP/WS            | `packages/ai/src/terminal-routes.ts:46–63,90–267`; `apps/api/src/server.ts:349`                                                   | Auth/gateway owner. Existing terminal tickets are not actor-bound and disconnect kills the PTY; do not copy those semantics unchanged.                     |
| Shell/navigation   | `apps/web/src/app.tsx:175–189,292–345`; `apps/web/src/app-route-metadata.ts:131–175`; `apps/web/src/shell/app-shell.tsx:22,76–85` | Shell owner.                                                                                                                                               |
| App map            | `packages/shared/src/app-map-core.ts:54–86,423–426` or owning manifest                                                            | Same product PR must describe the actual navigation, settings, features, errors and remediation. No Computer declaration for this docs-only qualification. |
| Deployment/storage | `infra/docker-compose.yml`; `infra/docker-compose.prod.yml:140–237`; `docs/operations/deploy.md:9–17,108–138`                     | Deployment owner; preserve installation identity, add dedicated storage and private wiring.                                                                |
| Images/releases    | `Dockerfile:33–45,59–83,110–127`; `.github/workflows/ci.yml:456–501,526–537`; `.github/workflows/release-image.yml:43–122`        | Packaging owner; desktop digest/architecture qualification is separate.                                                                                    |
| Lifecycle/recovery | `packages/settings/src/host-restart-routes.ts:75–145`; `infra/host/jarv1s-restart.sh:4–10,28–38`                                  | Lifecycle owner. Current backup documents disagree on automatic coverage and establish no Computer backup.                                                 |
| Sports exclusion   | `infra/docker-compose.prod.yml:253–283`; `packages/sports/src/source/browser-sidecar.ts:92–115,300–315`                           | Leave the specialised renderer unchanged.                                                                                                                  |

## 7. Dependencies and exclusions

- Reuse relevant stable guide tasks: Q01-C1 (source/release), Q02-P1 (installed identity), Q04-C1 (devices/cases), Q05-R1 (readiness review). This spec does not complete those whole tasks or their stages.
- D01-C1, D01-R1 and D02-P1 inform later backup/recovery; the synthetic isolated qualification need not wait for the full recovery programme.
- Installer/authentication/image/platform release gates remain for new-install and advertised-platform claims. The first existing-owner trial does not require all Extensions or a native-shell rewrite.
- The supplied inventory reports PRs 3540/3542/3544 merged and 3532/3535/3536/3539 as drafts. None was established as a Computer prerequisite; no automatic draft adoption or repeated accepted UAT.
- News and Direct On remain independent. Preserve X03-P1 before dependent runner work, X16 review/live-proof gates and X17/X18/X19 hold markers; no dispatch or completion claim here.

## 8. Acceptance and stop

The first qualification needs actual desktop/browser/terminal input, a file hash and actual browser-profile marker surviving remove/recreate with different container IDs, reconnect/failure evidence, measured resources and disable preserving data. Record automated and manual cases separately.

Before launch, independently review exact image/configuration, private viewing, egress, memory/storage safety and final controls. If any entry gate fails, return `BLOCKED_BEFORE_LAUNCH`, retain evidence and stop. Make a bounded design decision before implementing a missing interface. Do not change host firewall/account settings, select another host or start reusable tooling to get around a blocker.

At runtime closure, stop only the labelled proof desktop, confirm no proof process/listener remains, confirm Moss health and preserve proof data. Data deletion, image pruning, production changes and a later proof need separate scope. Full overnight waiting is not a completion criterion.

## 9. Rulings and review ledger

- MC0 independent review accepted the split and planning completion, with Ben named as proposed manual finish operator and all runtime entry gates retained.
- Ben confirmed this server as host and either server or MacBook Air as viewer.
- Ben accepted the supplied v7 material without further verification.
- Ben requested these durable documents followed by bounded overnight progress; this supersedes the earlier planning-only limit only for documentation and the first isolated qualification.
- Exact-document independent review and the qualification outcome are recorded in the companion evidence report. A readiness failure cannot be represented as runtime acceptance.

## 10. Authorised implementation amendment

Ben explicitly gave full authority to plan and implement autonomously and invited research/reuse. That supersedes the earlier missing-interface permission stop, not the repository review/security/live-proof gates. The first implementation may change the isolated candidate after documented comparison. Agent/model providers play no role in this manual desktop checkpoint.

Preferred fallback for independent review: distro-packaged Xfce, TigerVNC, noVNC/websockify and Firefox ESR on a pinned Debian amd64 base. Reuse their viewer/protocol/browser implementations. Do not build a remote desktop protocol or custom Docker-exec byte tunnel. Websockify's documented Unix listener allows an offline guest (`network=none`) to be reached through one socket-only mount by a isolated trusted Nginx TLS gateway. Gateway material remains outside guest storage. A synthetic client certificate tests isolated viewer access; this is not Moss owner authentication.

This offline qualification exercises browser/profile mechanics with local synthetic content. It cannot qualify useful Internet browsing. Product integration must add reviewed outbound HTTP(S)/DNS handling that excludes host/LAN/metadata/Moss services; no silent unrestricted bridge fallback. Guest-controlled pages and downloads stay outside the Moss origin.

The proof home/files directory uses a monitored 10 GiB threshold, not a quota; the read-only image root and size-limited tmpfs contain other writes. An independent monotonic supervisor stops the labelled guest on timeout, missing heartbeat, measurement error, low headroom or threshold exceedance. The active operator closes gateway/listener and records retained data. No unattended persistence claim follows. A strict hard-quota requirement would be a separate storage/platform dependency.
