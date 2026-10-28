# Remote access over Tailscale, with optional meetmoss.com names

**Date:** 2026-10-27

**Status:** Draft for Ben's review. Not approved. Two decisions are recorded (see Decided). No build issue exists yet; one `task` issue is
opened per slice after approval.

**Grounded on:** `origin/main` = `936eee87a`, `docs/operations/self-hosted-tls.md`,
`docs/operations/deploy.md`, the self-hosted TLS specs of 2026-08-10, the Wave 6 secure-context
spec of 2026-08-09, and the installer build spec of 2026-10-12 (its "Access after account
creation" section).

**Builds on:** self-hosted TLS (#901 family). This spec adds a reachability path. It does not
replace the bundled Caddy proxy or the internal-CA path.

## Decision summary

1. A self-hosted Moss gets remote access by putting the Moss machine, the phone and the laptop on
   the owner's own Tailscale network. Nothing is forwarded or relayed through the Moss project.
2. Plain Tailscale is the default. Moss guides the owner through installing it and reads the
   machine's Tailscale address.
3. An optional second step gives the install a short HTTPS name such as `ben.meetmoss.com`. A small
   registration service points that public name at the owner's private Tailscale address and helps
   the install prove ownership of the name to Let's Encrypt with a DNS record. The private key
   never leaves the owner's machine.
4. The registration service is a Cloudflare Worker on the account that owns meetmoss.com. It holds
   the only Cloudflare tokens, each limited to one zone and to DNS edits. Installs never see them.
5. `meetmoss.com` goes on the Public Suffix List before launch, so one owner's name cannot touch
   cookies on another owner's name or on the marketing site, and so Let's Encrypt counts each name
   separately.
6. Launch is an invite-limited beta under 50 new names a week, with plain Tailscale as the headline
   feature (Ben, 2026-10-27).
7. Sign-in to the registration service is GitHub or Google (Ben, 2026-10-27). This replaces the
   earlier email-link recommendation. Abuse limits still apply per account.
8. Ben handles the abuse address and takedowns under a short written policy, with an automatic
   first pass on reserved name patterns (Ben, 2026-10-27).
9. Name rules: one name per account, 3 to 30 characters, released after 90 days without an address
   refresh, held 30 days before reuse (Ben, 2026-10-27).

## Problem

Moss on a home machine is reachable only on the home network. Phones, the companion app and
browser features that need a secure context (service worker, microphone, push) need HTTPS, and the
owner wants that from anywhere. Today the options are a Caddy proxy with an internal certificate
authority (every device must trust a root certificate), or a public domain with ports 80 and 443
open to the internet. Both are too much work for the audience, and the second exposes the machine.

## Goals

- An owner reaches Moss over HTTPS from their own phone and laptop at home and away, with no port
  forwarding and no traffic through Moss project servers.
- Nobody outside the owner's Tailscale network can reach the instance.
- The default path needs no Moss-run service at all.
- The optional name path works even when Tailscale's own DNS feature (MagicDNS) is off.
- Moss tests for DNS rebinding protection during setup and says what to change.
- The registration service holds the smallest credentials that work, and no install can touch
  another install's name.
- Existing installs, the `:1533` HTTP address and the internal-CA path keep working untouched.

## Non-goals

- No relay, tunnel or proxy run by the Moss project. Traffic never passes through meetmoss.com.
- No access for people outside the owner's Tailscale network (no Tailscale Funnel, no public
  exposure). Sharing Moss with another person means sharing the Tailscale device, which is
  Tailscale's feature.
- No Tailscale account creation or tailnet administration by Moss. Moss never holds a Tailscale
  API key or auth key.
- No wildcard certificates, no custom domains on meetmoss.com, no email or other services on a
  meetmoss name.
- No automatic router or DNS-filter changes. Moss names the setting; the owner changes it.
- No second proxy implementation and no change to the internal-CA default for LAN-only owners.

## Anti-goals

- Do not make the meetmoss name required. A user who never signs up with the registration service
  loses nothing.
- Do not store a private key, certificate or Tailscale credential on the service.
- Do not let the service point a name at anything outside Tailscale's address ranges.
- Do not make Moss depend on the registration service staying alive. If the service disappears,
  installed names keep resolving and existing certificates keep working until they expire;
  only new names and renewals stop.
- Do not rely on any property of Tailscale's DNS feature for the name path.

## User flow

All of this lives in one guided panel, reached from the first-run Ready screen ("Use Moss from other
devices", already approved in the installer spec) and later from Settings. Each step shows a real
check result before it unlocks the next step.

### A. Reach Moss through Tailscale (default)

1. **Choose.** The owner picks "From anywhere" in the access panel.
2. **Install Tailscale on the Moss machine.** Moss shows the install link for the machine's
   system and waits. Moss detects the signed-in state and the machine's Tailscale address
   (the `100.x` number). If Tailscale is installed but signed out, Moss says so and shows the sign-in
   step.
3. **Install Tailscale on the phone and laptop.** Moss shows store links and a QR code for the
   phone. Moss cannot see the other devices, so it asks the owner to open a Moss test address from
   each device, and marks the step done when the test page is actually fetched from a second device
   (the installer spec's rule that a second device must reach and authenticate before the UI calls a
   route verified).
4. **Get HTTPS.** Two sub-cases.
   - Tailscale HTTPS is available on the tailnet. Moss enables the Tailscale-provided name
     (`machine.tailnet.ts.net`) through the host operation channel, adds the exact origin to the
     trusted origins, and checks the origin from the second device.
   - Tailscale HTTPS is not available (the tailnet has it off, or MagicDNS is off). Moss says why,
     offers plain `http://100.x:1533` for the moment (encrypted by Tailscale in transit, but not a
     secure context in the browser), and offers Step B.
5. **Done.** The access row on Ready and in Settings shows the verified address and the date it was
   last verified.

### B. Add a meetmoss.com name (optional)

1. **Sign in.** The owner signs in to the registration service (see Account and identity). Moss
   opens the service's sign-in page in the browser and polls for completion (device-code style).
2. **Pick a name.** One text box. Moss checks availability live, shows reasons for refusals
   (taken, reserved, too short, not allowed characters) and suggests alternatives.
3. **Register.** Moss sends the name and the Tailscale address. The service validates the address
   range and creates the public record.
4. **Test the network path.** Moss runs the rebinding checks (see Failure modes) from the Moss
   machine and asks each other device to open a check page. Failures show the specific setting to
   change for the router or DNS filter in use.
5. **Get the certificate.** Moss requests a Let's Encrypt certificate for the name. It proves
   ownership through the service (see Architecture). Progress and the exact failing step are shown.
6. **Switch on.** Moss adds the HTTPS origin to the trusted origins, starts serving the name, and
   verifies from a second device. The earlier address keeps working side by side.
7. **Confirm.** The panel shows the name, the certificate expiry and the next renewal date.

### C. Change or release a name

Settings offers rename (a new name, old one released after a hold), release, and "sign out of the
registration service". Releasing deletes the public records and the stored install token.

## Architecture

### What runs where

| Piece                | Runs on                     | Holds                                                                 |
| -------------------- | --------------------------- | --------------------------------------------------------------------- |
| Moss API and web     | Owner's machine             | Install token, ACME account key, certificate private key, certificate |
| Bundled Caddy (TLS)  | Owner's machine             | Serves the certificate files Moss writes                              |
| Tailscale            | Owner's machine and devices | Their own Tailscale credentials (never read by Moss)                  |
| Registration service | Cloudflare Worker           | Accounts, names, hashed install tokens, audit log, two zone tokens    |
| Cloudflare DNS       | Cloudflare                  | A/AAAA records for names, temporary TXT challenge records             |
| Let's Encrypt        | Let's Encrypt               | Issues certificates after reading the challenge TXT record            |

### Where the registration service runs

Ben chose the Worker on 2026-10-27. The comparison that led there.

| Option                                          | For                                                                                          | Against                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker on the existing Cloudflare account       | No box to keep alive; tokens held as Worker secrets; free plan allows 100,000 requests a day | 10 ms CPU limit per request on the free plan (waiting on outbound calls is expected not to count; not verified); storage product limits not checked |
| Process on Ben's box behind the existing tunnel | Plain Node/Fastify like the rest of the repo; easy to debug                                  | A home machine that also runs agents holds the DNS tokens; outage there stops registration and renewals                                             |

**Decided: Worker.** The service is small (a few endpoints, a small database), it needs high
availability for renewals, and a home box is a poor place to keep a token that can edit public DNS.
Slice 2 starts with a spike that confirms the free plan's CPU limit and storage fit; if the spike
fails, the paid Workers plan is the fallback before the home box is.

### Tokens and what each can do

- **Main-zone token.** Cloudflare API token limited to the one meetmoss.com zone, permission "Zone
  DNS Edit", and (optional field in the token form) limited to the service's source addresses and
  given a lifetime so it must be rotated. Used only to create, update and delete A/AAAA records for
  registered names.
- **Challenge-zone token.** A second token on a second zone (see Certificate challenge). Used only
  to write and delete TXT records.
- Cloudflare's DNS Edit permission is full create/read/update/delete on the zone's DNS, so zone
  scoping is the narrowest cut available. It cannot limit a token to one record type, which is why
  the two jobs get two zones.
- Tokens exist only as Worker secrets. No endpoint returns them and the Worker never logs a
  request that carries one. Installs hold only their own install token.

### Install authentication

Two ways an install could prove who it is to the service.

| Option                       | For                                                         | Against                                                              |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Moss-project account sign-in | Recovery, abuse handling, one place to ban, rename, release | The service stores an email address per owner                        |
| Signed install key only      | Nothing stored about the person                             | No recovery, no way to stop one person registering hundreds of names |

**Recommendation: an account, with a per-install token.** The owner signs in once with an emailed
sign-in link (no passwords stored) and Moss receives a long random install token through the
device-code flow. The service stores only a hash of the token. The token can act on that
install's one name and nothing else. Signing out or releasing the name revokes it. Which sign-in
methods to offer is an open question.

### Service endpoints (shape only)

All over HTTPS, JSON, with the install token as a bearer credential except sign-in.

- `GET /names/check?name=` availability and refusal reason. No sign-in required, rate limited.
- `POST /names` register a name and an address.
- `PUT /names/{name}/address` update the address (daily refresh and on change).
- `DELETE /names/{name}` release.
- `PUT /names/{name}/challenge` publish a certificate challenge value; `DELETE` removes it.
- Sign-in start/poll endpoints for the device-code flow.

### Certificate challenge

The install runs the ACME client itself, with its own account key and certificate key. For the
DNS-01 challenge Let's Encrypt looks for a TXT record at `_acme-challenge.<name>`. Let's Encrypt
follows a CNAME at that name to another zone (documented on its challenge-types page), which the
service uses like this.

1. At registration, the service creates `_acme-challenge.ben.meetmoss.com` as a CNAME to a
   per-name label in a separate challenge zone it controls.
2. At issuance the install asks the service to publish the challenge value. The service writes the TXT
   record in the challenge zone only, after checking the name belongs to the caller.
3. Let's Encrypt follows the CNAME, reads the TXT, issues the certificate.
4. The install asks the service to delete the TXT record.

What this buys. Installs never receive any Cloudflare credential in either design. Delegation lets
the two service tokens be separate: the main-zone token cannot write certificate proof into the
challenge zone, and the challenge-zone token cannot redirect a name. What it does not buy. A stolen
challenge-zone token still lets an attacker get certificates for any registered name (the CNAMEs
already point there), so that token gets the strongest protection and a short lifetime. Let's
Encrypt itself recommends narrowly scoped DNS credentials for DNS-01.

The challenge zone must be a separate zone. Whether Cloudflare allows delegating a subdomain of a
zone to another zone below the Enterprise plan was not verified, so the plan assumes a second
cheap domain. The second domain is not user-visible.

### Certificate issuance and renewal on the install

- Let's Encrypt certificates last 90 days. The install renews well before expiry (recommended: at
  30 days remaining) through a scheduled job. The job payload carries only the install and name IDs.
- The ACME client must work with the bundled Caddy. The current image (`caddy:2.10.0-alpine`) has no
  DNS provider plugin. Two ways: a Caddy build with a plugin, or Moss runs ACME and writes
  certificate files that Caddy loads and reloads. The second keeps the image unchanged and puts the
  logic in Moss where it can show progress in the panel. **Recommendation: Moss runs ACME.** The
  choice of client library is a slice 4 decision.
- Renewal failures raise a Moss notification well before expiry.
- An install that fails repeatedly must back off. Let's Encrypt allows only five certificates per
  week for the same exact name, and the limit cannot be overridden.

### DNS records the service writes

- One `A` record per name pointing at the owner's `100.64.0.0/10` address, and one `AAAA` record if
  an address in Tailscale's IPv6 range is supplied (range not yet confirmed against Tailscale's
  docs; confirm in slice 2).
