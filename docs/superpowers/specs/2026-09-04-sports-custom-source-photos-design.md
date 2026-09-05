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

## What you will get

1. As a user, I can see the publisher's photo on stories from my own added sources, in the hero carousel, the Today news band, and the story list, the same as ESPN stories.
2. As a user, I get those photos without doing anything: Moss reads them from the feed or the article page during the normal refresh.
3. As a user, I can see a big photo lead the hero carousel when its story is one of the top stories.
4. As a user, I can still see a small photo in the smaller story slots instead of a blank.
5. As a user, I can see on each source row in Sports settings whether photos are working, none were found, checking, preview ready, or stopped working.
6. As a user, I can press Find photos on a source with no photos and have Moss look at the site for me.
7. As a user, I can look at a preview of a few stories with the photos Moss found before anything is saved.
8. As a user, I can press Use these photos to keep them, or Not right to keep nothing.
9. As a user, I can press Stop using Moss's photos on a source and go back to the plain feed photos.
10. As a user, I get a clear message and a link to Assistant settings if Find photos needs a chat model I have not set up.
11. As a user, I do not have to babysit a source: if its photos stop appearing, Moss looks again on its own and only tells me if it still finds nothing.
12. As a user, I can ask Moss in chat why a source has no pictures, or ask it to find photos for a source, and it does the same thing the buttons do.
13. As a user, my photos are copies kept on my own box, so a page load never fetches from the publisher and the publisher never sees my browsing.
14. As a user, old photo copies are cleaned up on their own and removed when I remove the source.

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

The desk knows nothing about a photo's size today. A story either has a photo URL or it does
not; the hero, the Today news band, and the list thumbnails all show whatever URL they are
given, and the ranking bonus is the same for a tiny thumbnail and a full-width header image.

Most publishers do put a photo somewhere reachable. RSS feeds commonly carry a media tag or an
enclosure. Almost every article page names its share image in an og:image or twitter:image
tag. A subreddit post links out to an article page that has one. None of that needs a model.

A minority of sources do not fit those rules: the feed has no media tag, the page has no share
image, or the share image is a site logo rather than the story photo. For those, Sports already
has the shape of an answer. Scraped sources are read through a per-source rule that the
configured model proposed and the server verified before the user confirmed it. A photo rule
can be built, verified, and confirmed the same way.

The browser only loads images from a fixed set of hosts, so a publisher's photo cannot be
shown by URL directly. Sports already solves this for source icons with a server-side route
that fetches the image, checks its bytes, and keeps it in memory. Photos need a stronger
version of that: a resized copy kept on the box in the owner's vault.

## Goals

- A story from a feed, scraped, or subreddit source shows the publisher's photo wherever an
  ESPN story would: the hero carousel, the news band on Today, and the story list thumbnail.
- The first pass is deterministic and needs no model: feed media tags, then the article page's
  share image, all done on the server, for every story from every custom source.
- Moss records each photo's size, and the desk uses it: a story with a large photo is preferred
  for the hero slot when the story itself qualifies, and a small photo still shows in the small
  slots rather than being hidden.
- When the deterministic pass finds nothing for a source, the owner can press Find photos. Moss
  looks at the source, finds where its photos live, shows a preview of a few stories with their
  photos, and the owner presses Use these photos or Not right. Nothing is saved until then.
- When a source's photos stop appearing later, Moss quietly looks again on its own at the next
  sync and only tells the owner if it still finds nothing.
- Moss keeps its own resized copy of each story photo on the box, in the owner's vault, and
  serves that copy. The browser never loads from the publisher, and the publisher is fetched
  once per photo, not once per page view. Ben's ruling, 2026-09-04.
- The owner can see per source, in Sports settings, whether photos are working and what to do
  when they are not.
- Moss can explain all of this and run the Find photos flow from chat.

## Non-Goals

- No change to how ESPN stories get their photos.
- No original-size copies. Moss stores one resized copy per photo and nothing else; if a larger
  rendition is ever wanted it is fetched and resized again.
