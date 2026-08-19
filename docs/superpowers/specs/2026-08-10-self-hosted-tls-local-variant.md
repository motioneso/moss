# Self-hosted TLS for distributable secure-context access

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10; four binding review notes folded in

**Parent issue:** #901

**Prerequisites:** #1403 (dev-instance secure-context proof) and #1486 (scoped proxy trust)
**Grounded on:** `origin/main` = `ba1acd70a`, issue #901 and its 2026-08-09 scope comment,
issue #1403, and the approved Wave 6 spec

## Decision summary

Ship a **bundled but opt-in Caddy service** in the production Compose stack. Enabling the `tls`
profile adds HTTPS on standard ports `80`/`443` while the existing HTTP endpoint on `:1533`
continues to work. Existing deployments therefore do not change merely by pulling a new image.

Caddy's **internal CA is the default certificate issuer**. It works with a stable LAN hostname or
IP address and needs no public DNS or internet exposure, but every client device must explicitly
trust the generated root certificate. Operators who already have a public domain may choose the
`acme` issuer; that mode requires working public DNS and inbound ACME validation on ports 80/443.
Moss does not buy a domain, configure DNS, or silently install a trust root.

New installs that opt into TLS have their exact `https://<host>` origin generated into
`JARVIS_AUTH_TRUSTED_ORIGINS`. Existing `env.production.local` files are migrated by an explicit,
additive edit that preserves every old origin. No installer overwrites an existing env file, HTTP
does not redirect or disappear in this delivery, and `JARVIS_AUTH_BASE_URL` remains the API's
independent in-container URL.

## Why this is separate from #1403

The approved Wave 6 spec settled the distinction:

- **#1403 is the prerequisite dev-instance/operator tier.** It uses an already-installed
  `tailscale serve` terminator to prove sign-in, voice/media, service-worker registration, and
  secure-context behavior. It does not distribute certificate, DNS, or proxy infrastructure.
- **#901 is the distributable self-hosted tier.** It ships the production Compose proxy and the
  operator path needed by a self-hoster who is not on Ben's tailnet.

#901 must not absorb Tailscale commands or close as a duplicate of #1403. Conversely, #1403's
guided diagnostics/self-operation ideas are not required to ship the deployable TLS tier here.

## Current-state grounding

At the grounded revision:

- `infra/docker-compose.prod.yml` publishes the single Moss container as
  `${JARVIS_WEB_PORT:-1533}:3000`; it has no TLS terminator.
- `scripts/setup-prod-origins.ts` already accepts a full HTTPS public origin and combines it with
  the localhost HTTP origin. An explicit `JARVIS_AUTH_TRUSTED_ORIGINS` override wins verbatim.
- `scripts/setup-prod.ts` refuses to overwrite `env.production.local`, which protects long-lived
  auth and encryption keys. The TLS migration must preserve that invariant.
- `apps/api/src/server.ts` currently coerces `JARVIS_TRUST_PROXY` to a boolean. Issue #1486 records
  why that is too broad for a distributable reverse proxy: any direct client could spoof
  `X-Forwarded-*` headers when the value becomes `true`.
- `JARVIS_AUTH_BASE_URL` and browser trusted origins are intentionally separate. TLS changes only
  the browser-facing origin.

## Goals

- Give a normal production Compose operator an HTTPS origin without requiring Tailscale or a
  public domain.
- Make the default path private-LAN compatible and explicit about the per-device trust step.
- Support a real-domain ACME path without a second proxy implementation.
- Preserve existing HTTP bookmarks and working `env.production.local` deployments through the
  first TLS release.
- Make a bad trusted-origin or proxy-trust configuration fail before it can lock out sign-in.
- Prove the result from a second LAN device through the real UI, not only with config inspection.

## Non-goals

- No Tailscale, Funnel, VPN, router, DNS-server, dynamic-DNS, or domain-registration automation.
- No automatic installation of a CA root on client devices.
- No magic `jarvis.lan`/mDNS name. The operator supplies a stable LAN DNS name or reserved IP.
- No custom certificate upload, `mkcert` helper, DNS-01 provider plugin, Traefik variant, or second
  proxy implementation in v1.
