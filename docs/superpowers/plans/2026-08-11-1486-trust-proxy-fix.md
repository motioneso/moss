# Build Plan — #1486 exact trust-proxy configuration

**Issue:** #1486 (`motioneso/moss`)
**Risk:** security — forwarded-header trust changes the rate-limit and secure-cookie boundary.
**Scope:** parse `JARVIS_TRUST_PROXY` as an explicit trust value, wire that value into Fastify,
and update the operator contract. Do not add the future Caddy service here; the #901 Compose child
owns `infra/docker-compose.prod.yml` and its static `ipv4_address`.

## Verified seams

- `apps/api/src/server.ts:217-222` constructs Fastify and currently passes
  `trustProxy: !!resolveMossEnv(...)`, so the vulnerable boolean coercion is still present.
- `apps/api/src/server.ts:236-264` configures HSTS separately from Fastify and currently treats
  any non-empty `JARVIS_TRUST_PROXY` value as a valid TLS-proxy signal.
- `apps/api/src/server.ts:150-165` shows `resolveApiServerConfig` is pure and env-injected; the
  trust parser can follow the same exported pure-helper test pattern without a database.
- `packages/db/src/env.ts:86-106` shows `resolveMossEnv` already handles the JARVIS/MOSS env-name
  compatibility layer; the new parser must consume its resolved value.
- `apps/api/src/server.ts:768-792` and `:887-896` consume Fastify's derived peer/protocol values,
  so configuring Fastify once at the composition root covers the rate-limit and Better Auth paths.
- `infra/docker-compose.prod.yml:218-222` has the operator-pinned `jarv1s` subnet but no Caddy
  service. The exact Caddy `ipv4_address` belongs to the separate #901 Compose child.
- `docs/operations/dev-environment.md:49-70` still documents `JARVIS_TRUST_PROXY=1` and calls
  the narrower value a follow-up; this is stale after the #1486 ruling.
- `infra/env.production.example:6-15` documents the production network/env contract but has no
  `JARVIS_TRUST_PROXY` entry.

## Decisions

- Add the exported pure signature
  `resolveTrustProxy(value: string | undefined): false | string | string[]` in
  `apps/api/src/server.ts`.
- Return `false` for unset, empty, or whitespace-only values; return the Fastify `loopback`
  keyword for case-insensitive `loopback`; return one exact IP string or a trimmed array of exact
  IPs for a comma-separated list. Validate each address with the Node standard library and reject
  CIDRs, hostnames, empty list members, and all other values.
- Throw during `createApiServer` construction, before database/client setup, for legacy boolean
  values (`1`, `true`, `yes`, `on`, case-insensitive) and every malformed value. The error is one
  line and names the accepted format without echoing the input.
- Derive the HSTS enablement from the parsed setting (`setting !== false`) so malformed values
  cannot enable headers and valid values cannot disagree between Fastify and Helmet.
- Keep the production Compose file unchanged in this lane. The env contract will say that
  production must use the exact static Caddy IP selected by #901, never the bridge CIDR or gateway;
  `loopback` remains the host-dev `tailscale serve` value.

## Phase 1 — parser, wiring, and regression coverage

Files: `apps/api/src/server.ts`, `tests/unit/api-server-config.test.ts`.

- Add the parser and call it once at the top of `createApiServer`.
- Pass its result directly as Fastify's `trustProxy` value and reuse its validity for HSTS.
- Extend the focused unit suite with unset/empty, loopback, single IPv4/IPv6, comma-separated
  exact-IP, CIDR rejection, legacy-value rejection, and malformed-value rejection cases. The tests
  must assert the actionable error contract and prove the parser cannot silently fall back to
  trust-all or no-trust.
- Run the focused test and TypeScript check; the observed pass is the phase's live wiring proof.

**Kill gate (owner: build agent; escalate to Coordinator):** stop if Fastify's installed type or
runtime contract cannot accept the exact-IP list without a CIDR/function adapter, or if the focused
integration path shows HSTS and forwarded-header behavior cannot share the parsed validity signal.
Do not broaden trust to make the gate pass.

## Phase 2 — operator contract correction

Files: `docs/operations/dev-environment.md`, `infra/env.production.example`,
`docs/superpowers/specs/2026-08-10-self-hosted-tls.md`.

- Replace the host-dev boolean example with `JARVIS_TRUST_PROXY=loopback` and document the valid
  forms, fail-loud legacy behavior, and the exact-IP/no-CIDR production rule.
- Add the production env entry/comment without inventing a Caddy service or secret.
- Correct the superseded #901 trust-value wording from bridge-CIDR fallback to the exact static
  Caddy IP established by #1486, including the setup acceptance wording that still says CIDR.
- Verify no operator-facing documentation in the owned files still recommends `=1`, `true`,
  `yes`, `on`, or a bridge CIDR for this setting.

## Verification

- `pnpm exec vitest run tests/unit/api-server-config.test.ts` — expected exit 0.
- `pnpm format:check` — expected exit 0.
- `pnpm lint` — expected exit 0.
- `pnpm typecheck` — expected exit 0.
- `rg -n 'JARVIS_TRUST_PROXY=(1|true|yes|on)|bridge CIDR|JARVIS_DOCKER_SUBNET.*trust' apps infra docs` —
  expected exit 1 for no stale recommendation; inspect any unrelated historical audit/spec hits
  before treating the result as a failure.

The PR description must state the merge hold: production currently carries legacy
`JARVIS_TRUST_PROXY=1`; Ben must migrate that env before merge/deploy, per
`docs/coordination/AWAITING-BEN.md`. Open the PR and report it as ready-to-merge-pending-Ben;
never merge from this lane.