- No photo bytes in the database. The database holds the path key and metadata only.
- No cropping or editing. The stored copy is scaled down to fit, never cropped; the hero crops
  with object-fit at display time as it does today.
- No hiding of a photo because it is small. Size affects which slot prefers a story, never
  whether the photo is shown.
- No model-driven changes to how a source's headlines are read. A photo rule only adds a photo
  to stories the existing reader already found.
- No automatic saving of anything the model proposes. The first time, the owner confirms in the
  preview. Later automatic re-looks may only re-verify against the same checks and save a rule
  that passes them, as decision 6 describes.
- No News module changes. News keeps its own article-image route. If a shared image proxy is
  wanted later it is its own spec.

## Resolved Decisions

### 1. Where the photo comes from, in order

For each story from a custom source, the server tries these in order and stops at the first
candidate that passes the checks in decision 3.

1. **Feed media tags**, for feed sources only. In order: `media:content` with a medium of image
   or an image content type, then `media:thumbnail`, then an `enclosure` with an image type.
   When a tag repeats, the largest declared width wins; without widths, the first wins.
2. **The source's saved photo rule**, when it has one that is in use. See decision 5.
3. **The article page's share image.** Fetch the story's own URL and read, in order, the
   `og:image:secure_url`, `og:image`, and `twitter:image` meta tags. This applies to feed
   sources whose feed had no media tag, to scraped sources, and to subreddit sources, where the
   story URL is already the outbound article link and never a Reddit address.

A saved photo rule sits above the share image on purpose: the owner confirmed it precisely
because the share image was wrong or missing for that source. A feed media tag still wins over
a rule, because the publisher declared it for exactly this use.

### 2. Fetch budget

Photo lookups run for every story from every custom source, inside the existing refresh of
that source. They never delay headlines. Ben's ruling: if a story is selected and it has an
image, we show it; there is no other condition on the source.

- Feed media tags cost nothing extra; they are read from the feed body already fetched.
- Article page fetches are capped at 6 per source per refresh and 2 in flight per publisher
  host, reusing the reader's existing per-domain limit. Only the stories that would be shown
  are fetched: the ones the reader keeps after its own item limit, newest first.
- Each page fetch has a 1 MB body cap and a 6 second timeout, matching the reader.
- The result per story, hit or miss, is kept with the headline for the headline cache's
  lifetime, so a story is not re-fetched on every overview request.
- If the refresh deadline is close, remaining lookups are skipped and those stories go out
  without a photo. The next refresh tries again.

### 3. What counts as a usable photo

A candidate URL must pass all of these on the server before it is attached to a story:

- HTTPS, no credentials in the URL, a public host, no more than 2048 characters.
- The host is the publisher's own host, a subdomain of it, or one of a short built-in list of
  common image hosts used by publishers. The list ships with the module and is extended by
  ordinary code review, not by the model. It is the allowlist for the fetch in decision 4 as
  well.
- The candidate is not a known non-photo: paths that end in `favicon.ico`, contain `logo`,
  `default`, `placeholder`, or `sprite`, or 1 by 1 tracking pixels by declared size.

There is no minimum size. Ben's ruling, 2026-09-04: use whatever the source gives, and let the
layout decide where a photo looks best. The only size rule is a floor that separates a photo
from an icon: the fetched image must be at least 64 pixels on its short side, which excludes
favicons and tracking pixels and nothing else.

The bytes check happens when the server fetches the image: it must start with JPEG, PNG, WebP,
or GIF magic bytes, be at most 2 MB, and decode to a real width and height. The width and
height are recorded with the story. A failed bytes check is remembered as a miss for the
headline cache's lifetime so the same broken image is not fetched again, and the story is
shown without a photo.

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
time, the original width and height, the stored width and height, and the byte size. Files
are written with the vault's owner-only permissions, so a copy is readable by its owner's
requests only. There is no existing media store in the codebase to reuse; the chat attachments
layout is the precedent.

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
on the next refresh. The story DTO's photo field becomes that route's path, and the story DTO
gains the photo's width and height. ESPN stories keep their direct CDN URLs, which the browser
is already allowed to load; they are outside this spec.