- No forced HTTP-to-HTTPS migration and no removal of `:1533` in this parent issue.
- No Kubernetes, native-systemd, or arbitrary existing-reverse-proxy automation. Those operators
  may use the documented origin/proxy-header contract without starting bundled Caddy.
- No web settings UI or privileged self-operation flow. Those need their own approved product
  spec and consent model.

## Locked design

### 1. Bundled configuration, opt-in activation

Add a `caddy` service to `infra/docker-compose.prod.yml` with `profiles: ["tls"]`. The committed
stack therefore contains the supported TLS path, but today's command without `--profile tls`
does not create the proxy, bind new ports, or change reachability.

The service:

- uses a patch-version-pinned Caddy Alpine image (and digest if the repo's image policy supports
  it), never `latest`;
- publishes host ports 80 and 443;
- reverse-proxies only to `jarv1s:3000` on the existing Compose network;
- persists `/data` and `/config` in named volumes so certificates and the internal CA survive
  container replacement;
- mounts the committed Caddyfile read-only;
- receives only explicit `JARVIS_TLS_HOST` and `JARVIS_TLS_ISSUER` environment entries and never
  inherits the application `env_file` or its database, auth, connector, AI, or RPC secrets;
- runs with an effective non-zero UID/GID, a read-only root filesystem, and all Linux capabilities
  dropped; if binding the chosen in-container ports demonstrably requires a capability, only
  `NET_BIND_SERVICE` may be added. The named `/data` and `/config` volumes, plus a bounded tmpfs if
  Caddy requires one, are its only writable paths;
- publishes neither the Caddy admin endpoint nor a Docker socket and uses no privileged or host
  network mode; and
- waits for the existing `jarv1s` health check before starting.

The same Compose change explicitly forwards the two non-secret TLS values into the existing
`setup` service. It uses empty/default-safe interpolation so parsing the Compose file without the
`tls` profile has exactly the old environment requirements. Compose does not implicitly pass host
shell variables into a container, so this wiring belongs to the Compose child rather than the setup
script child.

The direct `${JARVIS_WEB_PORT:-1533}:3000` mapping stays present. HTTPS is the recommended URL and
the only URL on which secure-context features are accepted as working; retained HTTP is a rollback
and bookmark-compatibility path, not an equivalent mode.

### 2. Certificate model

The required operator input is `JARVIS_TLS_HOST`, containing one DNS hostname or IPv4 address only
— no scheme, userinfo, port, path, query, fragment, wildcard, whitespace, newline, multiple-host
separator, or Caddyfile placeholder/metacharacter. A stable LAN DNS name is preferable; a reserved
LAN IPv4 address is valid. IPv6, bracketed or bare, is rejected in v1 so setup and Caddy site-address
parsing cannot disagree; a later issue may add it with an explicit URL/rendering test matrix.
An IPv4 literal is valid only with the `internal` issuer. `acme` plus any IPv4 literal is rejected
before activation because public ACME cannot validate a reserved LAN address.

`JARVIS_TLS_ISSUER` has exactly two supported values:

| Value      | Default | Certificate source | Operator requirements                                                                |
| ---------- | ------- | ------------------ | ------------------------------------------------------------------------------------ |
| `internal` | yes     | Caddy local CA     | Install Caddy's exported root certificate on each client and explicitly enable trust |
| `acme`     | no      | Caddy ACME issuer  | Publicly valid domain, correct DNS, and reachable validation ports 80/443            |

The Caddyfile selects the named issuer and proxies to `jarv1s:3000`; there are not separate proxy
stacks for the two modes. Internal-CA mode exports only the public root certificate for device
installation. Its private key stays in the protected Caddy data volume and must never enter the
repo, an env file, logs, a PR comment, or a support bundle. Losing the volume rotates the local CA
and requires every client to trust the replacement, so the runbook includes protected backup and
restore guidance.

