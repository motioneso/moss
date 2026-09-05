# Sports custom-source photos: build plan

- Spec: `docs/superpowers/specs/2026-09-04-sports-custom-source-photos-design.md` (PR 2241, approved by Ben in chat 2026-09-04)
- Issue: #2237
- Worktree and PR: all slices share one worktree and one PR, opened as a draft at the start of slice 1.
- Audience note: status written for Ben is plain English, no jargon, ASCII punctuation. Pass this on to every agent spawned from this plan.

## What we are building, in one paragraph

Stories from a user's own sources (RSS feeds, subreddits, scraped pages) get a photo. The photo is found three ways in order: the feed's own media tag, a saved photo rule for the source, or the share image on the article page. Jarv1s downloads a copy, shrinks it, keeps it in the user's vault, and serves it from a same-origin route so no third-party host ever renders in the browser. Photos with real width lead the desk layout. When the deterministic path finds nothing, the user can ask Moss to "Find photos" once per source; Moss reads three story pages, names the photo element, the result is verified on real pages and previewed, and only the user's "Use these photos" click saves the rule. A quiet daily re-look repairs a rule that stops working.

## Seams check

Every capability the plan leans on, with where it lives today. All citations are against the PR 2241 branch at commit 61894bd36 (origin/main plus the spec).