- Short TTL (a few minutes) so address changes land quickly.
- Nothing else. No `MX`, no `TXT`, no `CNAME` that an install chooses. The only CNAME is the
  fixed challenge delegation the service writes itself.
- Only the exact Tailscale ranges are accepted. A request for a public, LAN, loopback or
  link-local address is refused.

### What the service stores

| Table        | Fields                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| accounts     | id, email, created at, status (active, suspended)                              |
| names        | name, account id, status, address, address updated at, created at, released at |
| install keys | hash, name, created at, last used at, revoked at                               |
| reserved     | pattern, reason                                                                |
| audit        | time, account, name, action, result, request source address (kept 30 days)     |

It stores no Moss content, no certificates or keys, no Tailscale identity, and no traffic.

### Changes inside Moss

- **Trusted origins.** Today the allowed browser origins live only in the settings file
  (`MOSS_AUTH_TRUSTED_ORIGINS`) and a restart. A new feature may not require a hand-edited file, so
  the panel must add and remove origins through the fixed host operation described in the
  installer spec, keeping the old origin (so a failed switch cannot lock the owner out). The
  existing no-lockout rules from the TLS specs apply unchanged.
- **Host operations.** Reading the Tailscale address, enabling the Tailscale-provided HTTPS name and
  writing certificate files need the host, not the container. They go through the installer's fixed
  host-operation contract. How that contract exposes a read of `tailscale` state is not verified
  here and is the first thing slice 1 settles; fallback is a pasted value.