A browser warning bypass and `curl -k` are not successful verification: the client must validate
the certificate chain. Moss never claims that an untrusted certificate creates a usable secure
context.

### 3. Port and URL model

- New preferred URL: `https://<JARVIS_TLS_HOST>` on host port 443, with no explicit port.
- Port 80 exists only for Caddy's HTTPS redirect and ACME HTTP validation.
- Existing URL: `http://<host>:${JARVIS_WEB_PORT:-1533}` remains reachable and is not redirected
  in this delivery.
- A configurable nonstandard HTTPS port is deliberately omitted. An operator whose host already
  uses 80/443 should keep their existing reverse proxy and follow the same trusted-origin and
  forwarded-header contract; adding port-remapping plus correct redirects/ACME behavior would make
  the common path harder to reason about.

This side-by-side model is the smallest safe migration. A later issue may retire HTTP only after
telemetry or operator feedback shows that bookmarks, integrations, and recovery access have moved.

### 4. Auth origin and proxy contract

When `JARVIS_TLS_HOST` is set for a new setup, the generated trusted-origins list contains the
exact `https://<JARVIS_TLS_HOST>` origin in addition to the existing localhost and any explicitly
preserved public origin. Values are normalized, deduplicated, and contain no path or trailing
slash.

An explicit `JARVIS_AUTH_TRUSTED_ORIGINS` override stays authoritative for backward compatibility,
but setup fails closed if TLS is requested and the override omits the exact HTTPS origin. It must
not generate a deployment that starts successfully and then returns 403 on sign-in.

#1486 is a prerequisite, not duplicated here. Its result must let production configure
`JARVIS_TRUST_PROXY` no broader than the Compose bridge CIDR (`JARVIS_DOCKER_SUBNET`, default
`10.251.0.0/24`) while retaining a safe loopback value for #1403's host-dev path. A tighter static
Caddy address is acceptable if #1486 establishes it. A bare boolean `true` is not acceptable. The
#1486 prerequisite check must account for host-local `:1533` traffic potentially sourcing from the
bridge gateway under Docker's userland proxy; on-box clients must not gain forwarded-header trust.

Caddy's normal reverse-proxy behavior supplies `X-Forwarded-For`, `X-Forwarded-Host`, and
`X-Forwarded-Proto=https`. Do not forward a client-supplied value unchanged. Rate limiting must
key the real client address, Better Auth must issue secure cookies on HTTPS, and the HTTPS origin
must sign in without 403.

`JARVIS_AUTH_BASE_URL` does not change to the public HTTPS origin. It remains the API process's
independent in-container base URL, as established by the existing setup code and tests.

## Backward-compatible migration

### Existing installs

Pulling the release and running the existing Compose command is a no-op for TLS: the profile is not
active, port 1533 remains published, and the existing env file is untouched.

The opt-in migration is ordered and additive:

1. Back up `env.production.local` and the application data using the existing deploy runbook.
2. Choose a stable `JARVIS_TLS_HOST` and `internal` or `acme` issuer.
3. Add the TLS host/issuer and the #1486-approved Compose bridge CIDR trust value to the existing
   env file.
4. Append the exact HTTPS origin to `JARVIS_AUTH_TRUSTED_ORIGINS`; preserve localhost and every
   working old HTTP/domain origin. Never replace the whole list with the new origin.
5. Render and inspect `docker compose --profile tls config`, then start with `--profile tls`.
6. In internal mode, export only the root certificate and trust it on the second device.
7. Prove readiness and sign-in through HTTPS before changing bookmarks or client integrations.
8. Keep `:1533` available for rollback. Removing it is outside this issue.

If HTTPS validation fails, stop the `tls` profile and restore the backed-up env file. The existing
HTTP path remains the recovery route. There is no database migration and no secret rotation.

### New installs

