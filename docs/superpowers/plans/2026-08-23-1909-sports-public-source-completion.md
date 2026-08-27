# Plan: Complete Public Sports News Sources (#1909)

**Status:** Approved — Codex/Fable aligned
**Spec:** `docs/superpowers/specs/2026-08-23-1909-sports-public-source-completion.md` (Approved)
**Repairs:** #1572
**Separate future scope:** #1682
**Packaging amendment:** #1946 supersedes the separate renderer image with the single Moss image.
**Risk tier:** high (untrusted browser execution, arbitrary public URLs/SSRF boundary, owner-scoped
RLS migration, and confirmed assistant writes)

## Delivery rule

Implement in the five slices below, in order. Slice 1 is a kill gate: do not build recipe
persistence, runtime scraping, or user-facing browser discovery until the exact production renderer
sandbox and API broker pass. Each slice leaves the branch green and may be reviewed independently;
none is user-complete until Slice 5's live-path evidence passes.

No background crawler, scheduler, job queue, publisher adapter, or general browser/RPC framework is
created. The renderer protocol remains Sports-owned and uses Node's existing `net`/stream primitives.

## Verified current seams

- `packages/sports/sql/0190_sports_custom_sources.sql` owns sources, assignments, policy verdicts,
  and the unused ESPN preference. `0190` is applied; the next globally available migration was
  `0191` when this plan was written and must be rechecked at build start.
- `packages/sports/src/routes.ts` owns the complete Sports REST surface and creates a bounded,
  actor-scoped in-memory preview store. Source routes already occupy a coherent block that can move
  to a focused source router without changing paths.
- `packages/sports/src/source/discovery.ts` already normalizes HTTPS publisher identity, discovers
  feeds/static listings, and uses `fetchWebResource`; it currently adds the AI legal-policy verdict
  that this repair removes.
- `packages/module-registry/src/index.ts` supplies the binding Sports robots gate and structured-AI
  port. It is already over 2,500 lines, so new renderer/broker logic must live in Sports or
  web-research and only be wired there.
- `packages/web-research/src/reader.ts` validates public DNS/IP before each request and redirect, but
  does not know a discovery job's exact host set or aggregate request/byte budget.
- `packages/datasets/src/cache.ts` exports the bounded `DatasetCache`; `DatasetClient` is tied to
  static manifest hosts and cannot own arbitrary user domains.
- `SourceHeadline` assumes ESPN `sourceTeamIds`; `resolveHeadlineTeamKeys` overwrites `teamKeys`, and
  `SportsService.getOverview` calls ESPN `articleBody` for the selected feature without trusted
  source identity.
- Sports Today calls the same `/api/sports/overview` payload as the Sports page, so one correct
  composition seam covers both surfaces.
- The root `Dockerfile`, dev/prod Compose, and `.github/workflows/ci.yml` publish only the main Moss
  image. No runtime Chromium image or sandboxed renderer service exists.

## Architecture fixed before tasks

### API-owned fetch authority

The renderer never receives general network authority. For each browser discovery, the API creates a
20-second in-memory job containing:

- a random 128-bit, job-scoped capability bound to the long-lived API-to-renderer control request;
  the renderer includes it on every renderer-to-broker HTTP request, and the API revokes it when the
  control request disconnects, explicit cancellation occurs, or the deadline expires;
- submitted/final publisher hosts plus at most four API-validated first-party candidate hosts;
- permitted methods (`GET`/`HEAD`) and application-owned request headers;
- remaining request count, aggregate byte budget, per-response cap, concurrency, and deadline; and
- an abort controller shared by every safe fetch in the job.

The sidecar may request a URL; it cannot grant itself a host, header, redirect, method, or more
budget. The API broker checks every request and redirect against the live job before
`fetchWebResource`/`fetchWebResourceBytes`, decrements counters centrally, and cancels all work when
the job ends. Renderer-supplied cookies, authorization, referer, forwarding headers, and request
bodies are discarded.