- **Settings.** New admin section "Remote access" (see App map impact).
- **Cookies.** Slice 1 confirms the sign-in cookie is host-only (not scoped to a parent domain) so
  the same session is never offered across the three addresses.

## Security and abuse

### Why the Public Suffix List matters

Browsers decide which sites share cookies and storage by the "registered domain". Without a list
entry, `ben.meetmoss.com`, `mallory.meetmoss.com` and the marketing site count as one site. An
owner could then set cookies for the whole of `meetmoss.com`, overwriting or injecting cookies
seen by other owners' Moss sessions and by the marketing site ("cookie tossing"). With the entry,
`meetmoss.com` is treated as a boundary between mutually untrusting parties (the list's own
guidelines describe it that way), and each name is its own site.

Let's Encrypt also uses the list. Its limit of 50 new certificates per registered domain per week
(counted across every account) applies to all of `meetmoss.com` together if the list does not
carry it. That would cap the whole service at roughly 50 new names a week. Renewals are exempt
from that limit, so only first issuance counts.

Consequences to plan for.

- The list's guidelines say reviewers are volunteers with no time promise, that browsers pick up
  changes slowly, that a domain needs more than two years of registration left, and that an entry
  made only to get around Let's Encrypt limits is declined. The cookie-isolation reason is real and
  is the one to state. Small projects with fewer than thousands of users are "likely declined", so
  acceptance at launch size is uncertain.
