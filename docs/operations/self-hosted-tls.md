# Self-Hosted TLS

Opt-in HTTPS for a self-hosted Moss instance, via a bundled Caddy reverse proxy (part of #901).
Off by default: an unmodified deploy is unaffected. This is an additive path — the existing
`http://<host>:1533` URL keeps working side by side with HTTPS, and is the rollback target if
anything goes wrong.

Read this whole page before enabling TLS on a real deployment. All examples use placeholder
hostnames (`moss.lan`, `moss.example.com`) and placeholder IPs — never paste a real hostname,
certificate, or secret into a support request, a log, or a pull request comment.

Every `docker compose` command below uses `-p jarv1s-prod --env-file env.production.local -f
infra/docker-compose.prod.yml`, matching [deploy.md's checkout-based
flow](./deploy.md#repository-compose). If your deployment uses the downloaded-Compose-file flow
instead, drop `-p jarv1s-prod` and adjust the `-f` path — just keep using the exact same
project name and Compose file flags you used for your original `up -d`, every time, or Compose
will not find your running containers or volumes.

## What this adds

A `caddy` reverse proxy, enabled with the Compose `tls` profile, terminating HTTPS on host ports
80 and 443 and forwarding to the existing Moss container. Two operator-supplied values control
it:

- `JARVIS_TLS_HOST` — the DNS hostname or LAN IPv4 address browsers will use. No scheme, port,
  path, or wildcard — a bare hostname or IP only.
- `JARVIS_TLS_ISSUER` — `internal` (default: a private, self-signed certificate authority) or
  `acme` (a publicly trusted certificate; the host must be a real DNS name reachable from the
  internet on ports 80/443).

The `internal` issuer is the one covered in full below: it works on a closed LAN, requires no
public DNS or port forwarding, and is the recommended default. `acme` is for a deployment that is
genuinely reachable from the public internet under its own domain name.

## Enable TLS (existing install)

This is additive: it never removes or rewrites what is already in your env file, only appends to
it.

1. **Back up first.** Follow [deploy.md's Backups section](./deploy.md#backups) for the data
   volumes, and copy `env.production.local` itself somewhere safe — you will edit it in step 3.
2. **Choose a stable host.** Pick a DNS name your LAN or router resolves consistently (preferred),
   or a fixed LAN IPv4 address (only valid with the `internal` issuer — a public `acme`
   certificate cannot be issued for a private address). Whichever you pick, keep it stable:
   changing it later means re-trusting a new certificate on every client.
3. **Append these lines to `env.production.local`.** Do not delete or replace anything already in
   the file.

   ```sh
   # New — enables the tls Compose profile's proxy
   JARVIS_TLS_HOST=moss.lan
   JARVIS_TLS_ISSUER=internal

   # New — the exact static Caddy address on the jarv1s Compose network (never the bridge
   # CIDR or gateway address). This is the only value #1486's forwarded-header trust accepts
   # beyond the "loopback" keyword — see "Diagnose a scoped proxy-trust problem" below for
   # what happens if this is wrong.
   MOSS_TRUST_PROXY=10.251.0.254
   ```

   `JARVIS_TLS_HOST` / `JARVIS_TLS_ISSUER` are Compose-level values (always the `JARVIS_` name).
   `MOSS_TRUST_PROXY` is an application setting already present in a generated env file under its
   `MOSS_` name — add it if it is not already there.

4. **Add the HTTPS origin to the existing trusted-origins line.** Find the line starting
   `MOSS_AUTH_TRUSTED_ORIGINS=` (or `JARVIS_AUTH_TRUSTED_ORIGINS=` on an older file) and append
   the exact `https://<JARVIS_TLS_HOST>` origin — do not replace the line, only add to the
   comma-separated list:

   ```
   MOSS_AUTH_TRUSTED_ORIGINS=http://localhost:1533,https://moss.lan
   ```

   Run the explicit check below before continuing — Caddy's own config validation in step 5
   cannot see this application setting, so a missed origin here will not be caught there:

   ```sh
   grep MOSS_AUTH_TRUSTED_ORIGINS env.production.local | grep -q "https://moss.lan" \
     && echo "origin present" || echo "MISSING — add it before continuing"
   ```

   Replace `https://moss.lan` with your own `https://<JARVIS_TLS_HOST>`. If this prints
   `MISSING`, sign-in from the HTTPS origin will fail with a trusted-origin 403 the moment you
   activate the proxy — see "Diagnose a trusted-origin 403" below.

5. **Validate before activating — the required Caddy preflight.** This renders and checks the
   configuration without starting the proxy or binding any port:

   ```sh
   docker compose -p jarv1s-prod --env-file env.production.local \
     -f infra/docker-compose.prod.yml --profile tls config
   ```

   Read the rendered `caddy` and `caddy-init` service blocks and confirm your host and issuer
   appear as expected. This step only proves the Compose file and Caddyfile parse — it does not
   start Caddy, so it never activates or exposes anything.

6. **Start the stack with the profile enabled:**

   ```sh
   docker compose -p jarv1s-prod --env-file env.production.local \
     -f infra/docker-compose.prod.yml --profile tls up -d
   ```

7. **Trust the certificate on your client** (see "Trust the internal certificate" below), then
   open `https://<JARVIS_TLS_HOST>` and confirm you can sign in with no browser warning and no 403. Keep `http://<host>:1533` bookmarked as the rollback path until you've confirmed HTTPS
   works end to end.

## Enable TLS (new install)

Set the same two Compose-level variables before running `setup`, and the generated
`env.production.local` will already contain the correct `MOSS_TRUST_PROXY` and
`MOSS_AUTH_TRUSTED_ORIGINS` entries — nothing further to add by hand:

```sh
JARVIS_IMAGE_TAG=stable JARVIS_TLS_HOST=moss.lan JARVIS_TLS_ISSUER=internal \
  docker compose -f docker-compose.prod.yml --profile setup run --rm setup
```

If `JARVIS_TLS_HOST` is malformed, the issuer is neither `internal` nor `acme`, an IPv4 host is
combined with `acme`, or an explicit `JARVIS_AUTH_TRUSTED_ORIGINS`/`MOSS_AUTH_TRUSTED_ORIGINS`
override is set but does not include the HTTPS origin, `setup` refuses to write the env file at
all and prints the specific problem — it never writes a file that would start and then reject
every sign-in. Fix the value named in the message and re-run `setup`.

Then start with the profile, same as above:

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml --profile tls up -d
```

## Trust the internal certificate

Only needed for `JARVIS_TLS_ISSUER=internal` — an `acme` certificate is already trusted by every
client automatically.

First, export the local certificate authority's public root certificate from the running proxy.
This copies out only the public root, never the private key:

```sh
docker compose -p jarv1s-prod exec caddy cat /data/caddy/pki/authorities/local/root.crt \
  > moss-root-ca.crt
```

### Verified pairing: Android + Firefox

This is the only client platform this runbook gives exact steps for — the pairing Ben recorded
for the second-device verification of this feature (2026-08-29). Every other platform is listed
further below as unverified.

1. Copy `moss-root-ca.crt` to the Android device (e.g. via a file-sharing app, USB, or a
   temporary private link — never email or a public upload).
2. In Firefox for Android: **Settings → About Firefox**, then open **Settings → Privacy &
   Security**, scroll to the certificate settings, and choose to install a certificate from
   local storage. Select `moss-root-ca.crt`. Firefox for Android uses its own trust store, not
   the Android system one, so this step is Firefox-specific.
3. Open `https://<JARVIS_TLS_HOST>` in Firefox and confirm the padlock shows a valid, trusted
   certificate with no warning interstitial.

**If Firefox hits a snag,** Chrome is the fallback for this pairing. Chrome on Android uses the
Android system trust store rather than its own, so the certificate installs through
**Android Settings → Security → Encryption & credentials → Install a certificate → CA
certificate**, selecting `moss-root-ca.crt`, then confirming `https://<JARVIS_TLS_HOST>` loads
without warning in Chrome.

### Other platforms — unverified

No other OS/browser combination has been verified against this feature. For any of them, follow:

- [Caddy's own public-root trust guidance](https://caddyserver.com/docs/automatic-https#local-https)
  for exporting and installing the internal root certificate, and
- the platform vendor's current certificate-trust documentation (search "install trusted root
  certificate" plus your OS or browser name, from the vendor's own site).

Do not extend this runbook with an OS/browser matrix beyond the pair above without a new
verification pass.

## ACME (publicly trusted certificates)

Use `JARVIS_TLS_ISSUER=acme` only when `JARVIS_TLS_HOST` is a real DNS name that already resolves
to this host's public IP, with ports 80 and 443 reachable from the internet (for HTTP-01
validation). An IPv4 literal is rejected outright with `acme` — public certificate authorities
cannot validate a private address.

The Caddy preflight in step 5 above (`--profile tls config`) only proves your Compose file and
Caddyfile _parse_ correctly for the `acme` issuer — it cannot check DNS propagation or that ports
80/443 are actually reachable from the public internet. Certificate issuance itself only happens
once the proxy starts. If HTTPS does not come up after `--profile tls up -d`:

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml logs caddy --tail 100
```

Look for an ACME/HTTP-01 challenge failure in the log — Caddy names the specific reason (DNS not
resolving to this host, port 80/443 unreachable, or rate-limited by the certificate authority).
Then confirm readiness directly once you believe the problem is fixed:

```sh
curl -fsS -I https://<JARVIS_TLS_HOST>/health
```

A `200` with no certificate warning means issuance succeeded. Never use `curl -k` to work around a
certificate error — that only hides the failure instead of fixing it, and it is not accepted as a
passing check.

## Back up and restore Caddy's certificate data

`caddy-data` holds the local certificate authority's private key and every issued certificate.
Losing this volume without a backup rotates the CA — every client that trusted the old root
certificate must re-trust the new one. Treat this volume with the same care as your database
backup.

Back it up the same way as the other named volumes in
[deploy.md's Backups section](./deploy.md#backups), stack stopped first:

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml down
docker run --rm -v jarv1s-prod_caddy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/caddy-data.tar.gz -C /data .
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml --profile tls up -d
```

Restore into a fresh, empty volume before starting the proxy:

```sh
docker volume create jarv1s-prod_caddy-data
docker run --rm -v jarv1s-prod_caddy-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/caddy-data.tar.gz -C /data
```

`caddy-config` (Caddy's autosaved running configuration) is reconstructed automatically from your
Caddyfile and environment on every start and does not need to be backed up.

## Diagnose a trusted-origin 403

**Symptom:** the proxy is up, the certificate is trusted, the page loads, but signing in over
`https://<JARVIS_TLS_HOST>` fails with a 403.

**Cause:** the exact HTTPS origin is missing from `MOSS_AUTH_TRUSTED_ORIGINS` (or the older
`JARVIS_AUTH_TRUSTED_ORIGINS` name). This is an application-level check that Caddy's own
validation cannot see — it only happens once a real sign-in request reaches Moss.

**Check:**

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml exec jarv1s printenv MOSS_AUTH_TRUSTED_ORIGINS
```

Confirm the exact string `https://<JARVIS_TLS_HOST>` appears in the comma-separated list, with no
trailing slash and no typo in the host. If it's missing, go back to "Enable TLS (existing
install)" step 4, add it, then recreate the container so it picks up the new env file:

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml up -d jarv1s
```

## Diagnose a scoped proxy-trust problem

Moss only trusts forwarded-header information (`X-Forwarded-For`, `X-Forwarded-Proto`) from a
request that actually arrived via the Caddy proxy's known address — `MOSS_TRUST_PROXY` must be
set to the exact static Caddy address on the Compose network (`10.251.0.254` by default), never a
broad value, never `true`. If it is unset, or wrong, or too broad:

- **Unset or wrong:** requests arriving through the proxy are treated as if they came from Caddy's
  container itself (not the real client), which breaks per-client rate limiting and stops Moss
  from issuing secure cookies correctly.
- **Too broad** (anything other than the exact Caddy address or the `loopback` keyword): a client
  could forge forwarded headers and impersonate another user's address.

**Check it's scoped correctly**, without touching any secret: hit the app port directly,
bypassing Caddy entirely, with a forged `X-Forwarded-For` header, and confirm the forged address
has no effect. Because `:1533` is not the trusted proxy address, Moss must ignore the header and
rate-limit on the real connecting address regardless of what the header claims:

```sh
# 12 requests: comfortably above the default sign-in rate limit of 10/minute, so a
# correctly-scoped trust boundary has room to show the 429.
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-Forwarded-For: 1.1.1.$i" \
    -X POST http://127.0.0.1:1533/api/auth/sign-in/email \
    -H "content-type: application/json" \
    -d '{"email":"nonexistent@example.test","password":"wrong"}'
done
```

If forwarded-header trust is correctly scoped to Caddy only, repeated requests direct to `:1533`
eventually return `429` (rate limited) even though every request claims a different forged
address — the real connecting address is what's being counted, not the spoofed header. If every
request instead returns the same non-429 status indefinitely, forwarded-header trust is too
broad and the header is being believed; re-check `MOSS_TRUST_PROXY` is set to the exact Caddy
address, not `true` or a wildcard.

This check never needs a real account or a secret — `nonexistent@example.test` with a wrong
password is rejected either way; only the status code and its consistency across requests are
being read.

## Rollback to port 1533

TLS is additive — the direct `http://<host>:1533` mapping is never removed by enabling it. To roll
back:

```sh
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml down
docker compose -p jarv1s-prod --env-file env.production.local \
  -f infra/docker-compose.prod.yml up -d
```

Omitting `--profile tls` on the second command stops the `caddy` and `caddy-init` services and
leaves everything else running exactly as before TLS was enabled. `env.production.local` does not
need to be edited to roll back — the TLS lines being present is harmless with the profile off.
Restore the backed-up `env.production.local` from before step 3 only if you need to fully undo the
`MOSS_TRUST_PROXY` / trusted-origins edits as well.