Use Node's standard HTTP-over-UDS on two fixed sockets in the shared volume: the API calls the
renderer socket to start/cancel a job, and the renderer calls the API broker socket for each routed
resource. Requests and responses use fixed JSON/binary schemas, `Content-Length`/stream byte caps,
request ids, ordinary stream backpressure, and short timeouts. Oversized, duplicate, unknown, late,
or capability-mismatched requests close the job. The capability is sent only in that job's UDS
requests, never stored, logged, placed in environment variables, or reused as a service secret. Do
not build a custom framing or general RPC layer unless standard Node HTTP is proven insufficient.
Closing an ordinary renderer-to-broker request neither revokes nor extends the job capability.

### Renderer process boundary

Bundle Chromium and the renderer entrypoint in the multi-architecture Moss image. Run that same
image as a separate renderer service that:

- has `network_mode: none`, no secrets/env file, no host mounts, a read-only root, writable tmpfs
  only for the browser profile, a shared UDS volume, non-root user, all capabilities dropped,
  `no-new-privileges`, and explicit CPU/memory/pid limits;
- installs the Playwright 1.60 Chromium runtime matching the repo's current Playwright version;
- intercepts every context request and fulfills it only from broker responses over the UDS; and
- removes the profile and browser process after every job.

The main API probes the socket with a short timeout and never depends on renderer startup. Missing,
stale, or unhealthy renderer means static/feed preview still works and browser-only preview returns
`unsupported`. Dev and prod Compose must ship the same sandbox shape. CI publishes only the Moss
image; release promotion of that digest covers both application and renderer processes.

### Minimal state choices

- Reuse and extend `createSportsPreviewStore`; the supported deployment has one API process, so no
  preview table is added. The store remains actor-scoped, one-use, 10-minute TTL, and bounded. Add a
  table only if horizontal API processes become real.
- Reuse `DatasetCache` directly inside the Sports reader. Do not add user hosts to the module
  manifest or invent another cache framework.
- Use `tldts`, already present transitively, as an explicit Sports dependency for registrable-domain
  checks. Do not hand-roll public-suffix parsing.
- Export `parseFeedXml` and its bounded item type from `packages/news/src/source/rss-source.ts`
  through `packages/news/src/index.ts`, with its existing `tests/unit/news-rss-source.test.ts`
  coverage extended for the public contract. Sports uses that pure export and never reads News
  tables or imports News internals.

## Slice 1 — Safe broker, no-network renderer, and release path

### Production code

- Extend `packages/web-research/src/reader.ts` and its public types with optional exact-host,
  caller `AbortSignal`, fixed `GET`/`HEAD`, application-owned allowlisted headers, allowed response
  content types, returned byte count, and an after-DNS/before-hop policy hook. The hook runs before
  every initial/redirect request, so callers count and reject each hop. Combine caller cancellation
  with the existing timeout; defaults preserve existing callers. Reject an oversized declared
  `Content-Length` before reading. Cancel every redirect response body immediately before following
  `Location` and never forward it; on final responses, enforce both the declared length and streamed
  per-response limit and return the actual bytes read. The Sports broker supplies all restrictive
  options and counts those actual bytes against its aggregate budget.
- Add Sports-owned protocol and orchestration files under `packages/sports/src/source/`:
  - `browser-protocol.ts` — the fixed HTTP route/body schemas, limits, and request ids;
  - `browser-broker.ts` — API job authority, counters, safe-fetch calls, cancellation, and
    backpressure;
  - `browser-client.ts` — fail-soft API client for the sidecar socket; and
  - `browser-sidecar.ts` — the renderer entrypoint and Playwright request interception.
- Add direct `playwright-core` and `tldts` dependencies to `packages/sports/package.json`. Use the
  existing root Playwright version; add no browser automation framework.
- Bundle the renderer entrypoint and matching Playwright Chromium runtime in the root `Dockerfile`.
  Add a `sports-source-renderer` service and shared socket volume to `infra/docker-compose.yml` and
  `infra/docker-compose.prod.yml`, and the socket path only to the main app service. The renderer
  uses the Moss image and receives no app env file or database/network membership.