- Ownership is proved with a `_psl` TXT record on the domain. Ben must be the submitter (a third
  party cannot).
- **If the entry is not live at launch**, the service launches as an invite-limited beta capped
  below 50 new names a week, and Let's Encrypt's rate limit adjustment form is filed in parallel
  (it takes a few weeks per Let's Encrypt). Plain Tailscale is unaffected.
- Putting `meetmoss.com` on the list makes the marketing site at the apex a separate site from every
  name. That is the intent. The marketing site must not depend on cookies shared with subdomains.

### What a malicious owner can do with a name

| Attack                                                              | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point the name at a victim's home router or a public server         | Service accepts only Tailscale address ranges; anything else is refused. Without this rule the name becomes a DNS-rebinding tool aimed at people's LANs.                      |
| Phishing under a trusted-looking name (`paypal-login.meetmoss.com`) | A name only resolves to a Tailscale address, so only people on the attacker's network or sharing their device can load it. Still: reserved list, similarity checks, takedown. |
| Impersonate the project (`login`, `support`, `moss`)                | Reserved list of project, product, infrastructure, security and common brand words; names that merely contain a reserved word are held for review.                            |
| Look-alike characters                                               | ASCII letters, digits and hyphens only; no `xn--` prefix; no leading, trailing or double hyphen; 3 to 30 characters.                                                          |
| Squat many names                                                    | One name per account at launch, email-verified accounts, rate limits per account and per source address, unused names released (see Lifecycle).                               |
| Cookie tossing against other names or the marketing site            | Public Suffix List entry. Browser support for new entries arrives with browser updates and is not under the project's control.                                                |
| Use the name for email or other services                            | The service writes no MX or TXT records for names. Mail needs those.                                                                                                          |
| Overwrite another name's records or challenge                       | Install token is bound to one name; the service re-checks ownership on every write.                                                                                           |
| Burn the project's certificate allowance with failed attempts       | Per-name limits on challenge writes (recommended: 10 a day), and the service refuses issuance support for names failing basic checks.                                         |
| Exhaust Cloudflare API limits (1,200 calls per 5 minutes per token) | Queue writes in the Worker; reject bursts early; each registration is expected to need only a few API calls.                                                                  |

A public-address CGNAT carrier network also uses `100.64.0.0/10`. A user on the same carrier network
as the attacker might reach an attacker's host at such an address. This residual risk is judged low
and is noted for completeness; it is not verified.

### Takedown

The operator can suspend an account or a name from an admin tool: delete the DNS records, block
the name from re-registration, revoke the install token. Existing certificates cannot be
withdrawn by the service (only the holder of the certificate key or the CA can revoke), so
takedown stops resolution and renewal but a certificate outlives it by up to 90 days. A contact
address for abuse reports goes on the sign-in page. Who monitors it is an open question.

### Certificate transparency

Every certificate is published in public Certificate Transparency logs, so each chosen name is
public and permanently searchable. The sign-in and name screens say this plainly before the owner
picks a name. The same is true of names from Tailscale's own HTTPS feature (Tailscale's page warns
that machine names are published).

