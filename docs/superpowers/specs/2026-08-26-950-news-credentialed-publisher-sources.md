# Credentialed News Publisher Sources

**Status:** Approved — NewsAPI selected; RFA

**Date:** 2026-08-26

**Owner:** Ben

**GitHub:** #950

**Security tier:** Security

**Grounded on:**

- `docs/superpowers/specs/2026-07-11-personalized-news-sources-topics.md`
- `docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md`
- `docs/research/2026-08-26-news-api-key-publisher-shortlist.md`
- shipped News personalization (#897, #953, #954, #975)

## Parent and session-sized slices

#950 is a design/coordination parent. It must not become one large implementation issue. Build work
is split into child issues, each sized for approximately one agent session and with a disjoint
primary write set:

1. **Credential storage and owner-scoped lifecycle** — add the News-owned encrypted credential row,
   RLS, rotation, revocation, metadata-only DTOs, and bounded Settings API contracts.
2. **Credentialed source runtime** — accept the keyed dataset seam for actor-scoped News sources,
   resolve/decrypt credentials only inside the runtime, pin outbound hosts, and add adapter tests.
3. **News settings connection flow** — add the credential prompt, validation/rotation/revocation
   controls, connection status, and safe error copy using the existing News settings surface.
4. **Compilation, health, and live-path hardening** — connect credentialed sources to the existing
   News refresh/revalidation path, handle auth failures and stale state, add integration coverage,
   and record live UAT evidence.

Do not move #950 to `RFA` until the product decisions below are resolved, the child issues exist,
and the child build briefs name their own scoped gate and live-path responsibility.

## Problem statement

News now lets a user add a public RSS/Atom feed or shallow public publisher page. Some legitimate
publishers expose useful content only through an API or feed that requires a user-owned credential.
News currently cannot store or use that credential, and the dataset connector deliberately rejects
keyed sources at registration.

The missing capability must not become a generic authenticated scraper. Credentials are high-risk
user data, publisher access rules vary, and a key accidentally attached to the wrong host can leak
or violate terms. The feature therefore needs a narrow supported-source contract, owner-only secret
storage, safe validation, truthful health state, and revocation.

## Solution

Allow a user to submit any publisher URL through the existing News source preview flow. Moss may save
it as a public source when the existing public validation succeeds. If the URL exactly matches a
code-owned **publisher connection** that has an official authenticated access method, Moss offers
that connection instead. A connection declares its official API/feed endpoint, exact allowed hosts,
API-key header placement, bounded request shape, response parser, and terms-safe validation operation.

The user sees the resolved publisher and exact destination host before entering a key. The server
sends the key only through the connection's host-pinned request. On success it stores the source and
encrypted key atomically. On failure it stores neither a new key nor a falsely healthy source.

Moss may provide an advisory audit of the URL, publisher identity, and published access guidance, but
that audit is not a security oracle. Deterministic network and secret-handling controls always apply.

Credentialed sources use the existing News compilation, cache, ranking, attribution, refresh, and
revalidation paths. They do not create a second News feed, crawler, scheduler, or content model.

## User stories

1. As a News user, I want to connect a supported publisher that requires my own API key, so that its
   permitted headlines can appear in my News feed.
2. As a News user, I want to know which publisher and access method I am connecting, so that I do
   not submit a secret to an unknown or incorrectly resolved destination.
3. As a News user, I want the key checked before it replaces a working key, so that rotation cannot
   break a source accidentally.
4. As a News user, I want to see whether a credentialed source is connected, needs attention, or is
   revoked, so that News does not silently omit it.
5. As a News user, I want to replace or revoke a key, so that I can rotate access or stop using a
   publisher without deleting unrelated News preferences.
6. As a News user, I want a revoked or invalid key to stop fetching immediately, so that Moss does
   not keep retrying a credential that I no longer authorize.
7. As a News user, I want my credentials to remain private to my account, so that another user,
   administrator, export, log, job, prompt, or response cannot receive them.
8. As a News user, I want to ask Moss why a connected source is failing, so that I get a bounded
   explanation and a Settings next step without exposing the secret to chat.
9. As a News user, I want public custom sources to keep working without credentials, so that this
   feature does not make existing News setup more complicated.
10. As a maintainer, I want each authenticated publisher's access rules declared in code, so that an
    arbitrary user URL cannot turn News into an authenticated web fetch proxy.

## Resolved design decisions

### 1. API keys only in the first release

The first release supports publisher API keys sent in a connection-declared HTTP header. It does not
support usernames/passwords, cookies, browser sessions, arbitrary headers, query-string keys,
OAuth, refresh tokens, or login forms.

Header-only transport avoids putting secrets in URLs, access logs, cache keys, referrers, or error
messages. A publisher that requires another method remains unsupported and receives a truthful
explanation.

OAuth and interactive authentication require a separate design because they add callback state,
redirect validation, token rotation, consent scope, and more secret types.

### 2. Arbitrary URL discovery, reviewed authenticated connections

News accepts an arbitrary user URL for public-source discovery. It never treats arbitrary URL input
as permission to send a secret. An authenticated connection is offered only after an exact match to a
reviewed code-owned connection declaration. Each connection declares:

- stable connection id and user-facing publisher name;
- exact HTTPS host allowlist;
- official endpoint/feed path and HTTP method;
- fixed API-key header name and redacted validation request;
- bounded timeout, response size, item count, and rate courtesy;
- parser and sanitization rules;
- safe error mapping and support/terms reference.

The existing public URL flow remains available for any source that passes public validation. A URL
that does not resolve to a reviewed authenticated connection cannot request a key through News, but
it may still be used as a public source when the public checks pass.

The user's confirmation may acknowledge that they trust the publisher, own or are authorized to use
the credential, and accept the publisher's terms and possible source failure. It cannot waive HTTPS,
public-network, host-pinning, redirect, response-bound, secret-redaction, or RLS controls.

An NYT-like paid website subscription is not an API key. Website passwords, cookies, browser sessions,
and authenticated page scraping remain out of scope. If a publisher offers an official OAuth or
subscription-account integration, that becomes a separate issue with its own callback, consent, and
token-rotation design. This issue can still support that publisher's public RSS or reviewed API
connection where available; it does not retrieve or republish full paid article bodies.

### 3. Moss preflight audit is advisory, not authorization

Before showing a credential form, Moss performs a deterministic preflight and may show an advisory
audit:

- deterministic checks enforce HTTPS, public DNS, safe redirects, host scope, timeout/size/item
  bounds, and an accepted feed/API response;
- the audit can summarize the resolved publisher, access method, terms URL, and whether the endpoint
  appears to be official based on declared metadata;
- an LLM may explain the result in plain language, but its output cannot authorize a secret request,
  widen a host allowlist, choose an arbitrary header, or waive an unsupported authentication method;
- the user explicitly confirms the exact host and that they are authorized to use the credential.

The audit must not claim that a publisher's terms permit access when Moss cannot establish that from
the declared integration. Unknown or conflicting information is reported as unknown.

### 4. Credential ownership is per user and per connected source

One user may connect the same publisher with separate source rows only when the existing duplicate
rules permit it; each row has its own credential association. Credentials are never instance-wide,
shared between users, or attached to the curated News catalog.

Add a News-owned credential table rather than forcing dynamic per-source secrets into the static
module-credential declaration surface. Reuse the platform's `JsonSecretCipher`/AES-256-GCM
implementation at the composition boundary. News receives an injected secret capability; it does
not import Settings internals or read raw filesystem/key material.

### 5. Validate before create and before replacement

For a new source, the key is tested through the selected connection before the source and credential are
committed. For rotation, the candidate key is tested first; the existing working credential remains
active if validation fails.

Successful validation writes the source metadata and encrypted credential in one owner-scoped
transaction. The plaintext key exists only for the bounded request/runtime call and is cleared from
the Settings form after the request completes.

### 6. Credential status and source health are separate

Credential metadata exposes only:

- `not_configured`
- `configured`
- `revoked`

Source health exposes only bounded operational outcomes:

- `healthy`
- `authentication_failed`
- `temporarily_unavailable`
- `unsupported`
- `disabled`

An authentication failure retains the source row and previous safe timestamps but excludes that
source from the next compilation until the user replaces the credential. It does not delete the
credential automatically and does not repeatedly retry a known authentication failure. A transient
failure follows the existing News degradation/revalidation behavior.

### 7. Revocation scrubs the secret and disables fetching

Revocation clears the encrypted secret, records bounded revocation metadata, and makes the source
non-fetchable immediately. The source metadata may remain so the user can see what was revoked or
remove it separately. A later reconnect must validate a new key before reactivating the source.

The revoke path is owner-scoped and idempotent. No route returns the old key, ciphertext envelope,
or a secret-derived value.

### 8. The assistant cannot accept credentials

No assistant tool accepts a credential field. Moss may read the safe source/credential status and
tell the user to open News settings, but a key must be entered through the authenticated Settings
form. This prevents a secret from entering an AI prompt, tool transcript, model context, action
summary, or assistant audit record.

Assistant source diagnostics remain actor-scoped and bounded. They may say “authentication failed;
replace the key in News settings” but never expose provider bodies, headers, URLs containing secrets,
or raw error text.

### 9. Initial reviewed connection — NewsAPI

The first release supports one reviewed upstream provider connection: **NewsAPI**. It uses the
documented `GET https://newsapi.org/v2/top-headlines` endpoint with a fixed `X-Api-Key` header.
The connection declaration fixes the request shape and bounds `pageSize`, response size, timeout,
and item count; it never uses NewsAPI's query-string `apiKey` option.

NewsAPI is an aggregator, not a direct publisher or subscription connection. The UI must identify
NewsAPI as the upstream provider and preserve the source/publisher attribution returned in each
headline. A user's NewsAPI key does not grant access to an NYT-like paid website, account, cookie,
or full article body. Additional providers require their own reviewed connection declaration.

## Runtime and data boundaries

- The source row remains owner-only and `FORCE ROW LEVEL SECURITY`.
- The credential row is owner-only and `FORCE ROW LEVEL SECURITY`; no runtime admin bypass exists.
- The worker receives only actor id, source id, job kind, and idempotency metadata.
- The worker enters the normal owner-scoped data context, loads the credential, decrypts it only in
  the adapter/runtime call, and never places plaintext in a job payload.
- The adapter uses only the connection-provided host-pinned fetch function. Redirects are revalidated.
- A missing, revoked, malformed, or undecryptable key fails closed as `authentication_failed` or a
  bounded configuration error; it never becomes an unauthenticated fallback request.
- Credentialed cache entries include the owner/source identity and a credential-generation marker.
  A credentialed response can never be shared across users or survive rotation/revocation under a
  stale cache key.
- Public and credentialed source rows share the existing sanitized headline contract. Raw provider
  bodies, response headers, keys, authorization values, and stack traces never reach DTOs, logs,
  exports, prompts, or snapshots.
- Account deletion removes credential rows through the News data-lifecycle cascade. User export
  includes safe source metadata only and never includes credentials or ciphertext.
- Module isolation remains intact: News owns source behavior and source tables; the platform owns
  encryption and the host-pinned outbound capability; no module queries another module's tables.

## API and UI behavior

The existing News source preview response gains a safe indication that a resolved candidate requires
a supported credential connection. It does not include a secret field or the connection's internal header
name.

News settings adds a credential form only after the user has selected a supported connection. The form
shows the publisher name, the permitted access explanation, a password-style API-key input, status,
last successful validation time, Replace key, and Revoke access. It never repopulates the key.

Safe outcomes are explicit:

- unsupported auth method → “This publisher needs an access method News does not support yet.”
- invalid key → “The publisher rejected this key. Your previous key is still active.”
- unavailable publisher → “The publisher could not be reached. Try again later.”
- revoked key → “Access revoked. Add a new key to reconnect this source.”
- successful connection → “Connected. News will use this source on its next refresh.”

Existing public-source rows do not show credential controls. Existing public preview/confirm and
custom-topic behavior remains unchanged.

## Non-goals

- OAuth, refresh tokens, authorization-code callbacks, or any interactive publisher login.
- Usernames/passwords, cookies, session tokens, browser automation, CAPTCHA handling, or paywall
  access.
- Arbitrary user-defined API endpoints, hosts, headers, query parameters, or request bodies.
- General authenticated scraping or an authenticated proxy for arbitrary web pages.
- Credential sharing, instance-wide publisher keys, admin access to user secrets, or secret export.
- A new scheduler, crawler, article archive, generated article content, or ranking model.
- Credential entry through chat, assistant tools, notifications, logs, prompts, or job payloads.
- Supporting a publisher connection before its official access method, host scope, parser, and terms
  have been reviewed.

## Child issue briefs

Each child issue must carry only its own files, checks, and acceptance criteria. The coordinator may
run them serially because later slices depend on earlier contracts, but no child should require the
entire parent implementation in one session.

### Child 1 — [#2005](https://github.com/motioneso/moss/issues/2005): credential storage and owner-scoped lifecycle

Owns the News migration, repository, injected cipher boundary, safe DTOs, and authenticated
create/replace/revoke/status routes. Proves owner-only RLS, ciphertext-at-rest, no plaintext in
responses/logs/exports, rotation retention on failed validation, and deletion cascade. It does not
wire source fetching or build the Settings UI.

### Child 2 — [#2007](https://github.com/motioneso/moss/issues/2007): credentialed source runtime

Owns the connection type/registry, keyed adapter context, actor/source/credential-generation cache
key, host-pinned API-key request, bounded parser, and unit tests. It does not add routes, migrations,
or UI. Registration must reject any connection with an unsafe host, query-string key transport,
dynamic header name, or missing bounds.

### Child 3 — [#2008](https://github.com/motioneso/moss/issues/2008): News Settings connection flow

Owns the News client contracts and Settings components/styles needed to preview a connection, enter or
replace a key, show safe status, and revoke access. It does not change encryption, worker behavior,
or source compilation. The credential input must never be sent to an assistant or stored in browser
storage, and it must clear after submit/unmount.

### Child 4 — [#2006](https://github.com/motioneso/moss/issues/2006): compilation, health, and live-path hardening

Owns the existing News refresh/revalidation integration, auth-failure transitions, cache invalidation
on revoke/rotation, bounded assistant diagnostics, integration tests, and live UAT evidence. It does
not add a second source model or broaden the supported auth methods.

## Testing decisions

- Unit-test connection validation: exact host/path, HTTPS-only, redirect rejection, fixed header
  placement, timeout/response/item bounds, malformed responses, sanitization, and no query-string
  secret.
- Unit-test encryption and lifecycle: AES-256-GCM envelope at rest, malformed/tampered envelope,
  failed rotation preserving the old key, successful rotation invalidating the old generation, and
  revoke scrubbing the secret.
- Integration-test two users: neither can read, replace, revoke, or fetch using the other's source
  or credential. Admin access remains metadata-only.
- Integration-test secret absence from DTOs, logs, audit metadata, snapshots, exports, prompts,
  pg-boss payloads, and error messages.
- Integration-test missing/revoked/undecryptable credentials fail closed and do not issue an
  unauthenticated request.
- Integration-test auth failure stops source contribution without deleting the source; transient
  failure follows the existing News degraded path; successful replacement restores contribution.
- Integration-test public custom sources and curated sources remain unchanged.
- The live-path test uses a permitted fixture or approved test publisher: open News settings, select
  a credentialed connection, connect a key, observe the source in News, rotate to a valid key, submit an
  invalid replacement and verify the old key remains active, revoke access, and verify the source
  stops contributing. Record bounded DOM/network/job evidence on the implementation PR; do not
  capture or attach secrets.
- Run the full maintainability gate named by each child brief. The final child must also provide the
  required live-path evidence before the parent can be marked complete.

## Exit criteria

- The initial supported publisher connection set is explicitly approved and documented; no generic
  arbitrary authenticated URL path exists.
- All four child issues are complete, individually verified, and linked to #950.
- News public-source behavior remains unchanged.
- Secrets remain encrypted at rest and absent from every prohibited channel.
- Owner-only RLS and no-admin-private-data invariants remain intact.
- Foundation/type/lint/format/security checks pass for the touched slices.
- Live UI evidence proves connect, failed rotation, successful rotation, revoke, and post-revoke
  behavior on a real dev instance.

## Approval record

NewsAPI is the approved first connection. Public URL preview may resolve to a connection only after
an exact match, and each connection may map bounded JSON into the existing `NewsHeadline` contract
without exposing provider-specific DTOs beyond the adapter. Guardian and NYT remain excluded from
this header-only release until their required access method is separately verified and approved.