- Keep `.github/workflows/ci.yml` on one multi-architecture Moss image build and publication path.
  PR builds do not push the image.
- Keep `packages/module-registry/src/index.ts` to construction/wiring: create the Sports browser
  client and pass it into Sports routes. Do not place protocol or policy logic in the registry.
- The sidecar owns exactly one `page.goto`. It rejects popups/new pages, service workers,
  WebSocket/WebRTC, downloads, forms/navigation triggered after the initial page, and every
  side-effecting method. It aborts images, fonts, media, advertising, analytics, and unrelated
  third-party resources before broker submission. The broker independently enforces allowed
  response content types and per-response/aggregate byte caps.
- Discovery may retain evidence from at most five accepted candidate pages/application GETs, even
  when the 40-request browser budget includes more first-party script/style resources. The API owns
  both counters and ignores excess evidence.

### Checks

- Extend `tests/unit/web-research.test.ts` for an initial disallowed host, allowed-host redirect,
  redirect outside the exact host set, cancelled/unforwarded redirect bodies, oversized or
  misleading declared lengths on redirects and final responses, streamed final-response overflow,
  actual byte counts, `HEAD`, DNS rebinding, and abort propagation.
- Add `tests/unit/sports-browser-protocol.test.ts` for body/response size caps, malformed requests,
  backpressure, duplicate ids, bad capability, timeouts, and cleanup over HTTP/UDS.
- Add `tests/unit/sports-browser-broker.test.ts` proving the sidecar cannot expand host/method/header
  authority or exceed one top-level page, five retained candidate requests, 40 total requests,
  per-response/content-type limits, 10 MiB, four concurrent requests, 20 seconds, or cancellation.
- Add a FotMob-shaped local HTML/JavaScript fixture whose XHR is satisfied only by the mock API
  broker. Prove the renderer observes the team/league JSON requests while direct renderer egress is
  absent; popups, service workers, sockets/WebRTC, downloads, forms, images/fonts/media, analytics,
  excess evidence, and side-effecting methods are blocked.
- Add a Compose contract test that renders both dev and prod config and asserts `network_mode: none`,
  no env file/secrets/networks, read-only/tmpfs/user/cap/security/resource limits, and the shared UDS
  mount, including exact `cpus: 1.0`, `mem_limit: 512m`, and bounded pids. Extend
  `scripts/smoke-compose.ts` to probe the socket, prove an outbound connection from the renderer
  container fails, and prove a missing/stale renderer does not prevent ordinary API/static operation.
- Build the Chromium-bearing Moss image for both `linux/amd64` and `linux/arm64` in CI before
  publication.

### Kill gate

Stop and report #1909 blocked before Slice 2 if any of these fail:

1. the exact production image cannot run Chromium as non-root with `network_mode: none`;
2. intercepted page/XHR requests cannot complete solely through the bounded UDS broker;
3. the renderer can reach any IP directly or receive an app secret; or
4. the single Moss image cannot build for both published architectures.

Do not weaken the sandbox or let Playwright use direct networking as a workaround.

## Slice 2 — Recipe model, migration, and atomic preview/confirmation

### Persistence and contracts

- Add the next available Sports migration (currently
  `packages/sports/sql/0191_sports_public_source_runtime.sql`) and register it in
  `packages/sports/src/manifest.ts`.
- Extend `app.sports_custom_sources` with `recipe_json`, schema version/fingerprint/status,
  `confirmed_fetch_hosts`, and `authorization_confirmed_at`.
- Extend `app.sports_source_assignments` with target URL/parameters, preview status, target
  health/reason/message, and target check/success timestamps. Add strict URL/JSON/text/count checks;
  retain owner-only FORCE RLS and existing cascades.