A small in-memory cache in front of the route holds the last 32 served files or 16 MB so a busy
Sports page does not reread the disk for every visitor of the same owner. That cache is a
convenience only; the vault copy is the record.

The publisher's server sees one fetch per photo from Moss for as long as the copy is kept,
never one per page view, and never a request with the user's cookies or identity.

### 5. The photo rule (internal only)

A photo rule is a small, verified instruction for finding the photo on one source's article
pages. It lives on the source row and belongs to its owner. The user never sees the rule or the
word; the settings row only says whether photos are working.

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
allowlist. A rule that fails these shape checks is rejected before it is ever run.

A rule has an internal state stored beside it: `none`, `previewing`, `in_use`, or `stale`.
Stale means the rule in use found no photo on three consecutive refreshes where stories were
present. Stale does not remove the rule; it triggers the quiet re-look in decision 6.

### 6. Find photos: how Moss looks at a source

Moss never runs the model during an ordinary refresh unless decision 6c applies. The first look
at a source happens only when the owner presses Find photos on its row, or asks Moss in chat,
which calls the same tool.

**6a. When the button shows.** Find photos is offered on a source row when the source is
healthy and its photo status is "none found" or "stopped working", meaning the last refresh had
stories but none got a photo.

**6b. What happens when pressed.** From the owner's side: Moss looks at the source, finds where
its photos live, shows a preview of a few recent stories with the photos it found, and the
owner presses Use these photos or Not right. On the server:

1. It fetches up to three of the source's newest story pages through the safe-fetch layer,
   strips scripts and styles, and keeps the head plus the first 40 KB of body for each.
2. It sends the configured model, through the AI router's structured output seam that the
   existing scraped-source rule builder already uses, the source's host, those bounded page
   excerpts, and the instruction to name the element that holds the story's lead photo. The
   schema is the rule shape in decision 5. The prompt carries no other sources, no preferences,
   no credentials, and nothing about the user.
3. It validates the shape, then runs the rule against the same three pages. It must find a
   candidate on at least two of three, and each candidate must pass decision 3 including the
   bytes check.
4. The verified result becomes the preview: the three story titles and the photos it found,
   served from the owner's vault. The rule itself is not shown. The preview is bound to an
   actor-scoped handle exactly like the existing scraped-source rebuild preview, so what the
   owner confirms is what the server verified.
5. Use these photos saves the rule and marks it in use. Not right saves nothing. A preview
   expires after ten minutes.

If no model is configured the button still shows, and pressing it renders the existing
prerequisite gate with the text "Finding photos needs a configured chat model." and its
Assistant settings link. If the model returns nothing usable, the row says "Moss could not find
photos on this source." and the button stays available.

The model budget per attempt is one structured call with at most 4000 output tokens, plus the
bounded page fetches above. There is no tool use in this call; the pages are fetched by the
server beforehand and handed over as text.

**6c. When photos stop appearing later.** If a rule in use finds no photo on three consecutive
refreshes that had stories, the rule is marked stale and Moss quietly looks again on its own at
the next sync of that source. That re-look runs the same steps as 6b with one difference in
step 5: because the owner already confirmed that Moss may find this source's photos, a new rule
that passes the two-of-three verification replaces the stale one without a preview, and the row
simply goes back to "working". The owner is told only if the re-look still finds nothing: the
row then reads "Photos: stopped working" and offers Find photos again. Moss re-looks at most
once per day per source, and never when no model is configured; in that case the row goes
straight to "stopped working".

### 7. Photo status per source

Each source row in Sports settings shows a photo status next to its health badge, and Moss can
read it through the sources tool. The states and their exact wording:

| Status          | Row wording             | Shown when                                                       |
| --------------- | ----------------------- | ---------------------------------------------------------------- |
| working         | Photos: working         | Last refresh attached a photo to at least one story.             |
| none            | Photos: none found      | Last refresh had stories and none got a photo.                   |
| previewing      | Photos: preview ready   | A verified preview is waiting for Use these photos or Not right. |
| stopped_working | Photos: stopped working | Moss's own re-look also found nothing.                           |
| pending         | Photos: checking        | No refresh with stories has completed yet.                       |