### Secrets

The certificate private key and ACME account key live in the Moss data volume. They are not sent to
the service, not logged and not placed in job payloads. The install token is stored encrypted at
rest like other connector credentials. Per the repo rule on security claims, the claim "the key never
leaves the machine" must be checked in slice 4 by reading the ACME client library's network calls
before the sentence appears in the product, a doc, or a PR.

## Privacy

- The service stores an email address, the chosen name, a Tailscale address and a short-lived audit
  trail. It sees the owner's source address on each request.
- The public DNS record links the name to a Tailscale address. These addresses are not routable on
  the internet and are not unique across Tailscale accounts, so the record reveals little, but it
  is public.
- Names appear in Certificate Transparency logs.
- The service sees no Moss content and carries no Moss traffic.
- A privacy statement is needed on the sign-in page. Retention: audit entries 30 days; account and
  name records until release plus a hold period.

## Failure modes

### DNS rebinding protection

Some routers and DNS filters drop answers where a public name resolves to a private address. This
affects only the name path (public name to a Tailscale address). The Tailscale-provided name is
not a public name in the same sense but can be affected too. Verified from a forum report: the
dnsmasq 2.93 release shipped with OpenWrt 25.12.5 added the `100.64.0.0/10` range to its rebind
protection, and that broke Tailscale names until `ts.net` was exempted. Older dnsmasq versions are
documented as blocking only the standard private ranges. I did not verify the default behavior of
Pi-hole, FritzBox, Unbound or other routers; the setup test is what finds out.

**The test.** Moss compares what the machine's normal resolver returns for the name with what a
public resolver returns over HTTPS (DNS-over-HTTPS). If the normal resolver returns nothing or an
error while the public one returns the address, rebinding protection is the likely cause. Each other
device then opens a short check page to prove its own resolver, since each device may use a
different one (home router, mobile data, a public hotspot, a filter on the device).

**What Moss says.** The panel names the likely product when it can tell and gives one instruction,
in the form "allow `meetmoss.com` in the DNS rebind exception list", with the product's own menu
location for the common ones. Examples to write after checking each vendor's docs in the build
slice (not verified here) are Pi-hole, FritzBox, OpenWrt, Unbound and AdGuard Home. When the owner
cannot change the filter, the panel offers the Tailscale-provided name instead.

