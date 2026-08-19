# #1185 — Clarify News image captions and no-image excerpts

**Status:** Approved by Ben from live Agentation feedback on 2026-07-19  
**Issue:** #1185  
**Annotations:** `mrs6fnq4-zwv9ak`, `mrs6fzi5-6xxaah`, `mrs6kba3-kbjwv6`  
**Tier:** Routine module-owned visual polish with manual acceptance

## Problem

In the two-column News mosaic, a photo can visually read as belonging to the neighboring story
instead of the headline beneath it. Text-only cards already receive a larger CSS line clamp, but the
live page still feels prematurely empty when a feed provides a useful longer summary. News also
starts at a different top offset than Sports.

## Decision

- Use the existing image-then-kicker adjacency to visually bind each photo to its own source/topic
  line. The internal photo-to-kicker spacing must be smaller than the gap between neighboring cards,
  and each card's existing keyline must continue to define its boundary.
- Do not add a card library, masonry layout, JavaScript measurement, or fabricated article text.
- Keep using the feed's sanitized, already-bounded `summary`. Remove the text-only card clamp so the
  available summary appears before **Continue reading**; photo cards keep their ordinary clamp.
- Match the News page's top spacing to the established Sports page spacing with existing tokens.

## Scope

- News-local CSS under `~/Jarv1s/packages/news/src/web/styles/`
- Focused News web tests and the existing live-acceptance path

## Non-goals

- No News topic navigation decision (`mrs6e5xf-38fy5c`, tracked separately in #1190).
- No component markup, feed parsing, summary generation, API contract, ranking, source attribution,
  or image-proxy changes unless live proof demonstrates that CSS cannot create an unambiguous group.
- No attempt to pad genuinely short summaries or fetch article bodies.

## Acceptance

- [ ] At desktop and narrow widths, every image is visually grouped with its own source/headline;
      adjacent story text cannot reasonably be mistaken for its caption.
- [ ] Text-only cards show their complete available sanitized summary without a CSS line clamp before
      **Continue reading**.
- [ ] Photo cards retain a bounded excerpt and the existing broadsheet rhythm.
- [ ] News and Sports use the same top-page spacing token/value.
- [ ] Focused tests cover image and no-image markup/classes without snapshotting incidental text.
- [ ] Live `5178` desktop and narrow DOM assertions prove both card variants before resolving the three
      annotations.