| Capability                 | Where it exists                                                                                                                                                                                                                                                                                                                                                                         | What the plan does with it                                                                                                                                                                                                                                                                                                                                                              | Deviation from the spec                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Vault writes               | `packages/vault/src/vault-context.ts:15` `VaultContext { actorUserId, vaultRoot }`; `:17` `VaultContextRunner.withVaultContext(access, fn)`; `packages/vault/src/vault-ops.ts:67 readVaultFileBytes`, `:74 writeVaultFileBytes(ctx, relativePath, Buffer)`, `:88 listVaultFiles`, `:121 deleteVaultFile`, `:134 deleteVaultDir`, `:144 vaultFileExists`, `:181 listVaultFilesRecursive` | The photo store takes a `VaultContextRunner` in its constructor and never touches `fs`, exactly like `packages/chat/src/attachments-service.ts:179` and `:214`. The composition root already builds runners with `new VaultContextRunner(getVaultBaseDir())` at `packages/module-registry/src/index.ts:1861`, `:2215`, `:2296`; sports gets its own at the sports block (`:2072-2092`). | None. `packages/sports/package.json` does not yet depend on `@moss/vault`; slice 1 adds it.                                                                                                           |
| Safe fetch, text           | `packages/sports/src/source/discovery.ts:46` `SportsSafeFetchPort(url, { allowedHosts?, requestHeaders?, userAgent? })`; the reader holds it at `public-source-reader.ts:57`                                                                                                                                                                                                            | Article page fetch for share images reuses the reader's port (limits: `MAX_RESPONSE_BYTES` 1 MB, `FETCH_TIMEOUT_MS` 6 s, `REFRESH_DEADLINE_MS` 12 s at `:36-40`). Photo page fetches get their own smaller cap (first 40 KB is enough for `<head>`).                                                                                                                                    | None.                                                                                                                                                                                                 |
| Safe fetch, bytes          | `packages/sports/src/source/icon-route.ts:30` `SportsIconFetchPort`; wired as `fetchBytes` in `routes.ts:48`, `:99`, `:346-351`; built at `module-registry/src/index.ts:811` with `requireHttps: true`, size cap, host rate limiter                                                                                                                                                     | The photo downloader takes the same port type with `maxBytes: 2_000_000, timeoutMs: 5_000`. It is passed into the reader (not only the route), because downloads happen during refresh.                                                                                                                                                                                                 | None.                                                                                                                                                                                                 |
| Image allow list / CSP     | `packages/sports/src/source/espn-source.ts:22-28` `ESPN_IMAGE_HOSTS` -> manifest `imageHosts` (`manifest.ts:50`) -> `apps/api/src/static-web.ts:32-41` `IMG_SRC = ["'self'", "data:", ...]` -> nginx must match (`tests/unit/static-web-csp.test.ts`)                                                                                                                                   | Served photos are same-origin, so `'self'` already covers them. No allow-list or CSP change.                                                                                                                                                                                                                                                                                            | Confirms the spec's claim.                                                                                                                                                                            |
| Hero (lead) selection      | Web, not server: `packages/sports/src/web/sports-page.tsx:322-332` picks `candidates.find(h => h.imageUrl && h.summary) ?? candidates.find(h => h.imageUrl) ?? candidates[0]`; image at `:341-344`; ticker lead at `sports-ticker.tsx:311-312`. Server ranking is `headline-composition.ts:178 rankTopStories`; `toPublicHeadline` maps `imageUrl` at `:158`                            | The "photo width >= 800 leads" preference is implemented in `sports-page.tsx` using a new `imageWidth` field on the DTO.                                                                                                                                                                                                                                                                | **Deviation:** the spec says the desk layout's hero choice; that choice is in the web page, so the rule lands there, not in server composition. Server stays a ranker.                                |
| Story DTO                  | `packages/shared/src/sports-api.ts:59 Headline` with `imageUrl: string                                                                                                                                                                                                                                                                                                                  | null`at`:68`, `:140`; zod schemas at `:432-449`, `:541-546`, `:657-662`                                                                                                                                                                                                                                                                                                                 | Add `imageWidth: number                                                                                                                                                                               | null`and`imageHeight: number                                                             | null`next to`imageUrl`. `imageUrl` becomes the route path for custom-source stories; ESPN stays absolute.                                      | None.                                                                                                                                                                                                                 |
| Custom-source readers      | `public-source-reader.ts:42-45` `SportsPublicSourceHeadline = CustomSourceHeadline & { imageUrl: null; sportKey }`, forced null at `:276`; refresh at `:297`; results persisted at `:675 persistRuntimeResults`; reddit at `source/reddit.ts:163 redditOutboundLink`, `:173 redditEntryToHeadline`                                                                                      | Photo extraction hooks into the reader after items are parsed and before `persistRuntimeResults`; the null type widens to `string                                                                                                                                                                                                                                                       | null`.                                                                                                                                                                                                | None.                                                                                    |
| Sources repository and RLS | `source/repository.ts:237 list`, `:262 listRuntimeSources`, `:348 persistRuntimeResults(scopedDb, results)`, `:590 remove`, `:698 replaceRecipe`; table `packages/sports/sql/0190_sports_custom_sources.sql` with FORCE RLS owner-only at `:95-98`                                                                                                                                      | New columns join the same table, so the existing owner-only policies cover them. Miss streak updates ride in `persistRuntimeResults`.                                                                                                                                                                                                                                                   | None.                                                                                                                                                                                                 |
| Migration numbering        | Highest number across all `sql/` dirs is 0213                                                                                                                                                                                                                                                                                                                                           | New file `packages/sports/sql/0214_sports_source_photos.sql`. Re-check the highest number at build time; another in-flight PR may take 0214.                                                                                                                                                                                                                                            | None.                                                                                                                                                                                                 |
| Moss structured call       | Sports already uses the news package's public port: `source/service.ts:2` imports `NewsAiPort` from `@moss/news` (exported at `packages/news/src/index.ts:35`), defined at `packages/news/src/discovery/ports.ts:63` as `generateJson(scopedDb, { schema, prompt, maxOutputTokens? }) -> { ok: true, object }                                                                           | { ok: false, error: "needs_config"                                                                                                                                                                                                                                                                                                                                                      | "validation_failed"                                                                                                                                                                                   | "provider_error"                                                                         | "aborted" }`; used at `discovery.ts:393`; schema helper `source/recipe.ts:237-245 structuredOutputSchemaFrom`(no`pattern`, no `propertyNames`) | Find photos calls `ai.generateJson` once with `maxOutputTokens: 4000`. `needs_config` maps to "Finding photos needs a configured chat model."; any other failure maps to "Moss could not find photos on this source." | None. Reusing the news port type is an existing, declared cross-module import, so no new isolation exception. |
| Preview handles            | `source/preview-store.ts:45 createSportsPreviewStore({ ttlMs, maxPerOwner, now })`, TTL 10 min at `:51`, kinds at `:17-40`; confirm pattern at `service.ts:520-527` (`preview.kind !== "recipe-rebuild"                                                                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                         | preview.sourceId !== sourceId`)                                                                                                                                                                       | Add a fourth kind `photo-rule` to the union and follow the recipe-rebuild confirm shape. | None.                                                                                                                                          |
| Routes and manifest        | `routes.ts:331-511` for `/api/sports/sources...` (`:471 rebuild/preview`, `:490 rebuild`, `:511 DELETE`); manifest `manifest.ts:119 features`, `:147 settings` (`:176 sports.sources`), `:184 routes` (`:315 icon route`), tools `:410 sports.listSources`, `:476 rebuildSourceRecipe`, `:491 confirmSourceRecipe`, `:525 removeSource`                                                 | New routes declared in the manifest first (server refuses undeclared routes). Feature, settings copy and tools added per spec.                                                                                                                                                                                                                                                          | None.                                                                                                                                                                                                 |
| Image resize               | `sharp@0.34.5` is in `pnpm-lock.yaml:4611`, `:8298`, pulled transitively by `@huggingface/transformers@3.8.1` (`:5631-5636`). No package in the repo lists it directly.                                                                                                                                                                                                                 | Slice 1 adds `"sharp": "0.34.5"` as a direct dependency of `packages/sports/package.json`, pinned to the version already in the lockfile so no new download and the lockfile only gains an edge.                                                                                                                                                                                        | **Deviation:** the spec says it is "present via embeddings"; it is, but only transitively. Importing a transitive dependency is not allowed by pnpm's strict layout, so the direct entry is required. |
| Data export                | `packages/sports/src/data-lifecycle.ts:17 collectSportsSourcesExportSection`, columns at `:26-34`                                                                                                                                                                                                                                                                                       | Export gains `photoRuleState` and `photoRuleJson` (the rule is the user's data). Photo copies are not exported (they are cached, re-fetchable copies).                                                                                                                                                                                                                                  | None.                                                                                                                                                                                                 |
| Settings row               | `packages/sports/src/settings/sources.tsx:614 showRebuild`, buttons `:632-647`, `healthMessage` paragraph `:670-671`; badge `jds-badge jds-badge--steel` (`standings-leagues.tsx:88`)                                                                                                                                                                                                   | Status line and the Find photos / Not right / Use these photos controls live in the same row component. All UI via `jds-*` primitives (design-system skill).                                                                                                                                                                                                                            | None.                                                                                                                                                                                                 |
| Tests                      | Unit: `tests/unit/sports-source-icon-route.test.ts`, `sports-public-source-reader.test.ts`, `sports-reddit-source.test.ts`, `sports-routes.test.ts`, `sports-page.test.ts`, `settings-sports-sources.test.tsx`. E2e: `tests/e2e/sports-settings.spec.ts` with `tests/e2e/mock-sports-api.ts` against `playwright.config.ts` (vite on 127.0.0.1:4173, API fully mocked)                  | Each slice adds a Playwright spec on the mocked API plus a live-path run on dev. The mocked e2e proves the screen; only the live run proves the rule.                                                                                                                                                                                                                                   | None.                                                                                                                                                                                                 |

## Determinism boundary

- The model has exactly two jobs, both in slice 3, both the same call: (1) on a Find photos click, name the photo element on a story page as a rule; (2) on a quiet re-look, do the same for a stale rule. Nothing else calls a model.
- Every visible string comes from the record (`photo_rule_state`, `photo_last_outcome`, `photosFoundByMoss`), never from model text. The exact row wording is in the spec, section "Settings row states".
- Guidance in the prompt is under 150 words.
- Four guards on every model-authored rule: (a) shape validated against the rule schema; (b) the rule must resolve a photo on at least 2 of the 3 verification pages; (c) each resolved URL must pass the same https-only, size-capped download as the deterministic path; (d) the rule is saved only when the actor confirms the preview handle, which is bound to actor and source and expires after 10 minutes.
- Feed tags, saved rules and share images are extracted by code alone; the model never sees a feed.

## Shared design decisions

### Files

- `packages/sports/src/source/photo.ts` — pure extraction: `extractFeedPhoto(item)`, `extractShareImage(html, pageUrl)`, `applyPhotoRule(html, pageUrl, rule)`, `photoKey(sourceId, photoUrl)` (sha256, first 32 hex chars).
- `packages/sports/src/source/photo-store.ts` — `SportsPhotoStore` (vault copies, sidecars, sweep, caps, in-memory serve cache).
- `packages/sports/src/source/photo-route.ts` — `registerSportsHeadlinePhotoRoute`.
- `packages/sports/src/source/photo-rule.ts` — rule type, zod schema, `verifyPhotoRule`.
- `packages/sports/src/source/photo-discovery.ts` — Find photos flow and re-look.
- `packages/sports/sql/0214_sports_source_photos.sql` — columns.
- Web: `packages/sports/src/web/sports-page.tsx`, `packages/sports/src/settings/sources.tsx`.
- Shared: `packages/shared/src/sports-api.ts`, `packages/shared/src/sports-sources-api.ts`.

### Types and signatures

```ts
// photo.ts
export interface FoundPhoto { readonly url: string; readonly origin: "feed" | "rule" | "share" }
export function extractFeedPhoto(item: ParsedFeedItem): FoundPhoto | null   // media:content, media:thumbnail, enclosure image/*
export function extractShareImage(html: string, pageUrl: string): FoundPhoto | null  // og:image:secure_url, og:image, twitter:image, in that order, https only
export function photoKey(sourceId: string, photoUrl: string): string

// photo-store.ts
export interface StoredPhoto { readonly key: string; readonly width: number; readonly height: number; readonly bytes: number }
export interface SportsPhotoStoreDependencies {
  readonly vault: VaultContextRunner; readonly fetchBytes: SportsIconFetchPort; readonly now?: () => Date;
  readonly limits?: { maxCopiesPerOwner: 200; maxBytesPerOwner: 41_943_040; retentionMs: 14 days }
}
export class SportsPhotoStore {
  ensure(access: AccessContext, sourceId: string, photoUrl: string, opts: { signal?: AbortSignal }): Promise<StoredPhoto | null>  // fetch + resize + write, or return the existing copy
  read(access: AccessContext, key: string): Promise<{ bytes: Buffer; etag: string } | null>  // touches lastServedAt
  sweep(access: AccessContext, keepKeys: ReadonlySet<string>): Promise<{ removed: number }>
  removeSource(access: AccessContext, sourceId: string): Promise<void>
}
```

- Vault layout: `sports/photos/<key>.webp` and `sports/photos/<key>.json` (sidecar: `sourceId, publisherUrl, fetchedAt, lastServedAt, originalWidth, originalHeight, width, height, bytes`).
- Resize: `sharp(buffer).resize({ width: 1280, height: 720, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 })`; animated GIF flattened by `sharp(buffer, { animated: false })`.
- Refresh budget inside the reader: at most 6 article page fetches per source per refresh, at most 2 in flight per host, and none started once less than 3 s remain of the 12 s deadline. Downloads share the same budget.
- Headline `imageUrl` for a stored photo is `/api/sports/headlines/<headlineId>/photo`; the reader records `photoKey` on the persisted runtime result so the route can map headline -> key without a second table.

### Migration (slice 2)

```sql
-- packages/sports/sql/0214_sports_source_photos.sql
ALTER TABLE app.sports_custom_sources
  ADD COLUMN photo_rule_json jsonb,
  ADD COLUMN photo_rule_state text NOT NULL DEFAULT 'none'
    CHECK (photo_rule_state IN ('none', 'previewing', 'in_use', 'stale')),
  ADD COLUMN photo_miss_streak smallint NOT NULL DEFAULT 0,
  ADD COLUMN photo_last_outcome text,
  ADD COLUMN photo_relook_at timestamptz;
```

RLS: unchanged; the table's owner-only FORCE policies from 0190 apply to the new columns. No new table.

### API contract additions

```ts
// sports-api.ts Headline
imageWidth: number | null; imageHeight: number | null;
// GET /api/sports/headlines/:headlineId/photo -> image/webp, Cache-Control: private, max-age=604800, immutable; ETag; 304; 404 when missing

// sports-sources-api.ts
SportsCustomSourceDto.photoStatus: "working" | "none" | "previewing" | "stopped_working" | "pending"
SportsCustomSourceDto.photosFoundByMoss: boolean
POST /api/sports/sources/:id/photos/preview -> { status: "ready", handle, samples: { title, photoUrl }[] } | { status: "unavailable" } | { status: "not_found" }
POST /api/sports/sources/:id/photos { handle } -> SportsCustomSourceDto
DELETE /api/sports/sources/:id/photos -> SportsCustomSourceDto
```

Sample `photoUrl` values in the preview are served through a preview variant of the photo route bound to the handle (`/api/sports/sources/:id/photos/preview/:handle/:index`), so previews never render third-party hosts either.

### Manifest additions

```json
{
  "features": [
    {
      "id": "sports.source_photos",
      "summary": "Stories from your own sources show a photo when the feed, a saved rule, or the article's share image provides one.",
      "errors": [
        {
          "code": "sports.photos.needs_model",
          "message": "Finding photos needs a configured chat model.",
          "remediation": "Choose a chat model under Settings > Models."
        },
        {
          "code": "sports.photos.not_found",
          "message": "Moss could not find photos on this source.",
          "remediation": "Try again later, or leave the source without photos."
        }
      ]
    }
  ],
  "routes": [
    "/api/sports/headlines/:headlineId/photo",
    "/api/sports/sources/:sourceId/photos/preview",
    "/api/sports/sources/:sourceId/photos"
  ],
  "tools": [
    { "name": "sports.findSourcePhotos", "kind": "read" },
    { "name": "sports.useSourcePhotos", "kind": "write", "confirm": "always" }
  ]
}
```

The settings entry for `sports.sources` gains one sentence describing the photo status line. `sports.listSources` output gains `photoStatus`.

## Slices

Each slice fits one agent session. All three share one worktree and one PR. Every slice ends with: typecheck, lint, unit tests, the slice's Playwright spec run and observed, and a live-path note on the PR.

### Slice 1: deterministic photos, stored copies, served route, lead preference

No schema change. Ships value on its own: feed tags and share images already cover most RSS sources.

Work:

1. Add `@moss/vault` and `sharp` to `packages/sports/package.json`; run `pnpm install` (lockfile gains only edges).
2. `photo.ts` extraction; widen `SportsPublicSourceHeadline.imageUrl` to `string | null`; reddit headlines use the post's preview image when the post links to an image host, otherwise the share image of the outbound link.
3. `photo-store.ts` with vault writes, resize, sidecars, caps and retention sweep at the end of each source refresh; `removeSource` wired into `service.ts:607 removeSource`.
4. Photo route with owner RLS via `resolveAccessContext`, ETag, long cache header, 404, in-memory cache of 32 files / 16 MB.
5. Reader hook: budgeted article fetches for share images, downloads, `imageUrl` set to the route path, `imageWidth`/`imageHeight` on the DTO.
6. Web: lead choice prefers `imageWidth >= 800`; the ticker keeps its current rule.
7. Manifest: feature `sports.source_photos` (without the two Moss errors yet), the photo route.
8. Compose: `VaultContextRunner` for sports and `fetchBytes` passed to the reader at `module-registry/src/index.ts:2072-2092`.

Tests (behaviour, and why each would fail without the work):

- `sports-photo-extract.test.ts`: a feed item with `media:content` yields that URL; one with only an `enclosure` of type image yields it; a page with `og:image:secure_url` wins over `og:image`; an `http:` share image is rejected. Fails today because no extractor exists and the reader forces `imageUrl: null`.
- `sports-photo-store.test.ts` (fake vault runner in a temp dir, fake fetch returning a 2000x1200 PNG): the stored copy is 1280x720 WebP; a 640x360 source is not upscaled; the 201st copy for an owner evicts the oldest unserved copy; a copy unserved for 15 days is swept; a copy over 2 MB is refused. Fails without the store.
- `sports-photo-route.test.ts`: another owner's request for a key returns 404; a matching `If-None-Match` returns 304. Fails because the route does not exist.
- `sports-public-source-reader.test.ts` additions: a refresh with 20 items fetches at most 6 article pages; with 2.5 s left on the deadline no article fetch starts; a photo fetch that hangs does not push the refresh past 12 s. Fails because no budget exists.
- `sports-page.test.ts`: a story with `imageWidth: 1280` leads over an earlier story with `imageWidth: 300`. Fails because the page ignores width.
- Playwright `tests/e2e/sports-photos.spec.ts` (mocked API): the desk shows a custom-source story with an `<img>` whose `src` starts with `/api/sports/headlines/` and the wide-photo story is the lead. Fails because the mock DTO has no width and the page has no rule.

Live path on dev: add an RSS source with media tags (any major sports outlet feed) and one without (share image only); after refresh, both show photos, the image request goes to the same-origin route, and the vault folder holds `.webp` plus `.json` pairs. Screenshot cropped to the lead story, attached to the PR.

Verification (run each unpiped, then print the exit code):

```
pnpm --filter @moss/sports typecheck > /tmp/photos-tc.log 2>&1; echo "EXIT=$?"        # expect 0
pnpm --filter @moss/sports exec eslint src > /tmp/photos-lint.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm vitest run tests/unit/sports-photo-extract.test.ts tests/unit/sports-photo-store.test.ts tests/unit/sports-photo-route.test.ts tests/unit/sports-public-source-reader.test.ts tests/unit/sports-page.test.ts > /tmp/photos-unit.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm vitest run tests/unit/static-web-csp.test.ts > /tmp/photos-csp.log 2>&1; echo "EXIT=$?"   # expect 0 (no CSP change needed)
pnpm exec playwright test tests/e2e/sports-photos.spec.ts > /tmp/photos-e2e.log 2>&1; echo "EXIT=$?"   # expect 0
```

The full gate (`pnpm verify:foundation`) only through the verify-gate skill, once per slice.

### KILL GATE (owner: Ben), after slice 1

Ben decides after seeing the slice 1 live run on dev. Stop the build if any of these hold:

- Custom-source stories from a feed with media tags, or from a page with a share image, do not show a photo served from the vault route on dev.
- A source refresh with photos exceeds its 12 s deadline, or the desk feels slower to Ben than before.
- The photo route or vault copies leak across users in the unit tests (any cross-owner read that is not a 404).

If it passes, slices 2 and 3 continue in the same PR. If it fails, slice 1 is reverted or shipped alone at Ben's call; the schema and Moss work do not start.

### Slice 2: rule storage, status, settings row text

Work:

1. Migration 0214 (re-check the highest number first).
2. Repository: read the five new columns in `list`/`listRuntimeSources`; `persistRuntimeResults` updates `photo_miss_streak` (reset on hit, +1 on miss when a rule is in use) and flips `photo_rule_state` to `stale` at 3 with `photo_relook_at = now + 24h`; new `setPhotoRule`, `clearPhotoRule`, `recordPhotoOutcome`.
3. `photo-rule.ts`: rule shape `{ kind: "css", selector, attribute: "src" | "content" | "href", origin: "page" }` and `applyPhotoRule` in `photo.ts`; readers apply the saved rule between feed tag and share image.
4. DTO: `photoStatus`, `photosFoundByMoss`; the mapping from columns to status is one pure function `photoStatusFor(row)`, unit tested.
5. Settings row: status line with the spec's exact wording per state; `DELETE .../photos` route and the "Stop using" control; export section adds the two fields.
6. Manifest: the two Moss error entries are still deferred to slice 3; the settings copy updates now.

Tests:

- Migration test in `tests/unit/sports-migrations.test.ts` pattern: applying 0214 on a fresh schema succeeds and the check constraint rejects `photo_rule_state = 'bogus'`. Fails without the file.
- `sports-photo-status.test.ts`: `photoStatusFor` yields `working` for `in_use` with streak 0, `stopped_working` for `stale`, `pending` for `in_use` with streak 1-2, `previewing`, `none`. Fails because the function does not exist.
- Repository test (scoped db, verify-gate): three consecutive misses flip a source to `stale` and set `photo_relook_at`; a hit resets the streak; the owner cannot read another owner's rule. Fails because columns and updates do not exist.
- `settings-sports-sources.test.tsx`: each `photoStatus` renders the spec's exact sentence; "Stop using" calls the DELETE route and the row returns to `none`. Fails because the row has no status line.
- Playwright `sports-photos.spec.ts` extension (mocked API): a source with `photoStatus: "stopped_working"` shows "Photos: stopped working" and a source with `working` shows the working line. Fails because the DTO field is not rendered.

Live path on dev: run the migration on dev, confirm the sources screen shows the status line for every existing source ("Photos: none" or working), and export the sports section and see the two new fields.

Verification: same commands as slice 1 plus `pnpm vitest run tests/unit/sports-photo-status.test.ts tests/unit/settings-sports-sources.test.tsx` (expect 0) and the repository test only via the verify-gate skill.

### Slice 3: Find photos, preview, re-look, tools, live proof

Work:

1. `photo-discovery.ts`: fetch the 3 newest story pages (head plus first 40 KB each), one `ai.generateJson` call (schema through `structuredOutputSchemaFrom`, `maxOutputTokens: 4000`, guidance under 150 words), validate, `verifyPhotoRule` on the same 3 pages requiring 2 hits, store samples under a `photo-rule` preview kind with a 10 minute TTL.
2. Routes `POST .../photos/preview` and `POST .../photos` (confirm), following `service.ts:520-527` handle checks; `needs_config` -> `unavailable`; anything else -> `not_found` and `photo_last_outcome` recorded.
3. Re-look: at the end of a refresh for a `stale` source whose `photo_relook_at` has passed, run the same discovery without a preview; on success replace the rule and reset the streak, on failure push `photo_relook_at` 24 h and keep `stale`. At most once per day per source.
4. Tools `sports.findSourcePhotos` (read, returns samples and a handle) and `sports.useSourcePhotos` (write, confirm always); `sports.listSources` gains `photoStatus`.
5. Settings row: "Find photos" button, previewing state with up to 3 sample thumbnails, "Use these photos" and "Not right"; the two error sentences from the record.
6. Manifest: error and remediation entries; tool declarations.

Tests:

- `sports-photo-discovery.test.ts` with a fake AI port: a rule that hits 3 of 3 pages is offered; one that hits 1 of 3 is refused with `not_found`; `needs_config` from the port yields `unavailable`; a model answer with an extra field is rejected by the schema; a rule that resolves an `http:` image is refused. Fails because the flow does not exist.
- Preview store test: a `photo-rule` handle from user A cannot be confirmed by user B or against another source; an expired handle returns the spec's expiry error. Fails because the kind does not exist.
- Re-look test: a stale source with `photo_relook_at` in the past is re-looked once during refresh and not again within 24 h; a successful re-look replaces the rule with no preview. Fails without the hook.
- `sports-chat-tools.test.ts`: `useSourcePhotos` is declared confirm-always; `listSources` returns `photoStatus`. Fails without the declarations.
- Playwright `sports-photos.spec.ts` extension (mocked API): click "Find photos", see three samples, click "Use these photos", row shows "Photos: found by Moss"; a mocked `unavailable` shows the configured-model sentence. Fails because the buttons do not exist.

Live path on dev (this is the feature's live-path gate): on a scraped source with no feed tags and no share image, click "Find photos" with the dev chat model configured, observe the preview, accept it, refresh, and see photos on the desk. Then unset the chat model and confirm the "needs a configured chat model" sentence. Record both on the PR with cropped screenshots. Then mark the PR ready and arm auto-merge (`gh pr merge --squash --auto`, never `--admin`).

Verification: same commands as slice 1 plus `pnpm vitest run tests/unit/sports-photo-discovery.test.ts tests/unit/sports-chat-tools.test.ts` (expect 0).

## Release note (for the PR template)

Category: Added. Title: Photos for your own sports sources. Description: Stories from the feeds and sites you add now show a photo, and you can ask Moss to find photos on a site that does not provide them.

## Rulings ledger

- 2026-09-04, Ben: spec approved in chat.
- Hero preference lives in the web page (seams check), not server composition.
- `sharp` becomes a direct, pinned dependency of the sports package (seams check).
- Previews are served through the same-origin route, never as third-party image URLs (follows from the no-third-party-host rule in the spec).

## Open questions for Ben

1. Adding `sharp` as a direct dependency is a native binary already in the lockfile through the embeddings library. Accept it as a pinned direct dependency of the sports package? (Plan assumes yes.)
2. The lead-story preference for wide photos will be in the web page, where the lead is chosen today. Fine, or do you want the server to decide?
3. Should the re-look also run for sources whose photos never worked (state `none`), or only for rules that broke? (Plan assumes only broken rules, per the spec.)
