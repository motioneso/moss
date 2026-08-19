# w6a — secure context over tailnet HTTPS (#1403)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-6-secure-context-and-weather.md`, Lane A.
**Issue:** #1403 (task issue exists on GitHub; no new issue needed per spec Process gates).
**Tier:** security — Fable does plan review, adversarial QA, and merge sign-off this run
(`docs/coordination/2026-08-09-waves-3-6.md`).
**Grounded on:** this worktree/branch `w6a-secure-context`, tree HEAD `ca1be8622`, `origin/main`
unchanged since spec's `c8946358f`.
**Scope:** dev instance + runbook doc only. Prod is out of scope (spec Non-goals: "Ben applies the
prod half").

## Seams check (file:line citations)

1. Trusted-origins logic is pure env config, not code: `resolveAuthOriginConfig`
   (`packages/auth/src/runtime-config.ts:8-16`) reads `JARVIS_AUTH_TRUSTED_ORIGINS`
   (comma-split/trim/filter) or derives from `JARVIS_AUTH_BASE_URL`/`BETTER_AUTH_URL`/`PORT`. No
   `server.ts` code change is needed to add the tailnet origin.
2. `JARVIS_TRUST_PROXY` gates Fastify `trustProxy` (`apps/api/src/server.ts:221`,
   `trustProxy: !!resolveMossEnv(process.env, "JARVIS_TRUST_PROXY")`), which in turn gates HSTS
   emission (`server.ts:236-264`), XFF-based `request.ip` feeding the rate limiter
   (`server.ts:767-791`), and whether Better Auth issues the `__Secure-`-prefixed session cookie
   (`server.ts:742-746`; `toWebRequest` at `:886-905` builds the request URL from
   `request.protocol`/`request.host`, which only honor XFF when this flag is set). Zero mentions in
   `infra/`, `scripts/setup-prod.ts`, or `docs/operations/dev-environment.md` today — this is the
   core missing runbook piece.
3. `/health` and `/health/ready` are already rate-limit-exempt (`server.ts:291`) — no change needed
   for that exit criterion.
4. Doc target: `docs/operations/dev-environment.md`, "Local / LAN dev run" section (lines 6-31,
   confirmed present, plain-HTTP tailnet note at line 17, trusted-origins recipe at lines 22-31).
   New subsection goes here, not a new file.
5. Host tailscale state (live, confirmed this session): connected, host `xbmx-1`, tailnet
   `tail284f31.ts.net`, self IP `100.64.98.99`. Two unrelated entries already running
   (`tailscale serve status`): `:3032 -> 127.0.0.1:3031`, `:8443 -> 127.0.0.1:8001`, both set up
   ad hoc outside this repo. `tailscale serve --help` confirms exact syntax:
   `tailscale serve --bg --https=<port> <target>`. Port `8444` is free (not in `tailscale serve
status`, not in `ss -ltnp` on this host).
6. `gh issue view --json body` is broken for #1403 (`<<ccr:...>>` placeholder) — use
   `gh api repos/motioneso/moss/issues/1403 --jq .body` if the body needs re-reading.
7. #1403 exit criteria (spec, "Exit criteria" section): voice input works from a second device on
   the tailnet over `https://`; sign-in succeeds from that origin (403 is the failure mode);
   service worker registers; health/readiness stay reachable; plain-HTTP `localhost` dev flow is
   unregressed. Spec Non-goals explicitly excludes install-to-home-screen verification — only
   _registration_ is in scope.
8. Host is shared — other sessions run live dev servers/DBs. Isolated dev instance required per
   `docs/operations/dev-environment.md`'s multi-agent recipe (lines 44-58): own Postgres DB
   (`jarv1s_w6a`), own ports. Confirmed free by `ss -ltnp`: API port `3098`.
9. Bans: no `tailscale funnel` (LAN-only via `serve`); no secrets in any doc/payload/log (this
   includes Ben's dev login from `dev-instance-lan-spinup-trusted-origins` memory — reference the
   memory file in any handoff, never paste the credential into a committed doc); no prod changes.

## Topology decision — supersedes relay #2's nginx framing (ledger below)

The prior relay's handoff (`docs/superpowers/handoffs/2026-08-09-w6a-secure-context-relay.md`,
items 12-16) framed this as a fork between "bare-process `pnpm dev`" and "containerized/nginx".
Both were re-verified this session and **neither is the right target**:

