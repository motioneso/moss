# Build plan — #1504 [TLS 1/4] Add the opt-in Caddy profile to production Compose

- **Issue:** #1504 (`task`), Part of #901. Risk tier: **security**.
- **Spec:** `docs/superpowers/specs/2026-08-10-self-hosted-tls.md` — sections "1. Bundled
  configuration, opt-in activation" (86-119), "2. Certificate model" (121-147), "3. Port and URL
  model" (149-161), "Security and failure behavior" (220-240), "Child 1 — Compose proxy" (281-313).
- **Dependencies:** #1403 and #1486, both closed. Not re-litigated here.
- **Branch / worktree:** `1504-tls-compose-proxy`.
- **Plan author:** Opus planning agent, run `run-1511-2026-08-29`. Requires Fable reviewer approval
  before any code is written.

## File ownership

This lane may write exactly three paths:

| Path | State |
| --- | --- |
| `infra/docker-compose.prod.yml` | exists, 319 lines |
| `infra/caddy/Caddyfile` | new (`infra/caddy/` does not exist) |
| `tests/unit/prod-deploy-config.test.ts` | exists, 92 lines — add Caddy assertions only |

Anything else is out of scope. Two adjacent things are deliberately **not** in this build:

- `infra/env.production.example` — documenting the two TLS variables for operators belongs to
  Child 2/3. Safe here because both variables get empty-safe defaults, so nothing becomes newly
  required (see "Prod safety" below).
- `scripts/setup-prod.ts` — Child 2 reads the forwarded values. Child 1 only makes them arrive.

If the build agent finds it must edit a fourth file to make a check pass, stop and report to the
coordinator rather than widening the diff.

## One-session sizing

