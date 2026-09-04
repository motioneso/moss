# Sports: Subreddit Sources and Source Icons

**Status:** Draft, awaiting Ben's approval

**Date:** 2026-09-03

**Owner:** Ben

**GitHub:** #2211; built on PR #2210 (`feat/sports-feedback-polish`)

## Problem Statement

Custom Sports news sources (#1572) accept a publication homepage and read its feed or a saved
page recipe. Two gaps surfaced in the 2026-09-03 live session on Settings > Modules > Sports:

- Fans follow subreddits (r/LiverpoolFC, r/nfl, r/CollegeBasketball) as their aggregator. A
  subreddit's value is the set of articles its members link to, spread across many publishers, so
  adding each publisher by hand does not reproduce it. Ben's note: "Users should be able to add
  subreddits and pull in the corresponding sources from those articles."
- Source rows in the settings list have no visual identity. Ben asked for the publication icon or
  logo. The production content security policy only allows images from our own origin, `data:`,
  and the hosts a module declares, so a favicon cannot be loaded straight from the publisher.

## Solution

1. **Subreddits are a third retrieval method for a custom Sports source.** The user types
   `r/Name`, `/r/Name`, or a reddit.com subreddit URL into the same Add a source box. Moss reads
   the subreddit's public new-posts listing and turns every post that links out to an article into a
   headline for that article. Self posts, images, videos, polls, crossposts to other subreddits, and
   posts that only link back to Reddit are skipped. The subreddit is scoped to followed teams and
   leagues with the same coverage picker as a publication, has the same health states, and shows up
   in the same source list. Publishers seen in a subreddit are shown on each headline but are not
   offered as standalone sources (Ben, 2026-09-03).
2. **Source icons are served through our own server, strictly as images.** A new owner-only route
   returns the icon bytes for one of the caller's custom sources. For a publication it is the
   site's favicon; for a subreddit it is the community icon. The server only accepts responses whose
   bytes are a real raster image, never HTML or SVG, and caches them. The settings list and the
   preview card show the icon, falling back to the neutral newspaper glyph when there is none.

## User Stories

- As a fan, I add `r/LiverpoolFC`, scope it to Liverpool, and my Liverpool headlines include the
  articles that subreddit links to, each labelled with the real publisher.
- As a fan, I add `r/nfl` unscoped and it contributes headlines to the NFL sport lane.
- As a user, I see a preview of what a subreddit would contribute before I confirm it, including
  sample linked articles, and I am told plainly if the subreddit is private, banned, or not found.
- As a user, I see each source's icon in the list so I can tell them apart at a glance, and a
  plain glyph when a site has no usable icon.
- As a user, a Reddit outage or rate limit shows as "Having trouble" on the row, with a retry, and
  never breaks the rest of my headlines.

## Implementation Decisions

### Subreddit sources

- **Input detection lives in discovery.** `resolveSportsSourceInput` recognises `r/Name`,
  `/r/Name`, and `https://(www.|old.)reddit.com/r/Name[/...]` before the publication path runs.
  Subreddit names are validated against Reddit's rules (3 to 21 characters, letters, digits,
  underscore). Anything else falls through to the existing publication flow unchanged.
- **Reading uses Reddit's public JSON listing**, `https://www.reddit.com/r/{name}/new.json?limit=50`,
  plus `https://www.reddit.com/r/{name}/about.json` for the title, description, and community icon.
  Both go through the existing Sports safe-fetch port with the host allowlist pinned to
  `www.reddit.com`, JSON added to the accepted content types for these two calls only, a one
  megabyte cap, and a descriptive User-Agent (Reddit throttles generic agents). No Reddit API keys,
  no OAuth, no scraping of Reddit HTML. Reddit's RSS is not used because its entries link to the
  thread, not the article.
- **A post becomes a headline only when it links out.** Keep a post when `is_self` is false, the
  link host is not reddit.com, redd.it, i.redd.it, v.redd.it, or preview.redd.it, `post_hint` is
  absent or `link`, and the post is not stickied. Headline fields: title from the post title, url
  from the post's outbound link, publishedAt from `created_utc`, publisherLabel and publisherDomain
  from the outbound link host (registrable domain, "www." stripped), summary null, imageUrl null,
  origin `custom`, sourceId the subreddit source id. At most 40 headlines per refresh.