- **Bare-process `pnpm dev`** — confirmed still true: `apps/web/vite.config.ts:18-20`
  unconditionally overwrites the request `Origin` header to `apiTarget` before it reaches the API,
  so trusted-origins is a no-op there; and `apps/web/src/pwa/register-service-worker.ts:2` gates
  registration on `!import.meta.env.PROD`, which is always false under `vite dev` — the service
  worker exit criterion is **unsatisfiable** on this topology, full stop.
- **Containerized/nginx** (`apps/web/Dockerfile` + `infra/nginx/jarv1s-web.conf`) — re-verified
  this session to be a **stale/superseded artifact**, not what the repo actually deploys. Neither
  file is referenced by `infra/docker-compose.yml` (its `web` service runs `pnpm dev:web` in a raw
  node container — same bare-process/vite-proxy topology as above, just containerized) nor by
  `infra/docker-compose.prod.yml` (which builds a single image from the **root** `Dockerfile` and
  runs one `jarv1s` container serving API + static web together — see below). The only references
  left to the nginx artifact are historical plans (`docs/superpowers/plans/2026-06-12-p2-deployable-stack.md`,
  `2026-06-25-two-container-deploy.md` — the latter's title is literally "remove `apps/web/Dockerfile`
  and `WEB_IMAGE` handling") and CSP-parity plumbing in `apps/api/src/static-web.ts:32-34` and
  `tests/unit/static-web-csp.test.ts` (kept in sync as a leftover, not because nginx runs anywhere
  live). Building this topology for #1403 would mean standing up dead infrastructure.

**What the repo actually runs in prod, and what this plan targets:** a **single process serves
both the API and the built static SPA on one origin.**
`apps/api/src/static-web.ts:55-68` (`registerStaticWeb`, called unconditionally at
`server.ts:589`) sets a Fastify not-found handler that serves `apps/web/dist` — including SPA
fallback — from `defaultWebDistDir()` (`static-web.ts:48-52`: `JARVIS_WEB_DIST_DIR` env or
`resolve(process.cwd(), "apps/web/dist")`), and no-ops safely (logs, returns `false`) if that dir
doesn't exist. `infra/docker-compose.prod.yml`'s `jarv1s` service runs exactly this: root
`Dockerfile` sets `ENV JARVIS_WEB_DIST_DIR=/app/apps/web/dist` and starts one container — no nginx,
no second origin. This plan reproduces the same shape as a **bare process** on the dev box: `pnpm
build:web` once, then start the API pointed at that dist dir. Consequences:

- **No vite, no proxy, no Origin-rewriting** — the browser's real Origin header reaches the API
  unmodified, so `JARVIS_AUTH_TRUSTED_ORIGINS` is live and load-bearing here (confirming the
  spec's original claim, just via this mechanism instead of nginx).
- **Service worker registers** — `import.meta.env.PROD` is `true` in a `vite build` output, so the
  gate at `register-service-worker.ts:2` passes.
- **Zero code changes** — everything is env config + one build step + a `tailscale serve` entry +
  the doc runbook. Matches spec's Lane A owned surface ("`infra/`, compose, `apps/api/src/server.ts`
  trusted-origins config, docs runbook") without needing to touch `infra/` or compose at all — a
  deviation worth flagging to Fable/coordinator explicitly (see Open questions).
- **`pnpm --filter @moss/api start` runs with cwd = `apps/api`** (confirmed empirically:
  `pnpm --filter @moss/api exec pwd` → `.../apps/api`), so `defaultWebDistDir()`'s
  `process.cwd()`-relative fallback resolves to the wrong path. `JARVIS_WEB_DIST_DIR` must be set
  explicitly to an **absolute** path to the repo's `apps/web/dist`, matching the Dockerfile's own
  pattern — a real gotcha this seams check caught before build.

This resolves the handoff's open item #15 (`vite preview` proxy behavior) as moot — this topology
uses neither `vite dev` nor `vite preview`.

## Determinism boundary

N/A — infra/docs-only lane. No model-authored content, no UI code path, no chat/agent surface
touched. States this explicitly per `plan-build`'s requirement.

## UAT scope decision

No `tests/uat/specs/*.uat.spec.ts` and no `uat-trigger-map.tsv` row planned. Rationale: this lane
changes zero UI code and zero routes — only how the already-built instance is reached (network
config) — so there is no new component/interaction for Playwright to drive. The exit criteria
(secure-context mic access, service-worker registration, sign-in over a real tailnet origin) are
inherently properties of a **real browser on a real second device** reached over the tailnet, not
reproducible in a headless Playwright run against `localhost`. Live-path proof for this lane is a
manual verification checklist (Task 5 below) executed against the live dev instance and recorded
in the PR, per `coordinated-build`'s live-path gate. Flagging this interpretation explicitly for
Fable to confirm or override.

## Phase 1 (single phase) — build, wire, verify, document

### Task 1 — Baseline control: prove the plain-HTTP path is unregressed first

Before changing anything, confirm the existing bare-process flow still works, so the "unregressed"
exit criterion has a documented before/after rather than an assumption.

- `pnpm --filter @moss/web dev -- --host &` / `pnpm dev:api` per the existing doc recipe (lines
  9-13), against a scratch DB, confirm `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health`
  → `200`, and one sign-in POST succeeds. Tear down before Task 2.
- Test: manual curl above; behaviour it must catch — a broken baseline would falsely blame this
  lane's changes for a pre-existing regression.

### Task 2 — Provision the isolated `w6a` dev instance

```bash
docker exec jarv1s-postgres psql -U postgres -c 'CREATE DATABASE jarv1s_w6a;'
JARVIS_PGDATABASE=jarv1s_w6a pnpm db:migrate
```

Expected: `CREATE DATABASE` then migrate exits 0 with no hash-mismatch errors (per
`gate-db-isolation-mandatory` / multi-agent recipe in `docs/operations/dev-environment.md:44-58`).

### Task 3 — Build the SPA once

```bash
pnpm build:web
```

Expected exit 0; verify `test -f apps/web/dist/index.html && echo PRESENT`.

### Task 4 — Start the API in the single-process topology

**Fable security review (required change 1): bind loopback, not `0.0.0.0`.** `tailscale serve`
targets `http://127.0.0.1:3098` — the API process never needs to be LAN/tailnet-reachable
directly. With `JARVIS_TRUST_PROXY=1` coercing Fastify's `trustProxy` to a bare `true`
(`server.ts:221`), any peer that CAN reach the port can spoof `X-Forwarded-For` and mint a fresh
per-IP rate-limit bucket per request — and `/api/auth/*` keys its pre-auth rate limit by IP, so on
`0.0.0.0` this is an unbounded credential-brute-force primitive, plus a plain-HTTP side door
around the HTTPS-only origin. Loopback bind closes it: the only XFF-capable peers become
`tailscale serve` and same-host processes, both already inside the trust boundary.

```bash
PORT=3098 \
HOST=127.0.0.1 \
JARVIS_PGDATABASE=jarv1s_w6a \
JARVIS_TRUST_PROXY=1 \
JARVIS_AUTH_TRUSTED_ORIGINS="https://xbmx-1.tail284f31.ts.net:8444" \
JARVIS_WEB_DIST_DIR="$(pwd)/apps/web/dist" \
pnpm start:api
```

Verify locally first (before wiring tailscale): `curl -s http://localhost:3098/health` → `200`;
`curl -s http://localhost:3098/` → SPA `index.html` (not a 404 falling through to Fastify's
default handler); confirm `curl -s http://100.64.98.99:3098/health` (the host's tailnet IP)
**fails to connect** — proof the API is not reachable except through `tailscale serve`.

### Task 5 — Wire `tailscale serve` and run the live-proof checklist

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:3098
tailscale serve status   # confirm the new entry alongside the two pre-existing ones
```

Live-proof checklist (from a **second, non-host tailnet device** where possible; note any step
that had to fall back to host-side `curl` and why):

1. `curl -s -o /dev/null -w '%{http_code}\n' https://xbmx-1.tail284f31.ts.net:8444/health` → `200`.
2. Load `https://xbmx-1.tail284f31.ts.net:8444/` in a real browser on the second device; sign in
   with the dev credential (from the `dev-instance-lan-spinup-trusted-origins` memory — do not
   paste it into the PR or this plan); confirm no 403 and a session is established.
3. In that browser's devtools console: `window.isSecureContext` → `true`.
4. Open the chat composer and confirm `navigator.mediaDevices` is defined and mic permission can be
   requested (does not need to fully record — #900's error-classification fix is a separate lane).
5. Confirm the service worker registered: devtools → Application → Service Workers shows an active
   worker for the tailnet origin (or `navigator.serviceWorker.getRegistrations()` in console
   returns a non-empty array).
6. Re-run Task 1's baseline check unchanged (`pnpm dev:api` on `:3000`, no `JARVIS_TRUST_PROXY`, no
   tailnet origin) and confirm it still signs in — proves the new env vars are additive, not a
   default-behavior change.

### Task 6 — Runbook doc update

Add a new subsection to `docs/operations/dev-environment.md` immediately after "Local / LAN dev
run" (after line 31), titled `### LAN dev run over tailnet HTTPS`. Exact prose (decision, not
boilerplate — this is the deliverable):

````markdown
### LAN dev run over tailnet HTTPS

Plain HTTP unlocks LAN reachability but not the browser features gated behind a secure context
(microphone, PWA install, precise geolocation) — those need `https://`. `tailscale serve` fronts
the app with a tailnet-scoped HTTPS certificate without any public exposure (no `tailscale funnel`
is used or needed here).

This topology serves the API and the built web bundle from **one process on one origin** — it does
not use `vite dev` or a second web process. The vite dev proxy unconditionally rewrites the
request `Origin` header, which makes `JARVIS_AUTH_TRUSTED_ORIGINS` a no-op under `pnpm dev`, and
the PWA service worker only registers in a production build (`import.meta.env.PROD`). Build once,
then serve:

```sh
pnpm build:web

PORT=3098 \
HOST=127.0.0.1 \
JARVIS_TRUST_PROXY=1 \
JARVIS_AUTH_TRUSTED_ORIGINS="https://<machine>.<tailnet>.ts.net:<port>" \
JARVIS_WEB_DIST_DIR="$(pwd)/apps/web/dist" \
pnpm start:api

tailscale serve --bg --https=<port> http://127.0.0.1:3098
```
````

`JARVIS_TRUST_PROXY=1` tells Fastify to trust `X-Forwarded-*` from `tailscale serve`; without it,
HSTS is not emitted, Better Auth won't issue the `__Secure-`-prefixed session cookie, and the
rate limiter keys on the proxy's IP instead of the real client. `JARVIS_WEB_DIST_DIR` must be an
absolute path — `pnpm --filter @moss/api start` runs with its cwd inside `apps/api`, so the
default (`process.cwd()/apps/web/dist`) resolves to the wrong directory.

**`JARVIS_TRUST_PROXY=1` trusts `X-Forwarded-*` from any peer that can reach the port** — it does
not verify the peer is actually `tailscale serve`. Always pair it with `HOST=127.0.0.1`; never
combine it with `HOST=0.0.0.0`, or any LAN/tailnet peer that can reach the port directly can spoof
its rate-limit identity and route around the HTTPS-only origin.

`tailscale serve` only publishes within the tailnet (never the public internet), but the
certificate it issues is logged to public Certificate Transparency logs by the CA — this is
inherent to how Tailscale's LAN-only HTTPS is issued, not new exposure introduced here, and every
device that should reach the instance needs its own tailnet sign-in.

````

- Test: `pnpm --filter @jarv1s/... ` — N/A, this task is a doc edit; its verification is a manual
  read-through against Task 4/5's actual executed commands (values must match exactly what was run
  and verified, not aspirational).

### Task 7 — File the `trustProxy` coercion follow-up as a GitHub issue (required before merge)

**Fable security review (required change 2):** this runbook is the first doc in the repo
instructing anyone to turn `JARVIS_TRUST_PROXY` on. `server.ts:221`'s
`trustProxy: !!resolveMossEnv(...)` coerces to a bare boolean, which Fastify treats as "trust XFF
from any peer," not "verify the peer is the legitimate reverse proxy" — a risk paragraph living
only in this plan doc doesn't survive the plan. File a GitHub issue (no code change in this lane)
proposing a narrower `trustProxy` value once prod's proxy topology is known precisely enough to
name it (prod's proxy reaches the container over the docker bridge, not loopback, so
`trustProxy: 'loopback'` is not a drop-in fix — confirmed by Fable's review as a reason to defer,
not skip). Link it from the new runbook subsection (Task 6) and from this plan's Open risks
section with the issue number once filed.
- Verification: `gh issue view <N> --json number,title` exits 0 and title matches; runbook
  subsection and this plan's Open risks section both reference `<N>`.

## Kill gate (owner: this lane's build agent, escalate to coordinator if triggered)

If Task 4 or Task 5 shows the single-process topology **cannot** satisfy sign-in or service-worker
registration even with `JARVIS_TRUST_PROXY` + trusted-origins correctly set (e.g., Better Auth
still rejects the origin, or the SW fails to register against a same-origin prod build for a
reason not yet identified) — stop, do not fall back to building the dead nginx/docker path
silently, and escalate to the coordinator with the specific failure. That would mean the seams
check above missed something and needs a fresh round before any further build.

## Open risks / follow-ups (named, not built this lane)

- **`server.ts:221`'s `trustProxy: !!resolveMossEnv(...)` coerces to a bare boolean `true`**, which
  Fastify treats as "trust XFF from any peer," not "verify the peer is the legitimate reverse
  proxy" — despite a nearby comment implying verification. Pre-existing, not introduced here.
  **Fable's security-tier review (this plan) required two mitigations, both applied above:**
  binding the API to `HOST=127.0.0.1` (Task 4/6) so only `tailscale serve` and same-host processes
  can reach the port at all, closing the immediate exposure without a code change; and filing a
  GitHub issue ([#1486](https://github.com/motioneso/moss/issues/1486), Task 7) for the narrower
  code-level fix, since prod's proxy reaches the container over the docker bridge (not loopback),
  so `trustProxy: 'loopback'` is not a drop-in replacement and needs its own design pass.
- **Kill-gate finding, resolved in-lane per coordinator ruling**: `static-web.ts`'s SPA fallback
  404s any request for `/` without an `Accept: text/html` header, which broke PWA service-worker
  installation (`cache.addAll`'s implicit fetch for `/` sends no `Accept` header, so the batch
  rejected and the SW registration was discarded). Fixed narrowly in
  `apps/web/public/service-worker.js` (fetch `/` explicitly with the header, `cache.put` it, keep
  `addAll` for the other shell URLs) — verified `installing` → `activated` via Playwright. The
  broader `static-web.ts` brittleness (any non-browser-Accept same-origin fetcher hits the same
  404) was left unchanged, out of this lane's scope, and filed as
  [#1487](https://github.com/motioneso/moss/issues/1487).
- **Deviation from spec's stated owned surface**: this plan touches no files under `infra/` or any
  compose file, contrary to the spec's Lane A "owned surface" listing `infra/, compose`. That
  listing was written assuming the nginx/containerized topology; the single-process topology needs
  none of it. Flagging for Fable/coordinator to confirm this is fine (it only *narrows* the touched
  surface, doesn't cross into another lane's).
- Lane C stage 2 (geolocation upgrade) is blocked on this lane per spec's merge order — flag to
  coordinator the moment this PR lands.

## Verification commands (unpiped, expected exit codes)

```bash
JARVIS_PGDATABASE=jarv1s_w6a pnpm db:migrate > /tmp/w6a-migrate.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm build:web > /tmp/w6a-build.log 2>&1; echo "EXIT=$?"                                   # expect 0
pnpm format:check > /tmp/w6a-format.log 2>&1; echo "EXIT=$?"                               # expect 0
pnpm lint > /tmp/w6a-lint.log 2>&1; echo "EXIT=$?"                                         # expect 0
pnpm typecheck > /tmp/w6a-typecheck.log 2>&1; echo "EXIT=$?"                               # expect 0
````

No `verify:foundation` run planned for this lane specifically beyond the standard wrap-up gate —
per `coordinated-wrap-up`, using its own isolated gate DB recipe (not `jarv1s_w6a`, which is this
lane's manual-verification DB, kept separate from the gate's fresh-DB-per-run requirement).

## Ledger — corrections to relay #2's grounding (`2026-08-09-w6a-secure-context-relay.md`)

| Item | Relay #2 claimed                                                                                                                   | Re-verified this session                                                                                                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #13  | "containerized/nginx topology" (`apps/web/Dockerfile` + `infra/nginx/jarv1s-web.conf`) is a live, buildable prod-equivalent option | Stale artifact — not referenced by either compose file; explicitly slated for removal in `2026-06-25-two-container-deploy.md`. Do not build against it.                                                                                                                                                        |
| #14  | Topology fork is between bare-process (a) and containerized/nginx (b); "(b) is more coherent" but undecided                        | Neither is correct. Actual prod topology is a **third, simpler** option: single process (API) serving the built SPA via `apps/api/src/static-web.ts`'s unconditional `registerStaticWeb` — confirmed live in `infra/docker-compose.prod.yml`'s `jarv1s` service and root `Dockerfile`. This plan targets that. |
| #15  | `vite preview` proxy behavior unresolved, next session should test it                                                              | Moot — this topology uses neither `vite dev` nor `vite preview`.                                                                                                                                                                                                                                               |
| #16  | Named open risk re: `trustProxy` boolean coercion                                                                                  | Confirmed by Fable's security-tier review (this plan) as a real, actionable risk given the single-process topology's `0.0.0.0` bind — mitigated in-plan via `HOST=127.0.0.1` (Task 4/6) plus a required follow-up GitHub issue (Task 7) for the code-level fix.                                                |

All of items 1-9 above (trusted-origins is config-only, `JARVIS_TRUST_PROXY` behavior, health
exemption, doc target, tailscale state, `gh` workaround, exit criteria, shared-host isolation,
bans) were re-verified this session and are unchanged from relay #2's grounding.