A source whose photos come from a rule Moss found shows plain "Photos: working"; the owner
does not need to know how. The row offers "Stop using Moss's photos" only for such a source,
which removes the rule and returns the source to the deterministic pass.

The two model-related strings are:

1. "Finding photos needs a configured chat model." through the existing prerequisite gate.
2. "Moss could not find photos on this source."

### 8. Photo size and the hero slot

Today the desk knows only whether a story has a photo. The lead-story ranking adds two points
for any photo, the hero carousel shows whatever URL the top stories carry, the news band on
Today does the same, and the story list shows a small thumbnail. No size is read anywhere.

The change, per Ben's ruling that a large image should be preferred for the hero when the
content is good:

- Every story from a custom source carries its photo's original width and height, recorded at
  fetch time. ESPN stories carry none and keep today's behaviour.
- The ranking bonus stays two points for any photo. Size never changes a story's rank.
- When the desk chooses the hero stories, it takes the top-ranked stories as it does now, then
  within that set prefers a story whose photo is at least 800 pixels wide for the lead slide.
  A qualifying story with a small photo still rides in the carousel; it just does not go first
  if an equally ranked story has a hero-sized photo. Stories with no photo keep today's blank
  block.
- The news band on Today and the story list thumbnails use the photo regardless of size; both
  render well below 400 pixels wide.

The 800 pixel line is where the hero slide stops looking soft on a desktop screen at the
carousel's current width. It is a preference inside the already-chosen set, never a filter.

### 9. Attribution and the stored copy

The photo is the publisher's. Moss already shows the publisher label and links every story to
its article, which is the attribution the share-image convention expects; publishers put the
image in og:image so that link previews show it. Moss fetches each photo once with a plain user
agent and keeps a reduced private copy for the owner's own reading, the same footing as a
browser cache or a feed reader's thumbnail. The copy is never cropped, never shown outside the
owner's account, never exported, and is removed on the schedule in decision 4.

## Open Questions for Ben

None open. Ben ruled on 2026-09-04:

- **Every story gets a photo lookup.** If a story is selected for the page and its source has
  an image for it, Moss shows it. There is no extra condition on the source; the fetch budget
  in decision 2 is the only limit.
- **Store a resized copy on the box**, never hotlink. Decision 4.
- **No minimum size.** Use whatever the source gives, show small photos in the small slots, and
  prefer a large photo for the hero when the story qualifies. Decisions 3 and 8.
- **Plain words in the product.** The owner sees Find photos, a preview, Use these photos and
  Not right, and a status line. Moss re-looks on its own when photos stop appearing and only
  speaks up if it still finds nothing. Decisions 6 and 7.

## Architecture

### Reader changes

The generic reader for feeds and scraped pages, and the subreddit reader, gain a photo step
after item extraction and before caching. A new `source/photo.ts` owns the deterministic pass:
feed tag parsing, share-image parsing, candidate checks, and the per-refresh fetch budget. The
reader passes it the fetched feed body and the kept items; it returns the same items with a
photo URL and size or null. The story type's photo field changes from always-null to nullable,
and gains nullable width and height.

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

### Photo rule proposal, verification, and re-look

`source/photo-rule.ts` owns the rule shape, its validator, the structured-output schema built
with the same helper the headline rule uses, and the verify step that runs a rule over fetched
pages. `source/photo-discovery.ts` runs the Find photos flow from decision 6b using the same
AI port the existing scraped-source rule builder gets from the composition root, and the quiet
re-look from decision 6c, which the refresh path calls when a rule is stale and the daily
re-look budget allows. Previews reuse the existing preview handle store so Use these photos is
bound to the actor and to the verified payload.

### Storage and repository

One new Sports-owned migration, next number in `packages/sports/sql/`, adds to
`app.sports_custom_sources`:

- `photo_rule_json jsonb` with a check that it is null or an object.
- `photo_rule_state text` defaulting to `none`, checked against `none`, `previewing`, `in_use`,
  and `stale`. The `pending`, `working`, and `stopped_working` statuses in the DTO are derived
  from this column, the last refresh outcome, and the last re-look outcome.
- `photo_miss_streak smallint` defaulting to 0, the stale counter.
- `photo_last_outcome text` recording the last refresh outcome, `working` or `none`.
- `photo_relook_at timestamptz` recording the last automatic re-look and its result, so the
  once-a-day rule is durable and the row can say "stopped working" without a refresh.

RLS classification: **owner-only**. The columns sit on rows already under FORCE RLS with the
owner policy from migration 0190, so no new policy is needed. The repository gains read and
write methods for these columns and a method that bumps or resets the miss streak inside the
refresh transaction. Rules are not export data and are excluded from user exports, matching
how the icon URL was handled.

### Compilation and ranking

The ranking bonus is unchanged. The hero selection in the composition step gains the size
preference from decision 8: within the already-chosen top stories, a story whose photo width
is at least 800 moves to the lead slide. The hero, news band, and thumbnail markup already
branch on the photo field and need no change beyond taking the route path.

### API contracts

Additions to `packages/shared/src/sports-sources-api.ts` and `sports-api.ts`:

- `SportsCustomSourceDto` gains `photoStatus` with the five values from decision 7 and a
  boolean `photosFoundByMoss` so the row can offer Stop using Moss's photos.
- Story DTOs gain `imageWidth` and `imageHeight`, nullable, alongside `imageUrl`.
- `POST /api/sports/sources/:id/photos/preview` runs the Find photos flow and returns
  `{ status: "ready", handle, samples: [{ title, photoUrl }] }`,
  `{ status: "unavailable" }` for no model, or `{ status: "not_found" }`.
- `POST /api/sports/sources/:id/photos` with `{ handle }` is Use these photos and returns the
  updated source DTO.
- `DELETE /api/sports/sources/:id/photos` is Stop using Moss's photos.
- `GET /api/sports/headlines/:headlineId/photo` returns the owner's stored WebP copy or 404.

All four are declared in the manifest's routes with the `sports.sources` permission for the
three source routes and `sports.view` for the photo route. The story DTO's `imageUrl` field is
unchanged in name; its value for custom sources is now the route path.

### Moss: app map and tools

Manifest `features` gains `sports.source_photos`: "Stories from a custom source show the
publisher's photo in the hero and story list when the feed or article page provides one. When a
source has no usable photo, Find photos on its row in Sports settings asks Moss to look at the
source, find where its photos live, and show a preview of a few stories with photos; the owner
then presses Use these photos or Not right. If a source's photos stop appearing later, Moss
looks again on its own at the next sync and only says so if it still finds nothing." Its
`errors` list the two strings from decision 7 with the remediation "Configure a chat model in
Assistant settings" for the first and "Try Find photos again after the source publishes new
stories, or leave the source without photos" for the second.

The existing `sports.sources` settings entry's description is extended with the photo status
line and the Find photos action.

Tools added, mirroring the existing rebuild pair:

- `sports.findSourcePhotos` (read, external content): runs the preview and returns the sample
  titles and photo paths.
- `sports.useSourcePhotos` (write, confirm always): Use these photos with the exact handle from
  the preview.
- `sports.listSources` output gains `photoStatus` so Moss can answer "why does this source
  have no pictures".

## Screens

### Source row in Sports settings

Mockup: `docs/superpowers/specs/mockups/sports-source-photos.html`, built from the existing
badge, button, and eyebrow primitives and the layout classes already in the sources pane. The
only new layout classes are the preview block's own, added to the pane's stylesheet.

```
+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: none found                     |
|                                        [Find photos] [Edit]          [Remove]   |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: preview ready                  |
|                                                    [Edit]          [Remove]     |
|  PHOTO PREVIEW                                                                  |
|  Moss found photos on 3 of 3 recent stories from this source.                   |
|  +----------+  +----------+  +----------+                                       |
|  |  photo   |  |  photo   |  |  photo   |                                       |
|  +----------+  +----------+  +----------+                                       |
|  Title one     Title two     Title three                                        |
|                                              [Not right] [Use these photos]     |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| [icon] The Athletic          [Healthy]    Photos: working                        |
|                           [Stop using Moss's photos]  [Edit]        [Remove]    |
+--------------------------------------------------------------------------------+
```