The setup service receives the TLS host and issuer through Child 1's explicit Compose environment
wiring before it creates `env.production.local`. Child 2 validates and emits those non-secret
values, adds the exact HTTPS trusted origin, and emits the scoped proxy CIDR. With no TLS host, its
current output and localhost-only default remain unchanged. Setup continues to refuse overwriting
an existing env file.

## Security and failure behavior

- #901 is **security tier**: it changes a network-exposed surface, forwarded-header trust, auth
  origins, cookies, and certificate material.
- Caddy certificate/CA keys persist only in its named data volume. Only the public root certificate
  leaves that volume in internal mode.
- Invalid host syntax, an unsupported issuer, a missing HTTPS trusted origin, or a broad/boolean
  proxy-trust value fails during new-install setup or the required Caddy validation preflight,
  before the TLS service is activated, with an actionable message.
- Caddy config validation can prove the `internal` and `acme` configurations parse, but it cannot
  preflight public DNS propagation or inbound reachability. ACME failures therefore surface as
  bounded, actionable Caddy issuance diagnostics and a failed HTTPS readiness check; the spec does
  not claim they fail before the Caddy process starts.
- Neither the Caddy admin API nor the Moss container's internal port 3000 is published by the new
  service. The pre-existing host mapping remains the only direct HTTP surface.
- The Caddy service receives no application env file or application secrets and has no writable
  root filesystem beyond its declared certificate/config volumes.
- The default internal-CA flow does not require router port forwarding or public DNS. ACME's public
  exposure is an explicit operator choice documented before the enable command.
- Logs and live-proof comments contain hostnames only when the operator considers them safe; they
  never contain CA private keys, auth secrets, session cookies, or the full env file.

## Parent acceptance criteria

- [ ] Running the normal production Compose command without `--profile tls` has the same services,
      port 1533 behavior, and env requirements as before.
- [ ] `docker compose --profile tls config` renders a pinned, unprivileged Caddy service on ports
      80/443 with persistent certificate storage and `jarv1s:3000` as its only upstream.
- [ ] Rendered Caddy config has an effective non-root user, the locked filesystem/capability policy,
      only the two non-secret TLS environment values, and no application `env_file` or secrets.
- [ ] A fresh internal-CA install derives the exact HTTPS trusted origin and a scoped trusted-proxy
      value without rotating or exposing any application secret.
- [ ] An existing env file can be migrated additively; its old HTTP origin continues to sign in
      after TLS starts.
- [ ] From a second LAN device that trusts the Caddy root: the HTTPS page has a valid certificate,
      sign-in succeeds without 403, `window.isSecureContext === true`, voice input obtains a media
      stream, and the service worker reaches `activated`.
- [ ] `/health/ready` succeeds through HTTPS without `-k`, and the direct localhost/HTTP dev flow
      remains green.
- [ ] A direct `:1533` client cannot influence client IP or secure-proto handling with forged
      `X-Forwarded-*` headers.
- [ ] ACME mode renders and validates locally; the runbook names the DNS/port prerequisites, the
      exact Caddy diagnostics/readiness checks for issuance failure, and does not claim a local
      preflight can prove public reachability. Public issuance is not required for the default
      internal-CA live proof.
- [ ] Live-path evidence is recorded on Child 4, every open user-facing build PR, and parent #901
      before those PRs merge.

## Ordered child-task decomposition

Parent #901 remains a **roll-up only**. The coordinator must create and dispatch the child issues;
no build agent should own the whole parent. Each child below has a narrow, exclusive surface and is
sized for one agent session.

### Prerequisite gate — existing issues, no new child

- #1403 merged with its dev-instance secure-context proof.
- #1486 merged with an explicit loopback/CIDR proxy-trust contract and tests. If #1486 chooses an
  incompatible env name or shape, update this spec before dispatching children 1-2; do not improvise
  two proxy-trust contracts in parallel.

### Child 1 — Compose proxy

**Suggested title:** `[TLS 1/4] Add the opt-in Caddy profile to production Compose`

**Risk:** security

**Depends on:** #1403 and #1486