- Add a worker-role SELECT policy and column-scoped grants for only export-safe source/assignment
  columns. Do not grant recipe JSON, confirmed host arrays, opaque parameters, preview data, or write
  access to `jarvis_worker_runtime`.
- Backfill `authorization_confirmed_at = validated_at`. Derive the exact confirmed hosts for legacy
  feed rows from their already-confirmed homepage/feed URLs and leave health pending. Mark legacy
  scrape rows and assignments `failing`/`recipe_missing` without manufacturing a check timestamp.
- Update `packages/db/src/types.ts` and `packages/shared/src/sports-sources-api.ts` with bounded source,
  assignment-target, preview, confirmation, retry, and rebuild DTOs/schemas. Recipe JSON and opaque
  parameters are server-only.

### Declarative discovery

- Add direct `ajv` and `css-select` dependencies to `packages/sports/package.json`; use AJV for the
  closed recipe JSON Schema and `css-select` over the existing htmlparser2 DOM for CSS extraction.
  Do not build schema or selector engines by hand.
- Add `packages/sports/src/source/recipe.ts` with one versioned discriminated union, AJV validation,
  canonical fingerprinting, declared path/query substitution, allowlisted headers, `css-select`
  HTML/simple-path JSON extraction, and the fixed normalization vocabulary. Unknown data fails
  closed; no eval, regex source, expressions, callbacks, or generated code.
- Refactor `packages/sports/src/source/discovery.ts` into the approved order: safe feed/static fetch,
  optional brokered browser evidence, sanitized/capped structured-AI recipe proposal, strict
  validation, safe replay, and scoped target samples. Remove `decideSourcePolicy` and make
  robots/terms informational only.
- Extend `packages/sports/src/source/preview-store.ts` with typed artifacts for new source,
  assignment replacement, and recipe rebuild. Bind source baseline, exact identity/hosts,
  recipe/fingerprint, targets/parameters, selected owned follows, samples, acknowledgement, and the
  actual source/target preview outcomes with their real check/success timestamps.
- Add `packages/sports/src/source/service.ts` as the one application service for REST, settings, and
  chat preview/confirm/rebuild. Before counting or applying any new-source or assignment
  confirmation, or applying any rebuild confirmation, acquire an owner-scoped transaction advisory
  lock using
  `pg_advisory_xact_lock(hashtext('sports:source-assignments:' || app.current_actor_user_id()))`, then
  recheck the artifact baseline and, where applicable, owner-visible follows and the 20-assignment
  cap in that same transaction. Stale, changed, expired, replayed, cross-owner, or identity/ack
  mismatches write nothing. Successful new-source, assignment, and rebuild confirmation persists the
  artifact's real preview health/timestamps atomically; it never resets a verified target to
  `pending`. An unassigned source retains its source-level preview health.
- Extract the current source route block from `packages/sports/src/routes.ts` into
  `packages/sports/src/source/routes.ts`. Preserve existing paths while making new-source
  preview/confirm and assignment preview/confirm use the shared service and artifacts.
- Add the matching new-source and assignment preview/confirm functions to
  `packages/sports/src/web/sports-client.ts`; Slice 5 owns only the later Retry and rebuild REST/client
  additions.
- Make the existing settings Add/assignment flow in `packages/sports/src/settings/sources.tsx` send
  selected follows during preview, show the exact publisher/host/target samples and authorization
  acknowledgement, and confirm with the opaque id plus the exact displayed identity and
  acknowledgement fields as tamper checks. Submitted hosts, targets, and recipe data are never
  authority. Keep zero-assignment save supported.
- Assignment preview diffs the requested set against persisted targets. It reuses unchanged verified
  targets and their health; a removals-only change performs no external fetch. Only added or changed
  targets enter discovery/replay, and confirmation atomically applies that exact diff.

### Checks

- Extend `tests/unit/sports-source-discovery.test.ts` with feed-first/browser-fallback ordering,
  prompt-injection evidence, host-set formation, strict recipe rejection, target resolution/pasted
  target replay, valid-empty extraction, and FotMob-shaped team/league JSON recipes.