The Edit button in the sketches is the row's existing button for choosing which teams and
sports a source feeds; it is shown for position only and is not changed by this spec.

States the row must also render:

- **Loading** after Find photos: the button reads "Looking…" and is disabled, the other
  actions stay enabled, matching the existing Rebuild button's "Checking…" behavior.
- **No model:** the preview block is replaced by the existing prerequisite gate with the
  Assistant settings link.
- **Not found:** the preview block shows the second string from decision 7 in the existing
  hint style, and Find photos is enabled again.
- **Stopped working:** the status reads "Photos: stopped working" and Find photos returns,
  alongside Stop using Moss's photos.

### Sports page

No new screen. The hero carousel, Today news band, and story list already render a photo when
the story has one. The only change is the lead-slide preference in decision 8. The empty warm
block remains the empty state.

## Testing

- Unit tests for the feed tag parser (media content with widths, thumbnail, enclosure, missing,
  malformed), the share-image parser (secure_url precedence, relative URLs resolved against the
  page, missing), and every candidate rule in decision 3, including that a 200 by 150 photo is
  kept and a 32 by 32 icon is not.
- Unit tests for the image header reader across the four formats plus a truncated body, and
  that width and height are recorded on the story.
- Reader tests proving the fetch budget: 6 page fetches per source, 2 per host in flight, no
  fetch when the deadline is near, and headline output unaffected by a failed photo fetch.
- Store tests with a temporary vault root: a 2000 by 1500 JPEG lands as a 1280 by 960 WebP,
  a 640 by 480 PNG is not scaled up, an animated GIF is flattened, an oversized body is
  recorded as a miss with no file written, two stories with one photo URL share one file, the
  sweep removes copies past 14 days and trims to the caps by last-served time, and removing a
  source removes its copies.
- Route tests: another user's headline id is a 404, a missing copy is a 404, and a hit returns
  the browser cache header and entity tag.
- Hero selection tests: among equally ranked stories the one with an 800-wide photo leads; a
  story with a 300-wide photo still appears in the carousel; ranking order is unchanged.
- Rule tests: shape validation rejects long selectors, pseudo-elements, unlisted attributes,
  and hosts outside the allowlist; verify requires two of three; the model's raw object is never
  written to the row; Use these photos with a stale or foreign handle fails.
- Re-look tests: three refreshes with stories and no photo mark the rule stale; the next sync
  runs one re-look; a passing rule replaces the stale one with no preview and the status is
  "working"; a failing re-look sets "stopped working"; a second re-look inside a day does not
  run; with no model the status goes straight to "stopped working".
- Settings pane tests for the five row states, the preview block's Use these photos and Not
  right, and Stop using Moss's photos.
- Live-path proof on dev: add a feed source with media tags and see its photo lead the hero;
  add a source whose feed lacks tags and see the share image used; press Find photos on a source
  with neither, confirm the preview, and see photos on the next refresh; record request logs
  and bounded DOM facts on the PR.

## Exit Criteria

- A story from a feed source with a media tag, a scraped source with an og:image, and a
  subreddit post linking to an article page all show the publisher's photo in the hero, the
  Today news band, and the story list thumbnail on a live dev instance.
- No custom-source photo is ever loaded in the browser from the publisher; every one is served
  from the owner's vault copy, which is at most 1280 by 720 WebP.
- The vault copy is readable only through the owner's requests, is removed with its source,
  and the per-owner folder never exceeds the retention rule and caps in decision 4.
- No photo is hidden for being small; a story with a large photo leads the hero when it is
  among the top-ranked stories.
- A refresh with every photo fetch failing still delivers headlines within the existing
  deadline.