- **Persistence reuses the custom sources table.** A new migration (never edit an applied file)
  widens `retrieval_method` to allow `'reddit'`, sets `recipe_status = 'feed'` semantics for it
  (no recipe columns, like a feed), and stores the listing URL in `feed_url`. `canonical_domain` is
  `reddit.com`; `label` is `r/Name` (Reddit's display name casing); `homepage_url` is the subreddit
  URL; `confirmed_fetch_hosts` is `["www.reddit.com"]`. Assignments carry the listing URL as
  `target_url`. The duplicate check compares the lower-cased subreddit name so `r/nfl` and
  `r/NFL` are the same source. No exact-target URL per assignment for subreddits in this slice.
- **Preview and confirm are the existing two-phase flow.** The candidate carries the subreddit
  title as its label and up to ten sample linked-article headlines. Rejections use the existing
  reasons: `unreachable` for network or 5xx, `invalid_input` for a malformed name, `not_found`
  (new) when the listing 404s or `about.json` reports the subreddit does not exist, and
  `auth_required` health when Reddit returns 403 for a private or quarantined subreddit. A 429
  maps to health `failing` with reason `rate_limited` and the message "Reddit is rate limiting
  Moss. Headlines resume automatically." The content-policy verdict runs on the subreddit's own
  title and description; outbound article domains are not policy-checked individually, the same
  as feed entries today.
- **Refresh is the existing on-demand path.** `SportsPublicSourceReader.refresh` gains a reddit
  branch next to feed and scrape, inside the same ten-minute cache, concurrency bound, request
  budget, and deadline. No new scheduler.
- **UI stays in the one Add a source box.** The placeholder becomes `theathletic.com or r/nfl`, the
  hint under it mentions subreddits, and the preview card and list row show the community icon
  through the icon route. Nothing else on the pane changes.
- **App map.** The Sports manifest's settings entry and the sources feature description gain the
  subreddit capability, the new route is declared, and the migration is listed with the module's
  data tables. Same PR.

### Source icons

- **Route.** `GET /api/sports/sources/:sourceId/icon`, permission `sports.view`, declared in the
  Sports manifest. It loads the source through the owner-scoped repository, so another user's
  source id is a 404. Modelled on the News article-image route (`packages/news/src/image-route.ts`).
- **Publication icon lookup, images only.** Try `https://{canonical_domain}/favicon.ico`, then
  `https://www.{canonical_domain}/favicon.ico`, through the safe-fetch bytes port with the host
  pinned to that domain, a 256 KB cap, and a five-second timeout. Accept the body only if its magic
  bytes are ICO, PNG, JPEG, GIF, or WebP. HTML, SVG, and anything else are treated as "no icon". The
  page's `<link rel="icon">` is deliberately not parsed in this slice: Ben ruled icons are pulled
  "strictly as images", and most sports publishers serve `/favicon.ico`.
- **Subreddit icon.** The `community_icon` or `icon_img` URL from `about.json`, saved on the source
  row at confirm time in a new nullable `icon_url` column (same migration), fetched by the route
  with the host pinned to Reddit's image hosts (`styles.redditmedia.com`, `b.thumbs.redditmedia.com`)
  under the same byte and type rules.
- **Caching and failure.** A small bounded in-process cache keyed by source id: hits for 24 hours,
  misses for one hour. The route answers 200 with the sniffed content type, `Cache-Control:
private, max-age=86400`, and `X-Content-Type-Options: nosniff`; a miss answers 404. The client
  renders `<img src=/api/sports/sources/{id}/icon>` and swaps to the newspaper glyph on error, so a
  missing icon never shows a broken image. ESPN keeps its bundled mark from the already-allowed
  ESPN image host.

## Testing Decisions

- Unit: subreddit input detection (accepted and rejected forms); post filtering (self, media,
  reddit-internal links, stickied, crossposts dropped; linked articles kept with the right
  publisher domain); health mapping for 403, 404, 429, 5xx; duplicate detection by lower-cased
  name; icon magic-byte sniffing accepts the five raster types and rejects HTML and SVG.
- Repository and migration: the widened constraint accepts `reddit`, rejects unknown values, and
  a reddit row with recipe columns is rejected.
- Settings UI: adding `r/nfl` renders a preview card with sample linked articles and the same
  coverage picker; the row shows the icon and falls back to the glyph on image error.
- Browser (existing sports settings spec): one journey adding a subreddit against a stubbed Reddit
  listing, confirming, and seeing the row.
- Live proof on dev, recorded on PR #2210: add a real subreddit scoped to a followed team, see its
  linked-article headlines on Today, see icons on the source rows.

## Out of Scope

- Suggesting publishers found in a subreddit as standalone sources (Ben, 2026-09-03: no).
- Every-post mode, comments, flair filters, or search-based listings.
- Reddit accounts, OAuth, or credentialed access to private subreddits.
- Parsing publisher HTML for `<link rel="icon">` or app-touch icons; SVG icons.
- Storing headlines in a table; the on-demand cache stays as it is.

## Further Notes

- Reddit's unauthenticated JSON endpoints are a courtesy, not a contract. The health reason
  `rate_limited` and the descriptive User-Agent are the mitigations; if Reddit closes the door, the
  row reads "Having trouble" and nothing else in Sports is affected.
- The icon route is the first Sports endpoint returning bytes rather than JSON; it follows the News
  precedent and adds no new fetch primitive.