This fits one session. The diff is one new 8-line config file, roughly 60 added lines of Compose
across two services plus two volumes, and one new test block. Every empirically hard question
(capabilities, volume ownership, issuer syntax, what Caddy's own validator does and does not catch)
was answered during the seams check below and is written down as a decision, so the builder is not
discovering runtime behaviour. No split proposed.

## Seams check — verified on this branch

Everything below was checked against the working tree or a real container run today. No claim here
is from memory.

### Repository facts

| Fact | Evidence |
| --- | --- |
| The app service is named `jarv1s` and listens on container port 3000 | `infra/docker-compose.prod.yml:144`, `:153` |
| It has a health check the proxy can wait on | `infra/docker-compose.prod.yml:187-198` |
| The direct host mapping is `${JARVIS_WEB_PORT:-1533}:3000` | `infra/docker-compose.prod.yml:199-200` |
| The shared Compose network is `jarv1s` | `infra/docker-compose.prod.yml:315-319` |
| Compose interpolates `${...}` for **every** service before profile filtering, so a `:?` required var on a profiled service breaks a plain `up` | comment and workaround at `infra/docker-compose.prod.yml:121-127` |
| A root one-shot that fixes volume ownership, then a hardened service that depends on it, is existing house style | `sports-browser-socket-init` at `infra/docker-compose.prod.yml:221-233`; consumer `depends_on: service_completed_successfully` at `:250-252` |
| The hardening vocabulary already used here — `read_only`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, numeric `user:` | `infra/docker-compose.prod.yml:235-249` |
| The `setup` service exists, is profile-gated, and today has **no** `environment:` block | `infra/docker-compose.prod.yml:290-302` |
| Repo image policy pins by tag, not digest | `pgvector/pgvector:pg17` at `:28`; `ghcr.io/motioneso/moss:${JARVIS_IMAGE_TAG:?...}` at `:146` |
| Unit tests may shell out to a real `docker compose config` | `tests/unit/sports-renderer-compose.test.ts:33-57`; `tests/unit/prod-compose-cli-tools-prefix.test.ts:23-27` |
| Unit tests run in CI as `pnpm test:unit` | `.github/workflows/ci.yml:138`; script at `package.json:59` |
| `JARVIS_TLS_HOST` / `JARVIS_TLS_ISSUER` appear nowhere in code today — only in the two spec files | grep over the tree, excluding `node_modules` |
| Env names starting `JARVIS_` have a `MOSS_` alias resolver | `packages/db/src/env.ts:86-98` — informational; Child 2's choice, not ours |

**Baseline for acceptance check 1.** With no profile selected, the current file renders exactly
four services:

```
jarv1s
postgres
sports-browser-socket-init
sports-source-renderer
```

Captured with `docker compose -f docker-compose.prod.yml config --services` from `infra/`, exit 0.
This list must be byte-identical after the change.

### Runtime facts, proved by running the real image

Image probed: `caddy:2.10.0-alpine`, digest
`sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c`.

1. **The Caddy binary carries a file capability.** `getcap /usr/bin/caddy` reports
   `cap_net_bind_service=ep`. This is why binding 80 and 443 as a non-root user works at all.
2. **Dropping all capabilities makes the binary unrunnable.** With `--cap-drop ALL` and no
   `--cap-add`, exec fails with `exec /usr/bin/caddy: operation not permitted` — the effective file
   capability cannot be honoured when it is outside the bounding set. So `NET_BIND_SERVICE` is not
   an optimisation here; without it the container will not start at all. This is the "demonstrated
   exception" the spec's deliverable list asks for.
3. **The image's `/data` and `/config` are root-owned, mode 755.** A fresh named volume inherits
   that ownership, so a non-root Caddy cannot write. Proved by running without a fix: exit 1,
   `provisioning CA 'local': generating root: saving root certificate: mkdir /data/caddy/pki:
   permission denied`.
4. **With ownership handed to 1000:1000 first, the hardened configuration works end to end.**
   Non-root, `--read-only`, `--cap-drop ALL --cap-add NET_BIND_SERVICE`, both named volumes
   mounted, Caddyfile mounted read-only: the container reaches `serving initial configuration`,
   binds `:80` and `:443`, and issues an internal-CA certificate
   (`certificate obtained successfully ... "issuer":"local"`), writing
   `/data/caddy/certificates/local/<host>/` and `/data/caddy/pki`.
5. **No tmpfs is required.** In that same run `touch /tmp/x` returns "Read-only file system" and
   Caddy is unaffected. The only writable paths are the two named volumes. We therefore ship **no**
   tmpfs, which is the strongest reading of the spec's "and any documented bounded tmpfs".
6. **The image sets `XDG_CONFIG_HOME=/config` and `XDG_DATA_HOME=/data`, but `HOME=/root`.**
   `/root` is unwritable under a read-only root filesystem. Caddy started anyway in the probe, but
   we set `HOME=/config` explicitly rather than rely on nothing ever consulting `HOME`.
7. **Issuer selection has a clean, validating seam.** `tls { issuer {$JARVIS_TLS_ISSUER:internal} }`
   accepts exactly the two supported values and rejects anything else at config-adapt time:

   | host | issuer | `caddy validate` exit | message |
   | --- | --- | --- | --- |
   | `moss.lan` | `internal` | 0 | Valid configuration |
   | `moss.lan` | `acme` | 0 | Valid configuration |
   | `192.168.50.36` | `internal` | 0 | Valid configuration |
   | `moss.lan` | `bogus` | 1 | `getting module named 'tls.issuance.bogus': module not registered` |

8. **Caddy's own validator does not police the hostname — this is the one real surprise.** All of
   these adapt cleanly at exit 0: an empty host (renders `https://` — a catch-all site matching
   every name), `http://moss.lan/path`, `moss.lan:8443`, `*.moss.lan`, and
   `moss.lan evil.com` (Caddy tokenises on whitespace, so an operator value containing a space
   silently adds a **second** site address). A plan that leaned on `caddy validate` alone for
   acceptance check 5 would be wrong, and would ship a fail-open catch-all when the variable is
   unset. See the decision on the preflight below.
9. **A global `email {$VAR:}` line fails to adapt when the variable is empty** (`wrong argument
   count ... after 'email'`). We ship no ACME email global; the spec's contract is two variables
   only. Do not add one.
10. **A recursive ownership fix breaks every restart after the first one.** Caddy's first
    successful run creates `/data/caddy/certificates`, `/data/caddy/pki`, and `/data/caddy/locks`
    as owner-only (mode 700, uid 1000). `caddy-init` runs as root but with only the file-ownership
    capability (`CAP_CHOWN`) — it does not have the capability that lets root read or search a
    folder it does not own. So on the *next* start, a recursive chown cannot descend into those
    now-owner-only folders and exits 1 with "Permission denied." Because `caddy` waits for
    `caddy-init` to finish successfully, this means HTTPS never comes back after a restart.
    Finding 4's probe only exercised a fresh volume, which is why the first version of this plan
    missed it; this was caught by a Fable reviewer running the real container through a second
    start. Fix: make the ownership step non-recursive and idempotent — only touch the two volume
    roots and `/data/caddy` itself (never their contents), and skip a path entirely once it is
    already owned by the target uid. See D1 and Task 2.

### Open questions

None. Every capability this plan assumes was executed, or, for finding 10, verified against the
real container by a Fable reviewer.

## Design decisions

### D1 — Two new services, both in the `tls` profile

`caddy-init` (root, one-shot) and `caddy` (non-root, long-running). The init exists for two
reasons that both have to happen before the proxy runs: it validates the operator's host and
issuer strings, and it hands `/data` and `/config` to the runtime user. Merging them into one
service is not possible — the chown needs root, and the proxy must not be root.

The handoff must be idempotent, not just correct on a fresh volume (finding 10): it only chowns
the two volume roots and `/data/caddy` themselves, never recurses into their contents, and skips
any of those paths that is already owned by the target uid. That is what lets `caddy-init` succeed
on every restart, not just the first one, once Caddy has created its own owner-only certificate
folders underneath `/data/caddy`.

**Steelman of the rejected option** (single service, no init): run Caddy as root and skip the
ownership problem entirely. That is what most Caddy Compose examples do, and it is simpler. It is
rejected because the spec makes a non-zero UID a deliverable and an acceptance check, and because
a root proxy holding the internal CA private key is exactly the surface #901 is security-tiered
for. A second alternative — bake the ownership fix into the image with a custom Dockerfile — was
rejected as it converts a pinned upstream image into a build we own and maintain, for one `chown`.

### D2 — The host and issuer guard lives in `caddy-init`, not in `caddy validate`

Finding 8 shows Caddy accepts hostnames it should not. The guard is a short shell check in the
init service that exits non-zero with an actionable message; `caddy` declares
`depends_on: caddy-init: condition: service_completed_successfully`, so a bad value means the proxy
is never started. That is literally the spec's "rejects invalid host/issuer values without
activating the service".

The rule, in plain terms: the host must be non-empty and contain only letters, digits, dots and
hyphens. That single character-class test rejects an empty value, any scheme, any port, any path,
a wildcard, a comma-separated list, a Caddyfile placeholder, and both bracketed and bare IPv6 —
matching the spec's v1 rejections. Separately, a host made only of digits and dots is treated as an
IPv4 literal and is rejected when the issuer is `acme`, because public ACME cannot validate a
reserved LAN address. The issuer must be exactly `internal` or `acme`.

This is **not** a duplicate of Child 2. Child 2 validates at install time and produces the trusted
origins; this is the runtime preflight the spec's failure-behaviour section names alongside it
("fails during new-install setup **or** the required Caddy validation preflight").

### D3 — Tag pin, no digest

`image: caddy:2.10.0-alpine`. The spec says "and digest if the repo's image policy supports it";
the repo pins by tag everywhere (`pgvector/pgvector:pg17`, the moss tag variable), so it does not.
The digest above is recorded in a comment in the Compose file for auditability. The acceptance
check is that the rendered config contains no `latest`, which a tag pin satisfies.

**Steelman of the rejected option:** `image: caddy:2.10.0-alpine@sha256:...` is strictly stronger
for a security tier and pins through a tag re-push. Rejected for consistency with the rest of the
file and because a digest that nobody re-verifies on upgrade decays into noise; revisit repo-wide
in its own issue rather than introducing a one-off policy here.

### D4 — Caddy listens on 80 and 443 inside the container

Not high ports remapped by Compose. Caddy derives its HTTP-to-HTTPS redirect targets from its
listening ports; moving them to 8080/8443 makes it emit redirects to `https://host:8443`, which is
wrong for the spec's "no explicit port" URL model. Finding 1 and 4 show the standard ports work
non-root. Port 80 exists only for the HTTPS redirect and ACME validation, per spec section 3.

### D5 — No application environment reaches Caddy

The `caddy` service gets an explicit two-entry `environment:` block plus `HOME`. It must **not**
use the `*app-env-file` anchor (`infra/docker-compose.prod.yml:21-24`). A test asserts the absence,
not just the presence.

### D6 — Setup forwarding uses empty-safe defaults

`JARVIS_TLS_HOST: ${JARVIS_TLS_HOST:-}` and `JARVIS_TLS_ISSUER: ${JARVIS_TLS_ISSUER:-internal}` on
the `setup` service. Never `:?`. Per the comment already at `infra/docker-compose.prod.yml:121-127`,
Compose interpolates every service before it filters profiles, so a required variable anywhere in
this file would break a plain `docker compose up`. This is the mechanism by which acceptance check 1
holds.

### Determinism boundary

Not applicable in the usual sense — this task ships no user-facing surface and no model is
involved. The equivalent statement for this build: nothing in the rendered configuration is derived
at runtime from anything but the two declared variables, and both are non-secret. No AI prompt, no
chat surface, no UI copy is touched.

## Tasks

Numbered, in order. Each is small; the whole set is one session.

### Task 1 — `infra/caddy/Caddyfile`

New file, mounted read-only. Contents are a contract, so they are stated exactly:

```caddyfile
https://{$JARVIS_TLS_HOST} {
	tls {
		issuer {$JARVIS_TLS_ISSUER:internal}
	}
	reverse_proxy jarv1s:3000
}
```

Plus a leading comment block naming: the two variables and their contract, that the init service
guards them, that this file is mounted read-only, and that certificate material lives only in the
`caddy-data` volume and must never be copied into the repo, an env file, a log, or a PR comment.
Tabs, matching Caddy's own formatting. No `email` global (finding 9). No admin endpoint directive —
the default admin API binds to container-local `:2019` and is never published.

### Task 2 — `caddy-init` service in `infra/docker-compose.prod.yml`

Placed immediately before the new `caddy` service. Contract:

- `image: caddy:2.10.0-alpine` (same pin as Task 3, digest in comment)
- `profiles: ["tls"]`
- `user: "0:0"`, `read_only: true`, `cap_drop: [ALL]`, `cap_add: [CHOWN]`,
  `security_opt: [no-new-privileges:true]`, `network_mode: none`, `restart: "no"`
- `environment:` exactly `JARVIS_TLS_HOST: ${JARVIS_TLS_HOST:-}` and
  `JARVIS_TLS_ISSUER: ${JARVIS_TLS_ISSUER:-internal}`
- `volumes:` `caddy-data:/data` and `caddy-config:/config`
- `command: ["sh", "-c", "<guard then chown>"]`

The guard, in order: reject an empty or non-`[A-Za-z0-9.-]` host with a message naming
`JARVIS_TLS_HOST`; reject an issuer that is not exactly `internal` or `acme` naming
`JARVIS_TLS_ISSUER`; reject an all-digits-and-dots host combined with `acme`, saying public ACME
cannot validate a LAN address; then the ownership fix. Exit 0 only if all four steps pass.
Messages go to stderr and name the variable and the offending rule, never the value's neighbours —
a hostname is fine to echo, per the spec's logging rule.

The ownership fix must be non-recursive and idempotent (finding 10), not a single
`chown -R ... /data /config`: that form works on a fresh volume but fails on every restart after
Caddy's first run, because Caddy leaves `/data/caddy/certificates`, `/data/caddy/pki`, and
`/data/caddy/locks` owner-only and this container's root cannot descend into folders it does not
own. Instead, for each of `/data`, `/config`, and `/data/caddy` in turn: read the path's current
owning uid with `stat -c %u`, and chown *that path only* (never `-R`) to
`${JARVIS_HOST_UID:-1000}:${JARVIS_HOST_GID:-1000}` unless it already reports that uid. This never
needs to look inside `/data/caddy`'s subfolders, so it is unaffected by whatever permissions Caddy
has already put on them.

Use busybox `case` patterns, not `grep -E`; keep it under ~20 lines. `network_mode: none` because
the init needs no network and must not be able to reach the app network.

### Task 3 — `caddy` service in `infra/docker-compose.prod.yml`

Contract:

- `image: caddy:2.10.0-alpine`
- `profiles: ["tls"]`
- `ports: ["80:80", "443:443"]` — fixed, not variable; spec section 3 rejects a configurable port
- `command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]`
- `user: "${JARVIS_HOST_UID:-1000}:${JARVIS_HOST_GID:-1000}"` — same defaults already used at
  `infra/docker-compose.prod.yml:116`, and the same values the init chowns to
- `read_only: true`, `cap_drop: [ALL]`, `cap_add: [NET_BIND_SERVICE]`,
  `security_opt: [no-new-privileges:true]`
- `environment:` exactly three entries: `JARVIS_TLS_HOST: ${JARVIS_TLS_HOST:-}`,
  `JARVIS_TLS_ISSUER: ${JARVIS_TLS_ISSUER:-internal}`, `HOME: /config`
- **no** `env_file`, no `*app-env-file` anchor, no `secrets`
- `volumes:` `caddy-data:/data`, `caddy-config:/config`,
  `./caddy/Caddyfile:/etc/caddy/Caddyfile:ro`
- `depends_on:` `caddy-init: service_completed_successfully` and `jarv1s: service_healthy`
- `networks: [jarv1s]`, `restart: unless-stopped`
- no `privileged`, no `network_mode: host`, no Docker socket, no tmpfs, no published `2019`

Add `caddy-data:` and `caddy-config:` to the `volumes:` block at the end of the file. Add a line to
the header comment showing the enable command:
`docker compose ... --profile tls up -d`.

### Task 4 — Caddy assertions in `tests/unit/prod-deploy-config.test.ts`

Add one `describe` block. Existing blocks are untouched. The file currently reads raw text
(`tests/unit/prod-deploy-config.test.ts:10-15`); the new block additionally renders real Compose
JSON, following `tests/unit/sports-renderer-compose.test.ts:33-57` — the same `execFileSync`
shape, the same three required env values (`JARVIS_IMAGE_TAG`, `POSTGRES_PASSWORD`,
`JARVIS_CLI_RUNNER_RPC_SECRET`), `config --format json`.

Two render helpers: one with no profile, one with `--profile tls`. Both must pass an env object
that **deletes** `JARVIS_TLS_HOST` and `JARVIS_TLS_ISSUER` from the inherited environment, so a
developer who has them exported cannot turn a red test green.

Test cases, stated as behaviour and why each would catch a broken implementation:

1. **Profile-free service list is unchanged.** Asserts the rendered service names equal exactly
   `jarv1s`, `postgres`, `sports-browser-socket-init`, `sports-source-renderer`. Fails if a builder
   forgets `profiles: ["tls"]` on either new service — the exact way this change could break prod.
2. **Profile-free port and env requirements are unchanged.** The `jarv1s` service still publishes
   `1533 -> 3000`; no service publishes 80 or 443; rendering succeeds without either TLS variable
   set. Fails if anyone writes `${JARVIS_TLS_HOST:?...}` anywhere in the file.
3. **`--profile tls` renders both new services.** `caddy` and `caddy-init` present; the rendered
   image string contains no `latest`; no service sets `privileged`, `network_mode: host`, or mounts
   `/var/run/docker.sock`; no published port `2019`. Fails on the classic "just pin latest" and on
   an accidentally exposed admin API.
4. **Caddy's hardening is exactly as specified.** Non-zero `user`, `read_only: true`,
   `cap_drop: ["ALL"]`, `cap_add: ["NET_BIND_SERVICE"]`, `security_opt` includes
   `no-new-privileges:true`, `tmpfs` undefined, writable mounts are only the two named volumes with
   the Caddyfile mount marked read-only. Fails if hardening is dropped during a rebase.
5. **Caddy gets no application secrets.** `env_file` undefined, `secrets` undefined, and the
   environment keys are exactly the three declared. An allowlist assertion, not a denylist — a
   denylist would pass the day someone adds a fourth secret nobody thought to name.
6. **`caddy-init` runs before Caddy and is the ownership fix.** `caddy.depends_on` names
   `caddy-init` with `service_completed_successfully` and `jarv1s` with `service_healthy`; init is
   `user: "0:0"` with `cap_drop: ["ALL"]` and `cap_add: ["CHOWN"]`. Fails if the ordering is
   dropped, which would reproduce the exact permission-denied crash recorded in finding 3.
7. **The setup service receives the two TLS values and nothing else new.** Its rendered environment
   contains exactly `JARVIS_TLS_HOST` (empty) and `JARVIS_TLS_ISSUER` (`internal`). Proves the real
   Compose path reaches Child 2's script rather than relying on shell inheritance, which Compose
   does not do.
8. **Both issuer modes adapt and a bad issuer does not.** Runs `caddy validate` in the pinned image
   three times — `internal`, `acme`, and a junk value — asserting exit 0, 0, and non-zero. This is
   the check that would have caught the mistake finding 8 warns about.
9. **The host guard rejects what Caddy's validator does not.** Runs the init service's command
   against a table of values: `moss.lan`/`internal` and `10.0.0.5`/`internal` pass;
   empty, `moss.lan evil.com`, `http://moss.lan/path`, `moss.lan:8443`, `*.moss.lan`, `::1`,
   `[::1]` all fail; `10.0.0.5`/`acme` fails. Every one of the failing rows is a value that
   `caddy validate` accepts at exit 0 today, so this test is the entire difference between
   fail-closed and a silent catch-all site.
10. **The ownership fix still succeeds on a second start, after Caddy has already run once.**
    Against a fresh named volume: run the `caddy-init` command (exit 0), then run `caddy` itself
    just long enough for it to create `/data/caddy/certificates`, `/data/caddy/pki`, and
    `/data/caddy/locks`, stop it, then run the `caddy-init` command against that same volume a
    second time. Asserts the second run also exits 0. This is the case finding 10 describes and
    the current plan's test case 6 does not cover, because test case 6 only checks service
    ordering on a fresh volume, not what the ownership step does once Caddy has left owner-only
    folders behind. Clean up the temporary volume after the test.

Tests 8, 9, and 10 shell out to `docker run` with the pinned image. That is consistent with unit
tests here already invoking `docker` (`tests/unit/sports-renderer-compose.test.ts:34`), and CI runs
`pnpm test:unit` with Docker available (`.github/workflows/ci.yml:138`). Give them an explicit
per-test timeout; the image is small but the first pull is not instant.

## Prod safety

A pull request must never break prod. The mechanism here is that **both new services carry
`profiles: ["tls"]` and both new variables have empty-safe defaults**, so an existing operator who
pulls this change and runs their unchanged command gets an unchanged stack: same four services,
same `1533` mapping, same required variables, no new ports bound, no new volumes created.

That is not an assertion of intent; it is test case 1 plus test case 2, and it is the first of the
spec's six acceptance checks. Because nothing becomes newly required, no deployment config file
needs a matching edit in this PR — which is why `infra/env.production.example` staying untouched is
correct rather than an omission.

Release note section of the PR: **Category: N/A**. The profile is off by default and no user sees
anything change. The user-facing note belongs to the child that turns HTTPS on.

## How each of the spec's six acceptance checks is proven

Run from `infra/` unless stated. Every command is unpiped and prints its own exit code.

**Check 1 — no profile: same services, unchanged port 1533 and env requirements.**

```bash
cd infra
JARVIS_IMAGE_TAG=test POSTGRES_PASSWORD=test JARVIS_CLI_RUNNER_RPC_SECRET=test \
  docker compose -f docker-compose.prod.yml config --services > /tmp/1504-services.txt 2>&1
echo "EXIT=$?"
```

Expected exit 0. Then compare against the recorded baseline:

```bash
sort /tmp/1504-services.txt > /tmp/1504-services-sorted.txt
printf 'jarv1s\npostgres\nsports-browser-socket-init\nsports-source-renderer\n' > /tmp/1504-baseline.txt
diff /tmp/1504-baseline.txt /tmp/1504-services-sorted.txt
echo "EXIT=$?"
```

Expected exit 0, no output. Separately, the full render:

```bash
JARVIS_IMAGE_TAG=test POSTGRES_PASSWORD=test JARVIS_CLI_RUNNER_RPC_SECRET=test \
  docker compose -f docker-compose.prod.yml config > /tmp/1504-config.txt 2>&1
echo "EXIT=$?"
grep -n '1533' /tmp/1504-config.txt
echo "GREP_EXIT=$?"
```

Expected exit 0 and the `1533:3000` mapping present. Automated as test cases 1 and 2.

**Check 2 — `--profile tls` renders Caddy with none of the forbidden settings.**

```bash
JARVIS_IMAGE_TAG=test POSTGRES_PASSWORD=test JARVIS_CLI_RUNNER_RPC_SECRET=test \
  docker compose -f docker-compose.prod.yml --profile tls config > /tmp/1504-tls.txt 2>&1
echo "EXIT=$?"
grep -nE 'latest|privileged|network_mode: host|docker\.sock|2019' /tmp/1504-tls.txt
echo "GREP_EXIT=$?"
```

Expected: render exit 0; the grep exits 1 with no output (nothing forbidden found). Automated as
test case 3.

**Check 3 — rendered Caddy is non-root, read-only, correctly capped, no app env.** Automated as
test cases 4 and 5, which read the JSON render rather than grepping text so a nested key cannot be
missed.

**Check 4 — rendered setup config receives exactly the two TLS values.** Automated as test case 7.
Manual confirmation:

```bash
JARVIS_IMAGE_TAG=test POSTGRES_PASSWORD=test JARVIS_CLI_RUNNER_RPC_SECRET=test \
  docker compose -f docker-compose.prod.yml --profile setup config > /tmp/1504-setup.txt 2>&1
echo "EXIT=$?"
grep -n 'JARVIS_TLS' /tmp/1504-setup.txt
echo "GREP_EXIT=$?"
```

Expected exit 0 and both variables listed under `setup`.

**Check 5 — both issuer modes parse; invalid host and issuer are rejected without activating the
service.** Automated as test cases 8 and 9. Manual spot check of the issuer half:

```bash
docker run --rm --user 1000:1000 --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -e HOME=/config -e JARVIS_TLS_HOST=moss.lan -e JARVIS_TLS_ISSUER=acme \
  -v "$PWD/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10.0-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo "EXIT=$?"
```

Expected exit 0 and "Valid configuration"; the same command with `JARVIS_TLS_ISSUER=bogus` must
exit non-zero. The host half is the init guard, not this command — see D2.

**Restart check, added after finding 10 — HTTPS still comes up on a second start, not just the
first.** Not one of the spec's original six checks, but required by this revision. Automated as
test case 10; manual version:

```bash
docker compose --profile tls -f infra/docker-compose.prod.yml up -d
# wait for caddy to report healthy, then:
docker compose --profile tls -f infra/docker-compose.prod.yml down
docker compose --profile tls -f infra/docker-compose.prod.yml up -d
docker compose --profile tls -f infra/docker-compose.prod.yml ps caddy-init caddy
```

Expected: `caddy-init` exits 0 both times, and `caddy` reports healthy after the second `up` too.
Before this revision, the second `caddy-init` run fails with "Permission denied" and `caddy` never
starts.

**Check 6 — the unit test file passes.**

```bash
pnpm exec vitest run tests/unit/prod-deploy-config.test.ts > /tmp/1504-vitest.log 2>&1
echo "EXIT=$?"
```

Expected exit 0. Read the log with `tail` afterwards; never pipe the command itself.

**Whole-gate run before handing the PR over.** Use the `verify-gate` skill — do not run
`pnpm verify:foundation` bare, and never pipe it. The skill exists because an unscoped run reaches
the live dev database.

## Kill gate

Evaluated after Task 3 renders and before Task 4's tests are finalised. Any one of these ends the
line and goes back to the coordinator rather than being improvised around:

1. The profile-free service list or the `1533` mapping changes for any reason. That is prod
   breakage; there is no acceptable workaround inside this lane.
2. Caddy cannot be made to run non-root with a read-only root filesystem and only
   `NET_BIND_SERVICE` — for instance a future image drops the binary's file capability. Do **not**
   fall back to running as root or adding capabilities beyond the one the spec permits.
3. Making an acceptance check pass would require editing a file outside the three owned paths.
4. The host guard cannot reject the values in test case 9 without a shell construct too intricate
   to review — at that point host validation should move wholly to Child 2 and this lane's check 5
   should be renegotiated in the spec, not fudged.

**Owner of the call:** the coordinator (`coordinator`, pane label `Coordinator`, workspace w1).
The build agent reports the observation and stops; it does not decide.

## Interface notes for later children

Not deliverables here, recorded so nobody re-derives them:

- Child 2 reads `JARVIS_TLS_HOST` / `JARVIS_TLS_ISSUER` from `process.env` in
  `scripts/setup-prod.ts`; that file already reads env directly (`scripts/setup-prod.ts:57-80`) and
  has a `MOSS_`-alias helper available at `packages/db/src/env.ts:86`.
- Child 3's runbook needs the internal-CA export path proved in finding 4:
  `/data/caddy/pki` inside the `caddy-data` volume holds the root, and only the public root
  certificate ever leaves it.
- The `caddy-data` volume is the single point of loss for the local CA. Losing it rotates the CA
  and every client must trust the replacement — backup guidance is Child 3's.

## Review checklist

- [x] Spec approved; task issue #1504 open
- [x] Every assumed capability cited to a file and line, or proved by a recorded container run
- [x] No function bodies — file paths, service contracts, exact Caddyfile, and test cases only
- [x] Determinism boundary addressed (not applicable, and why)
- [x] Every verification command unpiped with an expected exit code
- [x] Kill gate named with an owner
- [x] Rejected options steelmanned (D1, D3)
- [x] Sized for one session, with the reasoning shown