**Exclusive ownership:** `infra/docker-compose.prod.yml`, new `infra/caddy/Caddyfile`, and the
Caddy-specific assertions in `tests/unit/prod-deploy-config.test.ts`

**Deliverables:** add the profile-gated, pinned Caddy service; ports 80/443; named data/config
volumes; read-only Caddyfile and root filesystem; effective non-root UID/GID; dropped capabilities
with only a demonstrated `NET_BIND_SERVICE` exception; internal/acme issuer selection; health
dependency; and `jarv1s:3000` reverse proxy. Give Caddy only explicit non-secret host/issuer env
entries, never the application env file. In the same owned Compose file, explicitly forward those
two values to the `setup` service with defaults that do not add profile-free env requirements.

**Acceptance checks:**

- with both TLS variables unset, normal `docker compose config --services` lists the same service
  set and does not activate Caddy; full `docker compose config` separately proves the unchanged
  port 1533 and env requirements;
- `docker compose --profile tls config` renders Caddy and contains no `latest`, privileged mode,
  host networking, Docker socket, or published admin endpoint;
- rendered Caddy has a non-zero user, read-only root filesystem, the locked capability set, only
  `/data`, `/config`, and any documented bounded tmpfs writable, and no application `env_file` or
  application-secret environment entries;
- rendered setup config explicitly receives only `JARVIS_TLS_HOST` and `JARVIS_TLS_ISSUER` from
  the new TLS contract, proving the real Compose setup path reaches Child 2's script;
- config validation proves the host and issuer placeholders parse in both `internal` and `acme`
  modes and rejects invalid host/issuer values without activating the service; and
- `pnpm exec vitest run tests/unit/prod-deploy-config.test.ts` passes.

### Child 2 — Setup and no-lockout origin migration

**Suggested title:** `[TLS 2/4] Generate TLS origins and scoped proxy trust in production setup`

**Risk:** security

**Depends on:** #1403 and #1486; may run in parallel with child 1

**Exclusive ownership:** `scripts/setup-prod.ts`, `scripts/setup-prod-origins.ts`,
`tests/unit/setup-prod-trusted-origins.test.ts`, and the TLS block in
`infra/env.production.example`

**Deliverables:** accept only a DNS hostname or IPv4 address; reject IPv6, `acme` plus any IPv4
literal, and every forbidden host class locked above; validate the exact `internal | acme` issuer union; derive and deduplicate
`https://<host>`; preserve existing origin behavior; fail when an explicit override omits the
requested HTTPS origin; emit the TLS settings and #1486-approved CIDR trust only when opted in; keep
setup's no-overwrite guard; and correct `infra/env.production.example` so
`JARVIS_AUTH_BASE_URL` is documented as the independent in-container URL rather than the public TLS
origin.

**Acceptance checks:** focused pure-helper cases cover internal and ACME hosts, deduplication, the
full forbidden-host matrix including `acme` plus IPv4, exact issuer rejection, override omission, no-TLS behavior, and a
non-default `JARVIS_DOCKER_SUBNET`. Subprocess cases run the real `setup-prod.ts` against a temporary
directory and prove: valid TLS input writes the host, issuer, exact HTTPS origin, scoped CIDR, and
independent base URL; invalid input exits non-zero before creating a file; an existing file is never
replaced; and no-TLS output keeps the prior relevant keys and defaults. The env-example assertion
must enforce the independent base-URL contract. Then
`pnpm exec vitest run tests/unit/setup-prod-trusted-origins.test.ts` passes.

### Child 3 — Operator runbook

**Suggested title:** `[TLS 3/4] Publish internal-CA, ACME, rollback, and upgrade runbooks`

**Risk:** security documentation

**Depends on:** children 1 and 2 code-complete with their contracts frozen on open PRs; the
Coordinator records the second-device OS/browser pair that Child 4 will use

**Exclusive ownership:** new `docs/operations/self-hosted-tls.md` and a link from
`docs/operations/deploy.md`