### Tailscale not logged in or not running

Moss reads status before each step. States and the message for each: not installed, installed but
signed out, running, connected but the machine is key-expired, tailnet has HTTPS off. A signed-out
machine after a reboot is the common case; Moss shows the access row as "not reachable" and a
notification rather than failing silently. The registration service keeps the record unchanged.

### Tailscale's own DNS feature (MagicDNS) is off

Tailscale's HTTPS documentation says the HTTPS certificate feature needs MagicDNS on for the
tailnet and uses the tailnet's name. So the Tailscale-provided HTTPS name is unavailable when it is
off (verified). The meetmoss name does not depend on it, because the name resolves through public
DNS. This is the strongest reason to keep the meetmoss name as a real option. Not verified is
whether turning off Tailscale DNS only on the server (the per-device setting, as opposed to the
tailnet setting) still lets that server obtain a Tailscale certificate and lets other devices
resolve the `ts.net` name. Slice 1 tests this on a real tailnet; Ben should say which of the two
settings he means.

### Address changes

A Tailscale address can change if the machine is removed and re-added. Moss checks the address at
startup and daily, calls the address-update endpoint when it differs, and warns if the update fails.

### Certificate renewal

Renewal runs at 30 days remaining and retries with back-off. If the certificate expires, browsers
show a hard error. Moss falls back to the always-available earlier address and tells the owner.
Renewal needs the service to be up; if it is down the install retries until expiry and then warns.

### Let's Encrypt limits

New certificates per registered domain, duplicates per name, and authorization failures are
enforced by Let's Encrypt (figures above are from its rate-limits page). The install never loops
on a failing order, and a blocked order shows its retry time in the panel.

### Service outage

Existing names keep resolving (Cloudflare serves the records) and existing certificates keep
working. Registration, address updates and renewals pause.

## Hosting and cost

- **Registration service.** Free Workers plan allows 100,000 requests a day; this is far above
  expected traffic. A paid plan is the fallback if the CPU limit bites. Price not verified.
- **Domains.** meetmoss.com exists. A second domain for challenge records is a few currency units a
  year (not verified). The public suffix entry requires keeping meetmoss.com registered for more than
  two years ahead.
- **DNS record count.** Every name is one or two records in the main zone. Sources I found disagree
  on Cloudflare's per-zone limit for the free plan (1,000 or 200 for newer zones; 3,500 on a paid
  plan). None is from Cloudflare's own documentation, and the page that should state it does not.
  Treat this as a hard cap on beta size until Ben confirms the plan limit in the dashboard.
  Beyond that the choices are a paid plan or the service running its own authoritative DNS. The
  service keeps its DNS writes behind one interface so the backend can be swapped.
- **Email for sign-in links.** An outbound email provider is needed; free tiers exist, not
  evaluated here.
- **Operator time.** Abuse reports and takedowns need an owner.

## Slices

Sizes are complexity (S, M, L), not time. Slices 1 and 2 can run in parallel. Each slice includes
its app-map change and release note.

| #   | Slice                                                                                                                                                                                                                                                                                       | Size | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| 0   | Approve this spec; screen discussion and mockups for every screen listed below; open the issues.                                                                                                                                                                                            | M    | -          |
| 1   | Tailscale guided path. Detect Tailscale state and address through the host operation, add and remove trusted origins in the app, Tailscale-provided HTTPS name, second-device check, access row. Includes the live test of MagicDNS settings and the cookie-scope check. No service needed. | L    | 0          |
| 2   | Registration service core. Worker, storage, sign-in link, device-code flow, names with reserved list and validation, address range enforcement, audit log, rate limits, DNS backend interface. Spike confirms Worker limits and the Cloudflare record cap first.                            | L    | 0          |
| 3   | Operator setup and safety. Tokens, second zone, Public Suffix List submission and `_psl` record, abuse contact, admin takedown tool, runbook.                                                                                                                                               | M    | 2          |
| 4   | Certificates. Install-side ACME with the delegated challenge, endpoints for challenge writes, file writing and Caddy reload, renewal job and notifications, back-off. Includes the check that the private key is never sent anywhere.                                                       | L    | 1, 2       |
| 5   | Name flow in Moss. Sign-in, pick and check name, register, address refresh, rename and release.                                                                                                                                                                                             | M    | 2          |
| 6   | Rebinding test and guidance. Resolver comparison, per-device check page, vendor instructions.                                                                                                                                                                                               | M    | 5          |
| 7   | Live proof and docs. Real tailnet, real phone, a router with rebind protection on and off; operations doc and `self-hosted-tls.md` cross-link; companion app over the name.                                                                                                                 | M    | 4, 5, 6    |