- Add focused recipe tests for encoded path/query slots, unsafe/unknown fields, external article links
  as output-only, deterministic fingerprints, and exact expanded-request identity.
- Extend `tests/integration/sports-sources-repository.test.ts` for migration backfill, JSON/size checks,
  owner RLS, the total 20-assignment cap, atomic replace, and legacy feed/scrape states.
- Starting from 19 assignments, race two valid confirmation artifacts for the same owner; exactly one
  succeeds and the committed final count is 20.
- Race valid assignment and rebuild confirmation artifacts created from the same source baseline;
  exactly one commits, and the other returns stale after acquiring the owner lock.
- Extend `tests/unit/sports-routes.test.ts`, `tests/unit/settings-sports-pane.test.tsx`, and
  `tests/unit/web-sports-client.test.ts` for one-use actor-bound confirmation and the revised UI flow.
- Assert successful source/assignment/rebuild confirmation is immediately truthful (`healthy` with
  the actual preview check/success timestamps, including an unassigned source) without waiting for
  overview or Retry. Prove removals-only assignment replacement performs zero external requests and
  unchanged verified targets retain health.
- Prove rebuild preview makes no persistent change; confirm rejects cross-actor, expired, replayed,
  stale-baseline, identity-mismatched, and acknowledgement-mismatched artifacts.
- Prove missing/stale renderer discovery maps browser-only sources to `unsupported` while feed/static
  discovery remains usable; repeat this boundary in the final exact-image smoke.

## Slice 3 — Runtime reader, bounded cache, and truthful health

### Production code

- Add `packages/sports/src/source/public-source-reader.ts`. It loads the actor's enabled sources and
  active assignments once, fetches a shared feed once or each unique expanded recipe request once,
  parses/sanitizes bounded headlines, and returns headlines grouped by persisted competition/team
  scope plus per-target results.
- Use `fetchWebResource` with the persisted exact host set. Enforce 20 total assignments, 30 requests
  per overview, global concurrency four, per-domain concurrency two, response/item limits, and
  `429`/`Retry-After` backoff. Supply the same before-hop hook from Slice 1 so every redirect consumes
  the 30-request budget and shares the composition abort signal. Permit at most one `429` retry, and
  only when a valid bounded `Retry-After`, remaining deadline, and remaining request budget all allow
  it. Runtime never calls the browser client.
- Use `DatasetCache` with the Sports headline freshness/stale window. Key by recipe fingerprint plus
  canonical expanded HTTPS URL and allowlisted response-varying headers. Retry bypasses cache; cache
  hits do not update health timestamps.
- Extend `packages/sports/src/source/repository.ts` with one transactional target-result write and
  source aggregation method implementing the approved healthy/all-same/mixed rules. Store stable safe
  reason/message only. Every reader result carries the loaded recipe fingerprint and assignment
  identity (persisted row id plus canonical target URL/parameter identity); before updating, the
  transaction conditionally rechecks both against current rows and discards obsolete results. Source
  aggregation uses only results that passed those current-identity checks.
- Add Retry and runtime-health integration to the shared source service. Slice 2 already owns rebuild
  preview/confirm. `recipe_drift` means required structure is missing; a present empty collection is
  healthy. A failed target never cancels successful siblings.
- Wire one reader instance and cache at module construction in `packages/module-registry/src/index.ts`;
  do not instantiate caches per request.

### Checks

- Add `tests/unit/sports-public-source-reader.test.ts` for RSS/HTML/JSON, no article/pagination fetch,
  host/redirect denial, request/concurrency caps, rate-limit backoff, isolated target failure, valid
  empty, drift, cache hit/stale/bypass, and safe text/link sanitation.
- Prove every redirect consumes the composition request budget, cancellation aborts redirect/retry
  work, and a `429` receives zero or one retry according to `Retry-After`, deadline, and remaining
  budget.
