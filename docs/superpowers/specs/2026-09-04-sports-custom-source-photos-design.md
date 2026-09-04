# Sports: photos for stories from custom sources

**Status:** Proposed design

**Date:** 2026-09-04

**Owner:** Ben

**Task issue:** [#2237](https://github.com/motioneso/moss/issues/2237)

**Related:** `packages/sports`, the approved Sports subreddit source design dated 2026-09-03,
the News sources spec dated 2026-09-04 (its model-assisted feed finder is the pattern this
spec mirrors), and the source icon work shipped in PR 2211.

**Origin:** Ben's note on the Sports hero carousel, 2026-09-04: "We need to be able to pull in
photos from custom sources. You can have Moss inspect the source and make modifications locally
if possible."

## Context

A Sports story gets a photo in exactly one place today: the ESPN reader picks the header image
out of ESPN's article payload. Every other reader hands back a story with no photo. The generic
reader for feeds and scraped pages sets the photo to null on every story, and the subreddit
reader keeps only the community icon. So a story from a source Ben added himself never has a
photo, whatever its publisher put in the feed.

That gap is visible in three places. The hero carousel on the Sports page shows a blank warm
block instead of a picture for such a story. The ranking that picks the lead story gives a
story with a photo two extra points, so custom-source stories lose the top slot to ESPN stories
of equal interest. And the story list below the hero only shows a thumbnail when a photo
exists, so a whole source can read as text-only next to ESPN.

Most publishers do put a photo somewhere reachable. RSS feeds commonly carry a media tag or an
enclosure. Almost every article page names its share image in an og:image or twitter:image
tag. A subreddit post links out to an article page that has one. None of that needs a model.

A minority of sources do not fit those rules: the feed has no media tag, the page has no share
image, or the share image is a site logo rather than the story photo. For those, Sports already
has the shape of an answer. Scraped sources are read through a per-source recipe that the
configured model proposed and the server verified before the user accepted it. A photo recipe
can be built, verified, and accepted the same way.

The browser only loads images from a fixed set of hosts, so a publisher's photo cannot be
shown by URL directly. Sports already solves this for source icons with a server-side proxy
that fetches the image, checks its bytes, and caches it. Photos need the same treatment.

## Goals

- A story from a feed, scraped, or subreddit source shows the publisher's photo wherever an
  ESPN story would: the hero carousel, the news band on Today, and the story list thumbnail.
- The first pass is deterministic and needs no model: feed media tags, then the article page's
  share image, with size and type checks, all done on the server.
- When the deterministic pass finds nothing usable for a source, the owner can ask Moss to
  inspect the source and propose a per-source photo recipe. The proposal is verified on the
  server, shown as a preview with real sample photos, and only saved when the owner accepts it.
- Moss keeps its own resized copy of each story photo on the box, in the owner's vault, and
  serves that copy. The browser never loads from the publisher, and the publisher is fetched
  once per photo, not once per page view. Ben's ruling, 2026-09-04.
- The owner can see per source, in Sports settings, whether photos are working and what to do
  when they are not.
- Moss can explain all of this and run the propose, preview, and accept steps from chat.

## Non-Goals

- No change to how ESPN stories get their photos.
- No original-size copies. Moss stores one resized copy per photo and nothing else; if a larger
  rendition is ever wanted it is fetched and resized again.
- No photo bytes in the database. The database holds the path key and metadata only.
- No cropping or editing. The stored copy is scaled down to fit, never cropped; the hero crops
  with object-fit at display time as it does today.
- No photo for a story whose source has no verified way to get one. The blank warm block stays
  as the fallback; it is the existing designed empty state.
- No model-driven changes to how a source's headlines are read. A photo recipe only adds a
  photo to stories the existing reader already found.
- No automatic application of a model proposal. Every recipe is accepted by the owner.
- No News module changes. News keeps its own article-image route. If a shared image proxy is
  wanted later it is its own spec.

## Resolved Decisions

### 1. Where the photo comes from, in order

For each story from a custom source, the server tries these in order and stops at the first
candidate that passes the checks in decision 3.

1. **Feed media tags**, for feed sources only. In order: `media:content` with a medium of image
   or an image content type, then `media:thumbnail`, then an `enclosure` with an image type.
   When a tag repeats, the largest declared width wins; without widths, the first wins.
2. **The saved photo recipe**, when the source has one in the accepted state. See decision 5.
3. **The article page's share image.** Fetch the story's own URL and read, in order, the
   `og:image:secure_url`, `og:image`, and `twitter:image` meta tags. This applies to feed
   sources whose feed had no media tag, to scraped sources, and to subreddit sources, where the
   story URL is already the outbound article link and never a Reddit address.

An accepted recipe sits above the share image on purpose: the owner accepted it precisely
because the share image was wrong or missing for that source. A feed media tag still wins over
a recipe, because the publisher declared it for exactly this use.

### 2. Fetch budget

Photo lookups piggyback on the existing refresh of a source. They never delay headlines.

- Feed media tags cost nothing extra; they are read from the feed body already fetched.
- Article page fetches are capped at 6 per source per refresh and 2 in flight per publisher
  host, reusing the reader's existing per-domain limit. Only the stories that would be shown
  are fetched: the ones the reader keeps after its own item limit, newest first.
- Each page fetch has a 1 MB body cap and a 6 second timeout, matching the reader.
- The result per story, hit or miss, is cached with the headline for the headline cache's
  lifetime, so a story is not re-fetched on every overview request.
- If the refresh deadline is close, remaining lookups are skipped and those stories go out
  without a photo. The next refresh tries again.

### 3. What counts as a usable photo

A candidate URL must pass all of these on the server before it is attached to a story:

- HTTPS, no credentials in the URL, a public host, no more than 2048 characters.
- The host is the publisher's own host, a subdomain of it, or one of a short built-in list of
  common image hosts used by publishers. The list ships with the module and is extended by
  ordinary code review, not by the model. It is an allowlist for the proxy in decision 4 as
  well.
- The candidate is not a known non-photo: paths that end in `favicon.ico`, contain `logo`,
  `default`, `placeholder`, or `sprite`, or are 1x1 tracking pixels by declared size. The
  bytes check below catches the rest.
- When a declared width or height exists, at least 300 pixels on the short side. Undeclared
  sizes are allowed through to the bytes check.

The bytes check happens when the proxy first fetches the image: it must start with JPEG, PNG,
WebP, or GIF magic bytes, be at most 2 MB, and decode to at least 300 by 200 pixels from its
header alone. A failed bytes check is cached as a miss so the browser is not sent back to the
same broken image, and the story is shown without a photo.

### 4. Storing and serving the photo

Moss keeps a resized copy of every story photo it shows and serves that copy. It never hotlinks
the publisher and never serves the publisher's bytes straight through. Ben ruled this on
2026-09-04.

**The stored copy.** When a candidate passes the checks in decision 3, the server downloads it
once through the safe-fetch layer with a 2 MB cap and a 5 second timeout, checks the bytes, and
writes one rendition:

- scaled down to fit inside 1280 by 720 pixels, never scaled up, aspect ratio kept, no crop
- encoded as WebP at quality 80, which keeps a typical hero photo under 150 KB
- animated GIFs are flattened to their first frame
- the resize is done with the `sharp` library, added as a direct dependency of the sports
  package; it is already present in the lockfile as a dependency of the embeddings library, so
  no new native build is introduced

**Where it lives.** Copies go in the owner's vault through `VaultContext`, the same way chat
attachments do, never through raw file access:

```
<vault root for the owner>/sports/photos/<photo key>.webp
<vault root for the owner>/sports/photos/<photo key>.json
```

The photo key is a hash of the source id and the publisher's photo URL, so two stories sharing
one photo share one copy and a photo URL from another owner's source never collides. The
sidecar JSON records the source id, the publisher URL, the fetched-at time, the last-served
time, the stored width and height, and the byte size. Files are written with the vault's
owner-only permissions, so a copy is readable by its owner's requests only. There is no
existing media store in the codebase to reuse; the chat attachments layout is the precedent.

**Retention and eviction.** A copy is kept while its story is still in the owner's headline
cache and for 14 days after it was last served, whichever is longer. A sweep runs at the end of
each source refresh for that owner and removes copies past their retention. Each owner's photo
folder is also capped at 200 copies or 40 MB; when either cap is hit the sweep removes the
least recently served first. Removing a source removes its copies in the same request. Deleting
the owner's account removes the vault root, which takes the photos with it, exactly as it does
for attachments.

**Serving.** A new route, `GET /api/sports/headlines/:headlineId/photo`, resolves the story in
the owner's headline cache under RLS, opens the copy through `VaultContext` for that owner,
touches its last-served time, and returns it with a long browser cache header and a content
hash as the entity tag. A story whose copy is missing is served a 404 and queued for re-fetch
on the next refresh. The story DTO's photo field becomes that route's path. ESPN stories keep
their direct CDN URLs, which the browser is already allowed to load; they are outside this
spec.

A small in-memory cache in front of the route holds the last 32 served files or 16 MB so a busy
Sports page does not reread the disk for every visitor of the same owner. That cache is a
convenience only; the vault copy is the record.

The publisher's server sees one fetch per photo from Moss for as long as the copy is kept,
never one per page view, and never a request with the user's cookies or identity.

### 5. The photo recipe

A photo recipe is a small, verified instruction for finding the photo on one source's article
pages. It lives on the source row and belongs to its owner.

```
{
  version: 1,
  kind: "html",
  fetchHosts: ["<publisher host>", ...],
  photo: { selector: "<css selector>", source: "attribute", attribute: "src" | "content" | "data-src" | "href" },
  fallback: "share_image" | "none"
}
```

The selector must be plain CSS with no pseudo-elements and at most 120 characters. The
attribute is one of the four named. The fetch hosts must be within the source's existing host
allowlist. A recipe that fails these shape checks is rejected before it is ever run.

A recipe has a status stored beside it: `none`, `proposed`, `accepted`, or `drift`. Drift means
the accepted recipe found no photo on three consecutive refreshes where stories were present.
Drift does not remove the recipe; it puts the source back into the state where the settings row
offers to find another.

### 6. When and how Moss proposes a recipe

Moss never runs the model during an ordinary refresh. A proposal happens only when the owner
presses Find photos on a source row, or asks Moss to do so in chat, which calls the same tool.

Find photos is offered on a source row when the source is healthy and its photo status is
`none` or `drift`, meaning the last refresh had stories but the deterministic pass attached a
photo to none of them.

The steps are:

1. The server fetches up to three of the source's newest story pages through the safe-fetch
   layer, strips scripts and styles, and keeps the head plus the first 40 KB of body for each.
2. It sends the configured model, through the AI router's structured output seam that the
   existing recipe builder already uses, the source's host, those bounded page excerpts, and
   the instruction to name the element that holds the story's lead photo. The schema is the
   recipe shape above. The prompt carries no other sources, no preferences, no credentials,
   and nothing about the user.
3. The server validates the shape, then runs the recipe against the same three pages. It must
   find a candidate on at least two of three, and each candidate must pass decision 3 including
   the bytes check.
4. The verified result becomes a preview: the proposed recipe, the three story titles, and the
   photos it found, served through the proxy. The preview is bound to an actor-scoped handle
   exactly like the existing recipe rebuild preview, so what the owner accepts is what the
   server verified.
5. The owner accepts or dismisses. Accept writes the recipe and sets its status to accepted.
   Dismiss writes nothing. A preview expires after ten minutes.

If no model is configured the button still shows, and pressing it renders the existing
prerequisite gate with the text "Finding photos needs a configured chat model." and its
Assistant settings link. If the model returns nothing usable, the row says "Moss could not find
a reliable photo on this source." and the button stays available.

The model budget per attempt is one structured call with at most 4000 output tokens, plus the
bounded page fetches above. There is no tool use in this call; the pages are fetched by the
server beforehand and handed over as text.

### 7. Photo status per source

Each source row in Sports settings shows a photo status next to its health badge, and Moss can
read it through the sources tool. The states and their exact wording:

| Status     | Row wording                        | Shown when                                              |
| ---------- | ---------------------------------- | ------------------------------------------------------- |
| working    | Photos: working                    | Last refresh attached a photo to at least one story.    |
| none       | Photos: none found                 | Last refresh had stories and none got a photo.          |
| proposed   | Photos: preview ready              | A verified proposal is waiting for accept or dismiss.   |
| accepted   | Photos: using Moss's recipe        | An accepted recipe attached at least one photo.         |
| drift      | Photos: recipe stopped working     | Accepted recipe, three refreshes with stories, no photo. |
| pending    | Photos: checking                   | No refresh with stories has completed yet.              |

The two model-related strings are:

1. "Finding photos needs a configured chat model." through the existing prerequisite gate.
2. "Moss could not find a reliable photo on this source."

### 8. Attribution and the stored copy

The photo is the publisher's. Moss already shows the publisher label and links every story to
its article, which is the attribution the share-image convention expects; publishers put the
image in og:image so that link previews show it. Moss fetches each photo once with a plain user
agent and keeps a reduced private copy for the owner's own reading, the same footing as a
browser cache or a feed reader's thumbnail. The copy is never cropped, never shown outside the
owner's account, never exported, and is removed on the schedule in decision 4.

A photo recipe can only point at the publisher's own pages and hosts, so Moss never pulls
photos from a third-party site the owner did not add.

## Open Questions for Ben

1. **Should photo lookups run for a source before it has any accepted coverage assignments?**
   The safe default in this spec is yes, because the deterministic pass costs at most six page
   fetches per refresh. Say no if you would rather add a source with no extra fetching until it
   is assigned to a team or sport.
2. **Is a 300 pixel short side the right floor?** Below that the hero slot shows visible
   blur. Some smaller regional publishers only offer 240 pixel thumbnails in their feeds, and
   this rule would drop them to the blank block. Lowering the floor to 240 keeps those photos
   at some cost in sharpness.
3. **When an accepted recipe drifts, should Moss re-propose automatically on the next Find
   photos press, or first offer Retry with the old recipe?** The spec offers Find photos only;
   the old recipe stays saved until a new one is accepted.

## Architecture

### Reader changes

The generic reader for feeds and scraped pages, and the subreddit reader, gain a photo step
after item extraction and before caching. A new `source/photo.ts` owns the deterministic pass:
feed tag parsing, share-image parsing, candidate checks, and the per-refresh fetch budget. The
reader passes it the fetched feed body and the kept items; it returns the same items with a
photo URL or null. The story type's photo field changes from always-null to nullable string.

The ESPN reader is untouched.

### Photo store and route

`source/photo-store.ts` owns the vault copy: download through the safe-fetch port, bytes check,
resize with `sharp` to the rendition in decision 4, write of the WebP and its sidecar through
`VaultContext`, the retention sweep, and per-source removal. It takes a `VaultContextRunner`
exactly as the chat attachments service does and never touches the filesystem outside it.

`source/photo-route.ts` mirrors `source/icon-route.ts` for its dependency shape and access
resolution: it resolves the headline id against the owner's cached headlines through the data
context, so an id from another user resolves to nothing, then reads the copy from the store.

Composition in the sports module wiring registers the route and passes the same safe-fetch port
the icon route uses, with the module's built-in image host list plus the source's own host
allowlist, and the vault runner already available to the composition root.

### Recipe proposal and verification

`source/photo-recipe.ts` owns the recipe shape, its validator, the structured-output schema
built with the same helper the headline recipe uses, and the verify step that runs a recipe over
fetched pages. `source/photo-discovery.ts` runs the proposal flow from decision 6 using the
same AI port the existing recipe builder gets from the composition root. Proposals reuse the
existing preview handle store so accept is bound to the actor and to the verified payload.

### Storage and repository

One new Sports-owned migration, next number in `packages/sports/sql/`, adds to
`app.sports_custom_sources`:

- `photo_recipe_json jsonb` with a check that it is null or an object.
- `photo_recipe_status text` defaulting to `none`, checked against the four stored states
  `none`, `proposed`, `accepted`, and `drift`. The `pending` and `working` statuses in the DTO
  are derived from this column and the last refresh outcome, not stored here.
- `photo_miss_streak smallint` defaulting to 0, the drift counter.
- `photo_last_status text` recording the last refresh outcome, `working` or `none`, so the
  settings row can show status without a refresh.

RLS classification: **owner-only**. The columns sit on rows already under FORCE RLS with the
owner policy from migration 0190, so no new policy is needed. The repository gains read and
write methods for the four columns and a method that bumps or resets the miss streak inside the
refresh transaction. Recipes are not export data and are excluded from user exports, matching
how the icon URL was handled.

### Compilation and ranking

No ranking change. The existing two-point bonus for a photo now reaches custom-source stories
because they carry one. The hero, news band, and thumbnail markup already branch on the photo
field and need no change beyond accepting the proxy path.

### API contracts

Additions to `packages/shared/src/sports-sources-api.ts`:

- `SportsCustomSourceDto` gains `photoStatus` with the six values from decision 7.
- `POST /api/sports/sources/:id/photos/preview` runs the proposal flow and returns
  `{ status: "ready", handle, recipe, samples: [{ title, photoUrl }] }` or
  `{ status: "unavailable" }` for no model or `{ status: "not_found" }` for no reliable recipe.
- `POST /api/sports/sources/:id/photos` with `{ handle }` accepts the previewed recipe and
  returns the updated source DTO.
- `DELETE /api/sports/sources/:id/photos` removes an accepted recipe and resets status to
  `none`.
- `GET /api/sports/headlines/:headlineId/photo` returns the owner's stored WebP copy or 404.

All four are declared in the manifest's routes with the `sports.sources` permission for the
three recipe routes and `sports.view` for the photo route. The story DTO's `imageUrl` field is
unchanged in name; its value for custom sources is now the proxy path.

### Moss: app map and tools

Manifest `features` gains `sports.source_photos`: "Stories from a custom source show the
publisher's photo in the hero and story list when the feed or article page provides one. When a
source has no usable photo, Find photos on its row in Sports settings asks Moss to inspect the
source and propose a way to get one, which the owner previews and accepts." Its `errors` list
the two strings from decision 7 with the remediation "Configure a chat model in Assistant
settings" for the first and "Try Find photos again after the source publishes new stories, or
leave the source without photos" for the second.

The existing `sports.sources` settings entry's description is extended with the photo status
and Find photos action.

Tools added, mirroring the recipe rebuild pair:

- `sports.findSourcePhotos` (read, external content): runs the preview and returns the recipe
  summary and sample titles.
- `sports.confirmSourcePhotos` (write, confirm always): accepts the exact handle from the
  preview.
- `sports.listSources` output gains `photoStatus` so Moss can answer "why does this source
  have no pictures".

## Screens

### Source row in Sports settings

Mockup: `docs/superpowers/specs/mockups/sports-source-photos.html`, built from the existing
badge, button, and eyebrow primitives and the layout classes already in the sources pane. The
only new layout classes are the preview block's own, added to the pane's stylesheet. The three states below are the row as it stands, the row with a preview open, and
the row after accepting.

```
+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: none found                     |
|                                        [Find photos] [Edit coverage] [Remove]   |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: preview ready                  |
|                                                    [Edit coverage] [Remove]     |
|  PHOTO PREVIEW                                                                  |
|  Moss found the lead photo in the article header on 3 of 3 recent stories.      |
|  +----------+  +----------+  +----------+                                       |
|  |  photo   |  |  photo   |  |  photo   |                                       |
|  +----------+  +----------+  +----------+                                       |
|  Title one     Title two     Title three                                        |
|                                              [Use these photos] [Dismiss]       |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: using Moss's recipe            |
|                                        [Stop using]  [Edit coverage] [Remove]   |
+--------------------------------------------------------------------------------+
```

States the row must also render:

- **Loading** after Find photos: the button reads "Looking…" and is disabled, the other
  actions stay enabled, matching the existing Rebuild button's "Checking…" behavior.
- **No model:** the preview block is replaced by the existing prerequisite gate with the
  Assistant settings link.
- **Not found:** the preview block shows the second string from decision 7 in the existing
  hint style, and Find photos is enabled again.
- **Drift:** the status reads "Photos: recipe stopped working" and Find photos returns.

### Sports page

No new screen. The hero carousel, Today news band, and story list already render a photo when
the story has one. The empty warm block remains the empty state.

## Testing

- Unit tests for the feed tag parser (media content with widths, thumbnail, enclosure, missing,
  malformed), the share-image parser (secure_url precedence, relative URLs resolved against the
  page, missing), and every candidate rule in decision 3.
- Unit tests for the image header reader across the four formats plus a truncated body.
- Reader tests proving the fetch budget: 6 page fetches per source, 2 per host in flight, no
  fetch when the deadline is near, and headline output unaffected by a failed photo fetch.
- Store tests with a temporary vault root: a 2000 by 1500 JPEG lands as a 1280 by 960 WebP,
  a 640 by 480 PNG is not scaled up, an animated GIF is flattened, an oversized body is
  recorded as a miss with no file written, two stories with one photo URL share one file, the
  sweep removes copies past 14 days and trims to the caps by last-served time, and removing a
  source removes its copies.
- Route tests: another user's headline id is a 404, a missing copy is a 404, and a hit returns
  the browser cache header and entity tag.
- Recipe tests: shape validation rejects long selectors, pseudo-elements, unlisted attributes,
  and hosts outside the allowlist; verify requires two of three; the model's raw object is never
  written to the row; accept with a stale or foreign handle fails.
- Drift: three refreshes with stories and no photo flip status to drift; one hit resets.
- Settings pane tests for the six row states and the preview block's accept and dismiss.
- Live-path proof on dev: add a feed source with media tags and see its photo lead the hero;
  add a source whose feed lacks tags and see the share image used; press Find photos on a source
  with neither and accept the preview; record request logs and bounded DOM facts on the PR.

## Exit Criteria

- A story from a feed source with a media tag, a scraped source with an og:image, and a
  subreddit post linking to an article page all show the publisher's photo in the hero, the
  Today news band, and the story list thumbnail on a live dev instance.
- No custom-source photo is ever loaded in the browser from the publisher; every one is served
  from the owner's vault copy, which is at most 1280 by 720 WebP.
- The vault copy is readable only through the owner's requests, is removed with its source,
  and the per-owner folder never exceeds the retention rule and caps in decision 4.
- A refresh with every photo fetch failing still delivers headlines within the existing
  deadline.
- Find photos on a source with no usable photo produces a server-verified preview with real
  sample photos, writes nothing until Use these photos is pressed, and afterwards the source's
  stories carry photos on the next refresh.
- With no chat model configured, the deterministic pass still works and Find photos shows the
  prerequisite gate.
- Sports settings shows the six photo statuses with the exact wording in decision 7, and the
  manifest's features, errors, remediations, routes, tools, and migration declarations match.
- Moss answers "why does this source have no pictures" from the listed status and can run the
  find and confirm tools from chat with the confirm step gated.

## Hard Invariants honored

- **Private by default.** Recipes, statuses, and counters live on owner-only rows under FORCE
  RLS. The photo route resolves headline ids inside the owner's data context, and the stored
  copies live in that owner's vault with owner-only permissions.
- **Vault I/O goes through VaultContext.** The photo store takes the vault runner and never
  uses raw file access.
- **Secrets never escape.** The proposal prompt carries a host and public page text only. No
  credentials, preferences, other sources, or user identity. Logs record hosts and reason codes,
  not page bodies.
- **Metadata-only job payloads.** Nothing new is queued; lookups run inside the existing refresh.
- **Provider-agnostic AI.** The proposal uses the router's structured output seam with a schema;
  no provider or model is named anywhere in Sports.
- **Module isolation.** Sports adds its own proxy route rather than importing News internals.
- **Never edit an applied migration.** One new Sports migration adds the columns.
- **No new required settings.** Nothing here needs an environment variable or a hand-edited
  file; the only prerequisite is the chat model, which already has an in-app setting and a gate.
- **App map truthfulness.** The feature, errors, remediations, and settings description land in
  the same PR as the behavior.
- **Server verification is authoritative.** Browser fields, feed URLs, page tags, and model
  output are all candidates until the server's checks pass.

## Slice plan

Each slice fits one agent session and lands on the same branch and PR.

1. **Deterministic extraction, the vault copy, and the route.** `source/photo.ts` with the
   feed and share-image parsers and candidate rules, the reader changes, the photo store with
   its resize, sidecar, sweep and removal, the route, composition wiring, the `sharp`
   dependency, unit, store and route tests. After this slice custom-source stories with media
   tags or share images show photos end to end from the owner's vault. No schema change.
2. **Storage, status, and settings row.** The migration, repository methods, `photoStatus` in
   the DTO and list tool, drift counting in the refresh, the status text on the row, and the
   manifest feature entry. No model yet.
3. **Recipe proposal, preview, and accept.** `source/photo-recipe.ts` and
   `source/photo-discovery.ts`, the three recipe routes and two tools, the preview block and
   its four states in the settings pane, the prerequisite gate, error and remediation entries
   in the manifest, and the live-path proof for all three exit-criteria journeys.

## Self-review

- Every string a user or Moss will see is written out here, not left as "something like".
- The deterministic pass precedes any model use, and the model never runs on a schedule.
- Nothing from the model or the browser reaches the source row without server verification and
  an owner action.
- The fetch budget is bounded per refresh, per host, and by the existing deadline, so a slow
  publisher cannot slow headlines.
- The proxy's allowlist is the union of built-in image hosts and the source's saved hosts, so a
  recipe cannot widen where photos come from.
- The stored copy is bounded in three ways at once: dimensions, per-owner count and bytes, and
  age since last served. Nothing accumulates without a sweep.
- No News change and no shared image service were added to fill a gap outside the note.
