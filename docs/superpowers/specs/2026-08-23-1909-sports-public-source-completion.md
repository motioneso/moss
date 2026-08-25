# #1909 — Complete Public Sports News Sources

**Status:** Approved — Codex/Fable aligned
**Date:** 2026-08-23
**Owner:** Ben
**GitHub:** [#1909](https://github.com/motioneso/moss/issues/1909)
**Repairs:** [#1572](https://github.com/motioneso/moss/issues/1572)
**Separate future scope:** [#1682](https://github.com/motioneso/moss/issues/1682)
**Packaging amendment:** [#1946](https://github.com/motioneso/moss/issues/1946) supersedes the
separate renderer image: Chromium and the renderer entrypoint ship in the single Moss image.

## Problem

#1572 shipped the public-source preview, confirmation, assignment, persistence, and settings shell,
then closed before its runtime slices were built. Production accepts and saves public Sports
sources, but every saved row keeps the database default `pending` state. Nothing writes
`last_checked_at` or `last_success_at`, assignments do not contribute headlines to Sports or Today,
and Moss has no actor-scoped tool for explaining or repairing source status.

The current preview is also too shallow for publishers whose team and league news is exposed only
after rendering a public page or calling a public JSON endpoint. This is one incomplete public-source
capability, not authenticated-source work. #1682 remains exclusively for publishers that require
credentials, API keys, cookies, or login.

## Production Evidence

On 2026-08-23, both production custom Sports source rows were enabled and assigned, but had:

- `health_state = 'pending'`
- `last_checked_at IS NULL`
- `last_success_at IS NULL`
- no safe failure reason

The app logged an app-map coverage gap when Moss was asked to inspect the sources. Code tracing
confirmed that Sports reads the health columns but has no runtime writer, source assignments are
used only by settings CRUD, and the Sports manifest exposes follow tools but no source tools.

## Outcome

A user can configure any technically reachable public sports publisher they are authorized to use.
Moss first prefers RSS/Atom. When a publisher needs shallow HTML or public JSON extraction, Moss can
inspect a bounded public page in an isolated discovery browser and derive a strictly validated,
declarative recipe. One publisher can map different followed teams and leagues to different public
targets without publisher-specific code.

Normal refresh uses only bounded safe HTTP. Custom headlines enter the existing Sports ranking and
presentation path with trusted source identity and assignment scope. Source and target health report
the last real fetch, and both settings and Moss expose the same preview, confirmation, retry, and
recipe-rebuild paths.

The browser remains a separate, restricted Compose process, but it runs from the same downloadable
Moss image as the application. Operators do not pull or promote a second renderer package.

## Design Invariants

1. User confirmation owns publisher authorization; Moss owns and always enforces technical safety.
2. Every external byte crosses the existing pinned safe-fetch boundary. A discovery browser has no
   direct network egress.
3. AI produces schema-validated data only. It never produces or installs executable scraper code.
4. A confirmed recipe can retrieve only from its confirmed publisher host set. Publisher content
   cannot expand network authority.
5. Assignment-derived team and league scope is trusted application data and is never inferred from
   publisher article ids at composition time.
6. Browser discovery is exceptional and confirmation-time only. Runtime refresh never launches a
   browser or fetches article bodies.

## Scope

### 1. Discover a publisher through one safe network boundary

- Accept either a public publisher root or an exact public team/league page. Start with the existing
  `fetchWebResource`/`fetchWebResourceBytes` boundary and prefer a discovered RSS/Atom feed or static
  listing that can be validated without a browser.
- Replace Sports' current binding AI policy verdict and robots gate. `resolveSportsSourceInput` must
  not call `decideSourcePolicy`, and `buildSportsDiscoveryPorts` must not use `sportsRobotsGate` as an
  allow/deny decision. Robots and terms signals may be displayed as informational preview evidence;
  technical responses such as `401`, `403`, a login wall, or a CAPTCHA remain binding failures.
- If safe HTTP is insufficient, a separate ephemeral browser runner may render one submitted public
  page and observe its DOM and public GET/fetch/XHR traffic. The runner:
  - runs unprivileged in a disposable process/container with a fresh profile, no host mounts,
    credentials, user cookies, persisted storage, downloads, or access to application secrets;
  - has direct network egress denied at the OS/container boundary; every navigation and subresource
    is intercepted and fulfilled through the pinned safe-fetch proxy;
  - permits only `GET`/`HEAD`, revalidates HTTPS, DNS/IP, redirects, allowed host, content type,
    response size, and rate limits on every hop, and blocks WebSocket/WebRTC, service workers,
    downloads, forms, and side-effecting methods;
  - blocks images, fonts, advertising, analytics, and unrelated third-party resources;
  - is killed after at most one top-level page, 40 proxied requests, 10 MiB aggregate responses,
    20 seconds, 512 MiB memory, and one CPU; and
  - contributes at most five same-publisher candidate pages/application GETs to recipe evidence.
- Browser discovery is enabled in production only when deployment packaging enforces the no-egress,
  unprivileged, resource-limited sandbox. If those controls are absent or fail closed, browser-only
  sources are reported `unsupported`; Moss never falls back to direct browser networking.
- The initial confirmed publisher identity is the submitted host plus the safe final redirect host.
  Discovery may propose at most four additional exact HTTPS hosts under the same registrable
  publisher domain when those hosts are referenced by accepted first-party content. The preview
  shows the complete host set. Unrelated third-party hosts are never recipe fetch hosts.
- Treat every page, DOM node, script string, header, and JSON value as untrusted. Sanitize and cap
  evidence before provider-agnostic structured AI sees it. Publisher instructions cannot alter the
  prompt, tools, schema, host set, fetch budget, or safety policy.

### 2. Derive and confirm a declarative recipe and assignment targets

- Give discovery the selected followed targets' canonical competition/team labels and keys. It may
  inspect same-publisher navigation or a bounded public GET search to resolve the corresponding
  team/league page or opaque public id. It must replay every resolved target and show a scoped sample;
  it never activates a guessed mapping.
- If automatic target resolution fails, the user may paste the exact public target URL for that
  assignment. The pasted target goes through the identical safe fetch, recipe replay, preview, and
  confirmation path.
- Structured AI may emit only a versioned declarative recipe containing:
  - exact confirmed publisher fetch hosts;
  - one public HTTPS `GET` request template whose scheme and host are fixed;
  - declared path/query parameter slots with application-defined encoding and strict length/character
    bounds for persisted opaque ids;
  - fixed headers selected from an application allowlist such as `Accept` and `Accept-Language`;
  - CSS selectors or simple JSON field paths for item collection, headline, public article URL,
    publisher label, and published time;
  - bounded normalization operations from a fixed application-owned vocabulary; and
  - explicit team/league scope and item limits.
- A recipe cannot contain JavaScript, TypeScript, shell, regular-expression source, browser script,
  expressions, callbacks, generated headers, cookies, credentials, request bodies, pagination, or
  an open-ended URL. Unknown fields and operations are rejected.
- Validate AI output against a strict schema, expand only declared parameter slots, and replay it
  through safe fetch before preview. Every expanded request, redirect, and observed browser request
  must stay inside the previewed publisher host set. A public article URL may point elsewhere as an
  output link, but it can never become a recipe or article-body fetch target.
- The confirmation artifact is opaque, actor-scoped, one-use, and short-lived. It binds the submitted
  publisher URL, canonical publisher identity, confirmed host set, recipe schema version and
  fingerprint, exact resolved targets/parameters, bounded samples, selected follow ids, and the
  authorization acknowledgement text shown to the user.
- A new-source preview accepts zero or more assignments. Confirming zero assignments saves an
  inactive source. Confirming assignments atomically creates the source and only the targets present
  in the artifact. Changing assignments later previews every newly added or changed target and then
  atomically replaces the assignment set; removing an assignment needs no external fetch.
- Persist the validated publisher recipe and each assignment's target URL/parameters. One publisher
  recipe can therefore map a team such as Arsenal and a league such as the Premier League to distinct
  public targets without domain-specific code.
- Do not add branches such as `if domain === "fotmob.com"`. FotMob is an acceptance example for this
  generic model, not a built-in adapter or allowlist entry.

### 3. Refresh and compose custom headlines

- Add one Sports-owned public-source reader/application service used by overview composition,
  settings Retry, and Moss Retry. It reads enabled sources and active assignments through
  `SportsSourcesRepository` under the existing `DataContextDb` owner scope.
- Prefer a confirmed RSS/Atom feed. Fetch a shared feed once per source per refresh. Otherwise fetch
  each unique validated assignment target once. Enforce at most 20 active custom-source assignments
  per owner and at most 30 custom-source requests per composition run, with global concurrency four
  and per-domain concurrency two. A budget-exceeded target is not fetched and records a stable safe
  failure rather than silently losing coverage.
- Use `fetchWebResource` as the arbitrary-public-host boundary. Do not register user domains in the
  static external-source manifest. Reuse the existing exported `DatasetCache` primitive behind the
  Sports reader with a bounded entry count and the existing Sports-headline freshness/stale window;
  key entries by recipe fingerprint plus the canonical expanded request identity: normalized HTTPS
  URL after encoded path/query substitution and any allowlisted response-varying headers. Never key
  only by the display target URL. Identical public request identities may share cached content;
  owner-specific health remains separate. Retry bypasses the cache. A cache hit does not advance
  `last_checked_at` because that timestamp means a real external fetch.
- Runtime enforces HTTPS, confirmed publisher hosts, public-network DNS/IP checks before requests and
  after every redirect, response timeout/size/content-type limits, sanitized text, safe public
  article URLs, item caps, per-domain rate limiting, `429`/`Retry-After` backoff, and the recipe's
  declared extraction vocabulary.
- Runtime never launches a browser, executes publisher JavaScript, accepts cookies, submits forms,
  follows pagination, recursively crawls, fetches article bodies, bypasses authentication/paywalls,
  evades CAPTCHAs or rate limits, or mimics credentials.
- Extend the internal Sports headline contract with trusted application-owned `origin` (`espn` or
  `custom`), custom `sourceId`, publisher label/domain, competition key, and assignment-derived team
  keys. ESPN adapters continue resolving ESPN `sourceTeamIds`; custom headlines enter after that
  ESPN-only resolution step with their persisted assignment scope intact.
- Public story attribution comes from the persisted source identity, never an extracted or model
  supplied publisher field. Extracted article ids are source-local data and never passed to an ESPN
  dataset.
- Merge custom headlines with ESPN before the existing URL deduplication, ranking, safe-link, and
  card-shaping seams. Article-body enrichment is guarded to `origin === "espn"`; a custom feature
  uses the existing summary/dek fallback and can never trigger the ESPN `articleBody` dataset.
- A failing source or target never blocks ESPN or another custom source. Successfully refreshed
  targets may still contribute when another target of the same source fails.

### 4. Make source and target health truthful

Persist health for each assignment target as well as the existing source aggregate. Both use the
existing source state vocabulary; recipe drift is a stable reason code on `failing`.

| State           | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `pending`       | No real check has completed yet, or a newly selected target still awaits preview.             |
| `healthy`       | The latest real bounded fetch returned a supported shape, including a valid empty collection. |
| `failing`       | A retryable transport/upstream failure, budget failure, mixed target failure, or drift.       |
| `unsupported`   | The public response cannot be handled by the supported feed/declarative recipe path.          |
| `auth_required` | The publisher technically requires credentials; recovery points to #1682.                     |
| `disabled`      | The source is disabled; no fetch is attempted.                                                |

- A required item collection that is present but empty is healthy. A missing required collection,
  selector, or field shape after a previously successful replay is `failing` with
  `recipe_drift`; it is not a network or authentication failure.
- Every real target fetch advances that target's `last_checked_at`. Success sets `healthy`, clears
  stale failure metadata, and advances `last_success_at`. Failure preserves `last_success_at` and
  stores only a stable reason plus a short safe message.
- Recompute the source aggregate transactionally after target results:
  - `disabled` when the source is disabled;
  - `pending` only before any required real check or while a selected target awaits preview;
  - `healthy` only when every active target is healthy;
  - `unsupported` or `auth_required` only when every active target has that same state; and
  - `failing` with `partial_target_failure` for mixed outcomes, or the target's stable reason when
    all active targets fail the same retryable way.
- For a shared feed, one source-level fetch result is copied to its active target health rows. An
  unassigned confirmed source keeps the health established by its source preview but is inactive.
- Source timestamps aggregate target timestamps: `last_checked_at` is the newest real target check;
  `last_success_at` is the newest successful real target check. Cache hits never manufacture checks.
- Never store response bodies, DOM, prompts, stack traces, private addresses, unsafe URLs, or secrets
  in health metadata.

### 5. Give settings and Moss one recovery surface

- Keep `Checking…` only for an in-flight preview/check request. Persisted `pending` renders as
  “Awaiting first check” or “Awaiting preview,” with the correct action.
- Settings shows source aggregate health, last check/success, safe message, enabled/assigned state,
  and each assignment's public target plus health/recipe status.
- Retry calls the shared reader, bypasses its cache, checks all active targets within the same budget,
  persists health, and returns the updated bounded DTO. `recipe_drift` offers Rebuild recipe;
  unsupported offers Remove or replace-by-remove-and-add; `auth_required` points to future #1682.
- Add actor-scoped assistant tools using the same application services and DTOs as settings:
  - read-risk `sports.listSources`;
  - read-risk external-content `sports.previewSource` and write-risk `sports.confirmSource` for a new
    URL plus selected follows;
  - read-risk external-content `sports.previewSourceAssignments` and write-risk
    `sports.confirmSourceAssignments` for an exact replacement assignment set;
  - read-risk external-content `sports.rebuildSourceRecipe` and write-risk
    `sports.confirmSourceRecipe` for recipe drift; and
  - write-risk `sports.retrySource` and `sports.removeSource`.
- Preview tools return an opaque confirmation id and bounded public samples, host set, target mapping,
  and informational policy signals. Confirm tools accept only that id plus the exact displayed
  identity fields and explicit authorization acknowledgement; they do not accept a recipe or target
  URL synthesized by Moss at confirmation time.
- `sports.rebuildSourceRecipe` reruns bounded discovery and replay without changing the saved source.
  It returns bounded scoped samples, publisher and target identities, the complete fetch-host set,
  and a confirmation id. The preview store retains the exact validated recipe, resolved targets,
  source baseline, and authorization acknowledgement.
- `sports.confirmSourceRecipe` atomically replaces the saved recipe and targets only when the artifact
  is owner-matched, unexpired, unused, identity-matched, based on unchanged source state, and backed
  by successful replay. The approval identifies the exact publisher, fetch-host set, and target
  mappings; samples remain visible in the preceding preview. The confirm tool never accepts recipe
  JSON, host authority, or newly synthesized targets from Moss.
- All write tools use `sports.sources`, a Sports source action family, normal confirmation, audit,
  and existing undo behavior where the platform supports it. Unknown or cross-owner ids return the
  ordinary bounded not-found result.
- Moss diagnoses only from `sports.listSources`; it does not need database, shell, logs, generic
  app-map access, raw response bodies, or the full recipe.

### 6. Keep publisher authorization user-owned

- Moss does not maintain publisher allow/deny lists or ask AI to adjudicate whether retrieval is
  lawful, licensed, or permitted. The user is responsible for having permission to retrieve and use
  the selected public source.
- Preview shows the publisher identity, exact fetch-host set, samples/targets, informational robots
  or terms signals when available, and the authorization acknowledgement. Confirmation persists the
  acknowledgement timestamp bound into the confirmation artifact.
- Informational policy signals never weaken technical restrictions. A publisher's technical denial,
  authentication requirement, unsafe network target, redirect outside the host set, rate limit, or
  unsupported content remains binding; Moss does not work around it.
- The applied `app.sports_policy_verdicts` table remains for migration compatibility but is no longer
  read or written by Sports. Do not spend this repair dropping an inert owner-scoped table.

### 7. Complete owner lifecycle coverage

- Include public custom-source metadata, assignments, and bounded health in the actor's Sports export
  section. Never export recipe JSON, opaque preview artifacts, response bodies, prompts, DOM, or logs.
- Keep deletion owner-scoped and cascade-backed through the existing Sports tables and any new
  Sports-owned preview persistence.

## Persistence Changes

Add a new Sports-owned migration; never edit applied migration `0190_sports_custom_sources.sql`.

- Extend `app.sports_custom_sources` with validated recipe JSON, recipe schema version, fingerprint,
  recipe status, exact confirmed fetch-host array, and authorization-confirmed timestamp.
- Extend `app.sports_source_assignments` with resolved target URL, bounded recipe parameters/opaque
  ids, preview status, target health state/reason/message, and target check/success timestamps.
- If confirmation artifacts must survive multiple app processes, add one owner-scoped, expiring
  Sports preview table; otherwise reuse the existing bounded preview-store pattern. Do not create a
  general job or crawler table.
- Recipe, host, URL, parameter, and message columns have strict size/count checks. They may contain
  only public identifiers and declarative recipe data—never HTML, article bodies, prompts, scripts,
  cookies, credentials, or arbitrary code.
- Preserve owner-only FORCE RLS. Full recipe data and opaque parameters remain server-side; ordinary
  DTOs and Moss status tools expose only safe public target metadata and recipe status.
- Backfill existing rows' `authorization_confirmed_at` from `validated_at`, because their existing
  two-phase confirmation is the authorization event being grandfathered. Do not mark them healthy.
- Existing confirmed feed rows may perform their first safe refresh using `feed_url`. Existing
  `scrape` rows have no trustworthy declarative recipe, so migration marks them `failing` with
  `recipe_missing`; settings and Moss offer the confirmed Rebuild recipe path. No runtime request may
  silently launch discovery or invent a recipe for a legacy row.

## Existing Seams to Reuse or Correct

- `packages/sports/src/source/discovery.ts` — keep URL normalization/feed/static discovery; remove
  Sports AI legal-policy adjudication and add strict recipe validation/replay.
- `packages/web-research/src/reader.ts` — the sole pinned safe-fetch boundary for HTTP and proxied
  browser resources.
- `packages/datasets/src/cache.ts` — reuse bounded `DatasetCache` directly; do not place arbitrary
  publisher domains in the static dataset manifest.
- `packages/sports/src/source/repository.ts` — extend owner-scoped source/assignment persistence and
  add transactional health aggregation.
- `packages/sports/src/sports-service.ts` — existing overview composition; separate ESPN id resolution
  from custom assignment scope and guard ESPN body enrichment by trusted origin.
- `packages/sports/src/news-ranking.ts` and `followed-card.ts` — ranking, URL deduplication, and card
  shaping remain shared.
- `packages/news/src/source/rss-source.ts` — expose/reuse only pure RSS parsing through a declared
  public seam. Sports must not import News internals or query News tables.
- `packages/sports/src/chat-tools.ts` and `manifest.ts` — register the source action family and bounded
  assistant tools.

## Non-goals

- Credentials, API keys, cookies, OAuth, login flows, or authenticated publishers; #1682 owns them.
- Paywall, authentication, access-control, CAPTCHA, robots, or rate-limit bypass.
- A browser during normal headline refresh, or a discovery browser without enforced network/process
  isolation.
- Generated executable scraper code, recursive crawling, pagination, or article-body scraping.
- A background crawler, worker queue, scheduler, or continuously refreshed article store.
- A publisher adapter/allowlist, including a FotMob-specific adapter.
- A new priority model, parallel custom-news payload, or second Sports UI.
- Changes to News personalization data/ranking or ESPN non-headline datasets.
- The separately promised ESPN-headline disable toggle; this repair keeps ESPN headlines enabled and
  merges custom stories alongside them.

## Verification

### Focused automated checks

1. Static HTTP/feed discovery remains the first path and does not start a browser when sufficient.
2. The browser runner has no direct egress; every request crosses safe fetch, and private/rebound IPs,
   redirects outside the confirmed host set, disallowed methods/protocols, excess requests/bytes/time,
   and unavailable production sandbox controls fail closed.
3. Structured AI output containing executable/unknown fields, open hosts, undeclared substitutions,
   unsafe URLs, prompt injection, or excess operations is rejected before replay or persistence.
4. A confirmation artifact cannot be replayed, used by another actor, altered to add hosts/targets,
   or confirmed without the bound authorization acknowledgement.
5. New and changed assignments activate atomically only after every added target has a successful
   scoped preview; an exact pasted target follows the same path.
6. One RSS source contributes attributed headlines to its persisted assignments with one fetch.
7. One HTML and one JSON recipe extract a valid empty collection as healthy and bounded non-empty
   headlines without pagination, article-body requests, or a runtime browser.
8. A FotMob-shaped JavaScript fixture exposes distinct team/league public JSON GETs through browser
   discovery, persists a generic recipe plus targets, and refreshes both through plain HTTP without a
   domain branch.
9. Recipe and redirect fetches cannot leave the confirmed host set; external article URLs remain
   safe output links and are never fetched.
10. Custom headlines preserve assignment team/competition scope and trusted publisher attribution.
    They merge/dedupe/rank with ESPN, and a selected custom feature never calls ESPN `articleBody`.
11. One target failure leaves other targets and ESPN usable. Target health persists the correct
    timestamps/reason, and source aggregation follows the defined mixed/all-failed rules.
12. Present-but-empty is healthy; missing required structure is `recipe_drift`. Retry bypasses cache,
    and rebuild replaces a recipe only after successful replay and confirmed write.
13. Request, concurrency, assignment, response, recipe, and cache limits are enforced deterministically.
14. Two assignments with the same display target but different opaque parameters never share cached
    results; identical expanded public request identities do.
15. Recipe-rebuild confirmation rejects cross-actor, expired, replayed, stale-baseline,
    identity-mismatched, and acknowledgement-mismatched artifacts without changing the saved recipe.
16. `sports.listSources` is bounded and actor-scoped. Preview/confirm/assignment/retry/rebuild/remove
    tools use the same services as settings and obey permission, confirmation, audit, and owner scope.
17. Export contains bounded source/assignment health metadata but no recipes, opaque ids, bodies,
    prompts, browser evidence, or diagnostics.
18. Migration backfills authorization timestamps without changing health; legacy feeds can refresh,
    while legacy scrape rows safely require confirmed recipe rebuild.

### Live-path gate

On a live non-production instance with the production browser sandbox enabled:

1. Add two public sources to overlapping followed targets through settings and confirm the displayed
   host set, target samples, and authorization acknowledgement.
2. Use FotMob as the user-selected acceptance example: submit `fotmob.com`, map at least one followed
   soccer team and one followed league, and verify Moss discovers distinct public targets/ids without
   a FotMob adapter. This is user-authorized configuration, not Moss endorsement.
3. Verify both sources become healthy and contribute attributed stories on Sports and Today without
   duplicating a shared URL; ESPN remains present.
4. Ask Moss to list and explain the sources, then use Moss to preview and confirm a new public source
   and assignment through the normal action flow.
5. Exercise a controlled target failure, verify target/source aggregation and recovery copy, then
   retry it to healthy.
6. Change a fixture site's extraction shape, verify `recipe_drift`, and use Moss Rebuild to preview
   and confirm the repaired recipe.
7. Verify one grandfathered legacy feed refreshes and one legacy scrape row offers Rebuild without an
   operator SQL update.
8. Record the proof on the implementation PR before merge.

## Release and Existing Production Rows

No applied migration or production row is edited manually. Deployment backfills only the prior
confirmation timestamp. The first Sports/Today refresh may safely transition a legacy feed row.
Legacy scrape rows transition to a truthful `recipe_missing` failure and can recover through the
shipped settings or Moss Rebuild flow. The repair is complete only when the two currently pending
production rows reach a truthful state and can recover through application paths rather than SQL.