- Explicitly prove equal display targets with different opaque parameters never share cache; equal
  expanded public requests do, while owner health remains separate.
- Extend repository integration coverage for every target/source health transition, unchanged last
  success on failure, newest aggregate timestamps, partial failure, all unsupported/auth required,
  disabled, and concurrent idempotent results.
- Race an in-flight fetch against both rebuild confirmation and assignment replacement; results from
  the obsolete recipe fingerprint or target identity are discarded and cannot overwrite current
  health.
- Extend route coverage for Retry returning the persisted DTO and never leaving a completed check
  pending.

## Slice 4 — Trusted-origin composition for Sports and Today

### Production code

- Precondition: `packages/sports/src/sports-service.ts` is already 974 lines. Before adding custom
  composition, move its pure headline helpers (`resolveHeadlineTeamKeys`, public shaping, URL merge,
  and feature-body eligibility) into `packages/sports/src/headline-composition.ts`, rename the
  resolver ESPN-specifically, and leave orchestration in `SportsService`. Prove existing Sports tests
  unchanged before adding new behavior; do not cross the 1,000-line gate.
- Extend `packages/sports/src/source/sports-source.ts` with an internal discriminated headline
  contract: ESPN carries `origin: "espn"` plus provider team ids; custom carries
  `origin: "custom"`, source id, persisted publisher identity, competition key, and
  assignment-derived team keys.
- Update `packages/sports/src/source/espn-source.ts` to emit the ESPN variant and persisted public
  attribution defaults (`ESPN`, `espn.com`). Keep `resolveHeadlineTeamKeys` ESPN-only; custom scope is
  never recomputed from article ids.
- Extend public `Headline` and its schema in `packages/shared/src/sports-api.ts` with
  `publisherLabel`/`publisherDomain`; keep internal origin/source id private. Update
  `toPublicHeadline` to sanitize URLs and preserve trusted attribution.
- Inject the public-source reader into `SportsService`. `getOverview` performs one actor-scoped custom
  refresh, merges results into the relevant competition buckets before existing ranking/dedup/card
  shaping, and marks overview degraded without discarding ESPN when custom refresh fails.
- Select the feature with internal origin still available. Call the ESPN `articleBody` dataset only
  when `origin === "espn"`; custom features use summary fallback. Do not pass custom ids into any
  ESPN dataset.
- Show publisher attribution with each custom story in the existing Sports page/Today story
  components. Add no parallel feed or new card system; custom stories without images use the existing
  image-optional path.

### Checks

- Extend `tests/unit/sports-service.test.ts`, `sports-service-dedupe.test.ts`, and
  `sports-service-story-identity.test.ts` for assignment scope, trusted attribution, mixed ESPN/custom
  URL dedup/ranking, isolated failure, and no ESPN body request for a selected custom feature.
- Extend `tests/unit/sports-page.test.tsx`, `sports-newsband.test.tsx`, and Today widget coverage for
  publisher labels, safe links, summary fallback, and image-optional custom stories.
- Add a highest-seam Sports route test proving one custom team target and one league target appear on
  `/api/sports/overview`; because Today consumes that same endpoint, no second composition path is
  added.

## Slice 5 — Complete settings, Moss, lifecycle, rollout, and live proof

### Settings and REST

- Finish `packages/sports/src/settings/sources.tsx` and existing Sports source styles with aggregate
  health, real last check/success, safe message, assignment target/status rows, “Awaiting first
  check/preview,” Retry, Rebuild, Remove, and auth-required guidance. `Checking…` exists only while a
  request is in flight. Reuse current JDS/settings primitives and tokens.
- Add REST endpoints/client functions/schemas only for Retry and rebuild preview/confirm. Slice 2
  already owns new-source and assignment preview/confirm routes/client functions/settings flow. REST
  and chat call the same source service; no duplicate validators or fetchers.

### Moss tools