Slice 3 must finish before any public launch. Slices 5 to 7 are hidden from release until the
Public Suffix List decision (see Open questions) is made.

## Screens needed (drawn for review, not approved)

Mockups: `docs/superpowers/mockups/remote-access/index.html` (open from disk, no server). Each
screen shows the wide window and the phone, with a button per state. Status: awaiting Ben's
review; the questions at the bottom of the mockup page need his ruling.

| #   | Screen                     | States drawn                                                                           |
| --- | -------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Where you start            | Ready screen, Ready once set up, empty Settings section, choose where from             |
| 2   | Tailscale on this computer | Not installed, signed out, sign-in expired, running                                    |
| 3   | Your phone and laptop      | Waiting, one device seen, two devices, nothing after a while                           |
| 4   | Secure address             | Available, turning on, done, not available with the name recommended                   |
| 5   | About the name             | One state                                                                              |
| 6   | Sign in to meetmoss.com    | Choose GitHub or Google, waiting for browser, not invited yet, service down, signed in |
| 7   | Pick a name                | Empty, checking, free, taken with suggestions, reserved, too short, bad characters     |
| 8   | Network check              | All pass, devices still to check, router blocking with a fix                           |
| 9   | Certificate and switch on  | In progress, failed, rate limited, service down, open on a device, ready               |
| 10  | Settings, once set up      | Name and Tailscale, Tailscale only, changing name, releasing                           |
| 11  | Banners and notifications  | Tailscale signed out, address changed, renewal failing, certificate ran out            |

The phone layout (item 12 below) is drawn beside every screen. Sign-in uses GitHub or Google per
the Decided list, so item 6's email wording below is superseded.

1. Access panel entry on the first-run Ready screen and in Settings ("Use Moss from other devices").
2. Tailscale: install on this machine (with the detected state: not installed, signed out, running).
3. Tailscale: add your phone and laptop (links, QR code, second-device check result).
4. HTTPS choice: Tailscale-provided name available, or not available and why.
5. Name path intro (what it is, what becomes public, that it is optional).
6. Sign in to the registration service (GitHub or Google, waiting for the browser, signed in).
7. Pick a name (live availability, refusal reasons, suggestions, public-log notice).
8. Network test results (resolver check, each device check, plain-language fixes per router/filter).
9. Certificate progress and failure states.
10. Done / status row (name, address, certificate expiry, last verified) with rename, release,
    sign out.
11. Notifications and banners (Tailscale signed out, address changed, renewal failing, certificate
    expiring).
12. Phone layout of all of the above.

## App map impact

Same PR as each slice.

- **Core settings (`CORE_APP_SETTINGS` in `packages/shared/src/app-map-core.ts`).** Add `remoteaccess`,
  label "Remote access", path `/settings?section=remoteaccess`, admin scope, describing the
  Tailscale path, the optional name, the verified address and the certificate state. Update the
  `host` entry's description if its host guidance mentions reachability.
- **Core screens (`CORE_APP_SCREENS`).** Add the access panel reached from the Ready screen and update
  that screen's entry.
- **Core features, errors and remediations.** Declare these, each with a remediation Moss can state
  - Tailscale not installed, or signed out (open the Tailscale app and sign in).
  - Tailscale HTTPS unavailable on the tailnet (enable it in Tailscale's admin console, or use a
    meetmoss name).
  - Name taken, reserved or invalid (pick another).
  - Registration service unreachable (existing addresses keep working; try later).
  - DNS rebinding protection blocking the name (allow `meetmoss.com` in the router or filter).
  - Certificate request blocked by a rate limit (retry time is shown).
  - Certificate renewal failing (check service reachability; the earlier address still works).
  - Address changed and update failed.
- **Requirements.** The access panel requires an admin owner; the name path requires a Moss project
  account and internet access to the registration service.