**Deliverables:** exact enable/disable commands; stable-host guidance; internal root-certificate
export and OS/browser trust steps; ACME prerequisites; existing-env additive migration; Caddy data
backup/restore; trusted-origin 403 diagnosis; scoped proxy-trust diagnosis; and rollback to 1533.
All checkout paths use `~/Jarv1s`; examples contain placeholders, never real hostnames or secrets.
Run the exact Caddy validation preflight before the first profile activation so manually migrated
existing env files receive the same host/issuer fail-closed behavior as new setup.
Before activation, run an explicit secret-safe check that the exact
`https://<JARVIS_TLS_HOST>` origin is present in `JARVIS_AUTH_TRUSTED_ORIGINS`; Caddy validation
cannot inspect that application setting.
Give exact trust-store/browser instructions only for the recorded v1 proof OS/browser pair. For
other platforms, link Caddy's public-root guidance and the platform vendor's current trust
documentation and label them unverified rather than attempting an unbounded OS/browser matrix.
Include exact, secret-safe black-box commands for Child 4's direct-1533 forwarded-header checks,
using the merged #1486 contract.

**Acceptance checks:** an operator can follow the internal-CA path without reading source; every
command matches the frozen Compose/env contract; the selected client platform has an exact trust
procedure; other platforms are explicitly linked/unverified; no step uses `curl -k`, copies a CA
private key, overwrites an env file, rotates a secret, or implies that LAN port binding creates
public exposure. The ACME section distinguishes local config validation from public issuance and
points to the exact bounded Caddy diagnostics and HTTPS readiness check when DNS/ports are wrong.

### Child 4 — Independent live-path proof

**Suggested title:** `[TLS 4/4] Prove distributable HTTPS from a second LAN device`

**Risk:** security acceptance

**Depends on:** children 1-3 code-complete on open PRs and assembled into an integration candidate;
the selected second LAN device is available with the runbook's root-trust steps; and a working
transcription endpoint is configured through the real Settings path using an operator-owned secret
that will not appear in evidence

**Exclusive ownership:** runtime evidence only; no source or documentation edits

**Deliverables:** deploy the internal-CA default from a clean or backed-up production Compose
install, trust only the public root on a second device, exercise the real UI and health route, and
record redacted evidence on the child and parent issues and on every open user-facing build PR.

**Acceptance checks:** from the selected device, owner sign-in succeeds through the real UI, the
browser trusts the chain, `window.isSecureContext === true`, the service worker reaches `activated`,
and the enabled mic control obtains a media stream without exposing the transcription credential.
`/health/ready` passes without `-k`, and old HTTP sign-in remains available. The runbook's direct
`:1533` probes must show that rotating forged `X-Forwarded-For` values cannot escape one real-client
rate-limit bucket and that adding forged `X-Forwarded-Proto: https`/forwarded host does not change
the same HTTP auth probe's scheme-sensitive status, redirect, or cookie behavior. Stopping the
profile restores the pre-TLS topology. Evidence names the candidate SHA, client OS/browser, exact
redacted results, and contains no hostname the operator considers private, credential, cookie, or
full env file. If the device, microphone permission, or configured transcription route is absent,
this child is not dispatched or stays open; host-side Playwright is diagnostic only and does not
satisfy the second-device gate.

## Coordinator batching and close rule

- **Follow-up batch A:** after #1403 and #1486, dispatch children 1 and 2 in parallel. Their owned
  files do not overlap; Child 1 owns the already-locked Compose-to-setup env contract.
- **Follow-up batch B:** once both build contracts are frozen and code-complete on open PRs, dispatch
  Child 3 for the selected proof platform. Do not merge the build PRs yet.
- **Follow-up batch C:** assemble the three open-PR heads into an integration candidate and dispatch
  Child 4 only when the selected device and secret-safe transcription route are ready.
- Child 4 posts the real-UI artifacts on every user-facing build PR before security QA/Ben sign-off
  and merge. Only then may the build PRs merge and their child issues close. Close parent #901 when
  all four children are closed and the parent links the evidence. Green config/unit checks after
  children 1-3 mean **code-complete, unverified**, not done.