- Expand `packages/sports/src/chat-tools.ts` and `packages/sports/src/manifest.ts` with source action
  family and the approved tools:
  - read: `sports.listSources`;
  - read-risk external content: `sports.previewSource`, `sports.previewSourceAssignments`, and
    `sports.rebuildSourceRecipe`;
  - confirmed write: `sports.confirmSource`, `sports.confirmSourceAssignments`,
    `sports.confirmSourceRecipe`, `sports.retrySource`, and `sports.removeSource`.
- Configure the same preview store/source service for routes and tools during module boot, following
  News' existing shared-store precedent. Mark preview outputs external content and keep recipes,
  opaque parameters, bodies, and raw evidence out of tool results.
- Summaries and confirmations identify the exact publisher, fetch-host set, and target mappings.
  Confirm handlers accept opaque ids plus exact displayed identity/ack fields only.

### Lifecycle and rollout

- Add `packages/sports/src/data-lifecycle.ts` with a `collectSportsSourcesExportSection` that selects
  only the migration's export-safe columns, and register `sportsSources` in
  `packages/sports/src/manifest.ts`. Thread that section explicitly through
  `packages/settings/src/data-export.ts` and serialize it in
  `packages/settings/src/data-export-jobs.ts`; manifest registration alone does not add it to the
  account export. Export public source/assignment/health metadata only. Leave inert
  `sports_policy_verdicts` in ownership/deletion and remove its runtime reads/writes.
- Replace `tests/uat/specs/1572-sports-custom-sources.uat.spec.ts` with
  `tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts` and update
  `.claude/skills/coordinate/uat-trigger-map.tsv` for every backend, settings, manifest, renderer,
  Compose, and Dockerfile path in this feature.
- The UAT follows the spec's live gate: settings and Moss new-source confirmation, FotMob team/league
  targets, two overlapping sources, Sports and Today attribution/dedup, target failure/retry,
  recipe-drift rebuild preview/confirm, legacy feed refresh, and legacy scrape rebuild. Use bounded
  textual/DOM/network assertions; do not attach screenshots.
- On the implementation PR, add the user-facing release note and record the UAT command, exit code,
  assertions, Moss image/tag, and renderer no-egress proof before merge.
- After deployment, inspect the two original production source rows through `sports.listSources` or
  settings only. Exercise Retry/Rebuild through the application; do not update rows with SQL.

### Checks

- Extend `tests/unit/sports-chat-tools.test.ts`, manifest/tool-contract coverage, and actor-scoped
  integration tests for list/preview/confirm/assignment/retry/rebuild/remove, including all artifact
  mismatch cases and ordinary cross-owner not-found behavior.
- Extend `tests/integration/data-export.test.ts`, archive export/job coverage, and lifecycle parity
  tests. Exercise both synchronous `exportUserData` and the asynchronous worker archive under
  `jarvis_worker_runtime`; prove safe Sports rows export and recipes, hosts, parameters, evidence,
  prompts, diagnostics, and write authority do not.
- Run focused unit/type/lint/format checks after each slice. Run DB integration and the final
  `pnpm verify:foundation` only through the repository's `verify-gate` skill so tests cannot touch the
  live dev database or hide a failing exit code.
- Run `pnpm check:file-size` and `pnpm check:design-tokens`; the source-router extraction prevents
  `routes.ts`/`module-registry` growth from becoming the implementation strategy.
- Finish with independent security and maintainability review, exact-image Compose smoke, and the
  live non-production UAT. CI green without that live artifact remains code-complete, unverified.

## Completion criteria

The plan is complete only when:

1. the renderer has no direct egress and every browser byte is authorized/accounted by the API job;
2. arbitrary public publishers can be previewed through feed/static/recipe paths without executable
   generated code or publisher-specific branches;
3. custom team/league headlines appear through the existing Sports/Today composition with trusted
   scope and attribution;
4. target/source health and all recovery actions are truthful and shared by settings and Moss;
5. the two legacy production rows have an application-only path to a truthful/recoverable state; and
6. the implementation PR carries exact-image, security, full-gate, and live-path evidence.