- Find photos on a source with no usable photo produces a server-verified preview with real
  sample photos, writes nothing until Use these photos is pressed, and afterwards the source's
  stories carry photos on the next refresh.
- When a source's photos stop appearing, Moss re-looks once on the next sync without asking,
  and the owner sees "Photos: stopped working" only if that re-look also fails.
- With no chat model configured, the deterministic pass still works and Find photos shows the
  prerequisite gate.
- Sports settings shows the five photo statuses with the exact wording in decision 7, never
  shows a rule, and the manifest's features, errors, remediations, routes, tools, and migration
  declarations match.
- Moss answers "why does this source have no pictures" from the listed status and can run the
  Find photos and Use these photos tools from chat with the second step gated.

## Hard Invariants honored

- **Private by default.** Rules, states, and counters live on owner-only rows under FORCE RLS.
  The photo route resolves headline ids inside the owner's data context, and the stored copies
  live in that owner's vault with owner-only permissions.
- **Vault I/O goes through VaultContext.** The photo store takes the vault runner and never
  uses raw file access.
- **Secrets never escape.** The proposal prompt carries a host and public page text only. No
  credentials, preferences, other sources, or user identity. Logs record hosts and reason codes,
  not page bodies.
- **Metadata-only job payloads.** Nothing new is queued; lookups and re-looks run inside the
  existing refresh.
- **Provider-agnostic AI.** The proposal uses the router's structured output seam with a schema;
  no provider or model is named anywhere in Sports.
- **Module isolation.** Sports adds its own photo route rather than importing News internals.
- **Never edit an applied migration.** One new Sports migration adds the columns.
- **No new required settings.** Nothing here needs an environment variable or a hand-edited
  file; the only prerequisite is the chat model, which already has an in-app setting and a gate.
- **App map truthfulness.** The feature, errors, remediations, and settings description land in
  the same PR as the behavior.
- **Server verification is authoritative.** Browser fields, feed URLs, page tags, and model
  output are all candidates until the server's checks pass. The automatic re-look saves a rule
  only after the same two-of-three verification the first preview required, on a source the
  owner already confirmed once.

## Slice plan

Each slice fits one agent session and lands on the same branch and PR.

1. **Deterministic extraction, the vault copy, the route, and the hero preference.**
   `source/photo.ts` with the feed and share-image parsers and candidate rules, the reader
   changes with width and height, the photo store with its resize, sidecar, sweep and removal,
   the route, the lead-slide preference in composition, composition wiring, the `sharp`
   dependency, unit, store, route and hero tests. After this slice custom-source stories with
   media tags or share images show photos end to end from the owner's vault. No schema change.
2. **Storage, status, and settings row.** The migration, repository methods, `photoStatus` and
   `photosFoundByMoss` in the DTO and list tool, stale counting in the refresh, the status text
   on the row, and the manifest feature entry. No model yet.
3. **Find photos, the preview, and the quiet re-look.** `source/photo-rule.ts` and
   `source/photo-discovery.ts`, the three source routes and two tools, the preview block and
   its four states in the settings pane, Stop using Moss's photos, the prerequisite gate, the
   daily re-look in the refresh path, error and remediation entries in the manifest, and the
   live-path proof for all three exit-criteria journeys.

## Self-review

- Every string a user or Moss will see is written out here, not left as "something like", and
  none of them contains "rule", "recipe", "accept", or "coverage".
- The deterministic pass precedes any model use, and the model runs on a schedule only for the
  bounded, once-a-day re-look on a source the owner already confirmed.
- Nothing from the model or the browser reaches the source row without server verification,
  and the first save always needs an owner action.
- Size never hides a photo; it only orders the hero.
- The fetch budget is bounded per refresh, per host, and by the existing deadline, so a slow
  publisher cannot slow headlines.
- The stored copy is bounded in three ways at once: dimensions, per-owner count and bytes, and
  age since last served. Nothing accumulates without a sweep.
- The photo host allowlist is the union of built-in image hosts and the source's saved hosts,
  so a rule cannot widen where photos come from.
- No News change and no shared image service were added to fill a gap outside the note.