- Moss's self-knowledge needs to know that traffic never passes through the Moss project and that
  names are public; both go in the feature descriptions.

## Decided

Decided by Ben on 2026-10-27.

1. **The registration service runs as a Cloudflare Worker** on the account that owns meetmoss.com.
   The home-box option is dropped. The slice 2 spike still checks the free plan's CPU limit and
   storage fit, with the paid Workers plan as the fallback.
2. **User names stay under `meetmoss.com`.** No separate user-content domain. This requires the
   Public Suffix List entry for `meetmoss.com`, and the marketing site at the apex shares no cookies
   with names.

## Open questions for Ben (most important first)

1. **What if the Public Suffix List declines or delays the entry?** The list says small projects
   (under thousands of users) are likely declined and gives no time promise. _Recommendation: launch
   as an invite-limited beta under 50 new names a week, file Let's Encrypt's rate limit form
   in parallel, and keep plain Tailscale the headline feature._
2. **Account sign-in method for the registration service.** Email link, GitHub or Google sign-in,
   or a Moss-project account that also serves other things later. _Recommendation: email link only
   at launch (no passwords, no third-party identity), with abuse limits per email domain._
3. **Which Tailscale DNS setting do you keep off on the server?** The tailnet-wide MagicDNS
   setting, or only the server's own "use Tailscale DNS" setting. The first disables Tailscale's
   HTTPS names entirely; the second may not. _Recommendation: tell me which, and I will test it in
   slice 1; either way the meetmoss name path stays independent of it._
4. **Cloudflare plan and record cap.** What per-zone record limit does your zone show, and are you
   willing to move to a paid plan or run your own DNS if the beta grows past it? _Recommendation:
   check the dashboard now; plan the beta size from the number; keep the DNS backend swappable._
5. **Who watches the abuse address and approves takedowns?** _Recommendation: you, with a short
   written policy (what gets a name removed), and an automated first pass on names that match the
   reserved patterns._
6. **Name limits.** One name per account, 3 to 30 characters, released after 90 days without an
   address refresh, 30-day hold before reuse. _Recommendation: exactly that._
7. **Second domain for challenge records.** A cheap unrelated-looking domain, or one named for
   the project. _Recommendation: a project-named domain in its own zone with its own token, never
   shown to users._
8. **Default vs optional.** Plain Tailscale is the default and the name is optional, as you asked.
   Given that Tailscale's HTTPS needs the tailnet's DNS feature, an owner with it off gets no HTTPS
   from plain Tailscale at all. _Recommendation: keep your ordering, but when HTTPS is
   unavailable, present the name as the recommended fix instead of a side option._

## Not verified

- Per-zone DNS record limit on Cloudflare's free and paid plans (no primary source found).
- Whether Worker free-plan CPU limits and the chosen storage fit the service (spike in slice 2).
- Whether Cloudflare allows delegating a subdomain to a second zone below Enterprise.
- Tailscale's IPv6 address range for devices; confirm against Tailscale's docs.
- The default rebind behavior of Pi-hole, FritzBox, Unbound and AdGuard Home.
- Whether per-device Tailscale DNS off still allows certificates and name resolution.
- How the installer's host-operation contract can read Tailscale state.
- Whether browsers and safe-browsing lists treat one name's abuse as site-wide once the suffix
  entry is live.
- Pricing of the paid Workers plan, the second domain and any email provider.

## Sources checked

- Let's Encrypt, challenge types (DNS-01, CNAME delegation, credential risk).
- Let's Encrypt, rate limits (50 new certificates per registered domain per week, five duplicates
  per exact name per week, renewal exemptions, override form, use of the Public Suffix List).
- Cloudflare, API limits (1,200 requests per 5 minutes per token), token creation (zone scope, DNS
  Edit, IP restriction, lifetime), Workers limits (free plan).
- Tailscale, enabling HTTPS (needs MagicDNS, names appear in Certificate Transparency logs, keys
  stay on the machine, 90-day certificates, renewal duty), and `tailscale serve` (background mode
  persists across restarts).
- Public Suffix List guidelines (`_psl` TXT proof, two-year registration, no time promise, limits
  on rate-limit-driven entries, small projects likely declined).
- OpenWrt forum report on dnsmasq 2.93 adding the `100.64.0.0/10` range to rebind protection.
