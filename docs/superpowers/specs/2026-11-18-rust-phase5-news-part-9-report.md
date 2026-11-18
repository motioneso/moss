# Rust Phase 5: News part 9 (settings screen) report

Task JS-334. Plan: `2026-11-13-rust-phase5-news-sports-weather-plan.md`. Release note Category: Added.
No Vikunja card was found for this task, so no card was updated.

## What was built

The News settings page as a package screen at `/settings/news`, reproducing the TypeScript screen in
`packages/news/src/settings/` with no redesign (mockups approved 2026-11-17).

- Topics from sources (chips) and described topics, with add, edit and remove.
- The web-search gate. With no web search, "Add topic" is disabled and the page says why and where to
  fix it. The wording follows the reason the server reports.
- Built-in source tiles (on, off, excluded), "Sources you add" with health and remove, and the add
  flow (check, pick a match, confirm, with its error and duplicate states).
- Excluded publishers (add and remove, with the server's rejection wording).
- Story preferences (edit reason, remove), hidden when empty.
- Loading, broken (with retry) and saving states.
- Manifest: screen `/settings/news`, settings path `/settings/news`, descriptions and version 0.1.1.
  Files ship through `host/src/package.rs`.

## Left out

- The keyed-publisher control (connect, replace, revoke a key) and the "connect accounts" wording.
  Part 6 (NewsAPI) was dropped. The Publishers subtitle loses "connect accounts".

## Known difference

- The Rust feedback route does not store a headline or source name, so story preference rows read
  "News story" and "Unknown source".

## Proof

| Claim                 | Check                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Pure rules are right  | 13 node tests (`node --test modules/news/ui/*.test.mjs`)                                          |
| Package ships screen  | `the_settings_screen_ships_with_every_file_it_loads`                                              |
| Real screen, desktop  | real HTTPS server, shell web build, signed-in owner, opened in a browser at 1280 wide             |
| Phone size            | same at 390 wide, no sideways scroll                                                              |
| Gate shows its reason | page reads "No web search is set up. Add a model with built-in search or a Brave key..."          |
| Real writes           | source on and off, topic on, exclusion add, source check all hit the real routes and returned 200 |
| Source check failure  | Reddit was unreachable from this box; the real "We couldn't reach that site" answer showed        |

Adding a source was proven live: a real NPR feed, checked by a real model (gpt-5.6-luna through the
local model proxy), saved, and still listed after a full reload.

No network response was intercepted or rewritten.

## Found and fixed during live proof

- The word "null" printed in several places where a section had nothing to show. Fixed with a helper
  that skips empty values, re-checked live.

## Not proven

- Described topics with web search on. The Rust News module reports web search as off on purpose
  (`modules/news/src/personalization.rs`: "The host cannot say whether a model is set up ... Name
  search and free-form topics need web search and stay off"), and adding a topic answers 503
  "Topic discovery requires web search". A test server cannot turn it on, so the gate (disabled button
  plus its reason) is what was proven.
- Story preference rows with real data (the live test removes its feedback before the hold).
- The fixes made after review (typing focus, retry on a failed load) were checked by lint and unit
  tests only, not re-opened in a browser.
