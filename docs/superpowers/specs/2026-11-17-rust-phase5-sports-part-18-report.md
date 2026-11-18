# Rust Phase 5: Sports part 18 (screen) report

Task JS-332. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: Added. Plan: `2026-11-13-rust-phase5-news-sports-weather-plan.md`. No Vikunja card was
found for this task, so no card was updated.

## What was built

The Sports page as a package screen, reproducing the TypeScript screen in `packages/sports/src/web/`
with no redesign (mockup approved 2026-11-17).

- Screens `/sports` and `/sports/today`, served by the Rust server inside the shell frame.
- Page: game-day hero or story carousel, followed-teams ticker (arrows, drag, Manage), the
  around-the-leagues board, standings rail with league picker and view picker, team news band,
  rotation control that pauses on hover and focus.
- Today sports desk: last-night scores, lead story and briefs, team and league cards, Tonight.
- Loading, error (with Try again), refresh-failed, partial-data and empty ("Follow your teams")
  states.
- Navigation entry (Sports, trophy icon, order 35) and app-map descriptions in `moss.module.json`.
- Plain ES modules and CSS under `modules/sports/ui/`, embedded into the package by
  `host/src/package.rs`. No new crate and no new package dependency.

## Proof

| Claim                           | Check                                                                                                                                                             | Result                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Pure rules are right            | 12 node tests: followed ids, game phase, score and tonight selection, quiet-night rule, hero demotion, polling, lead photo, card order, picker groups, api errors | 12 pass                                       |
| Package ships the screens       | `the_package_ships_the_sports_screens`                                                                                                                            | pass in `pnpm test:rust-sports`               |
| Real screen, real data, desktop | Real HTTPS server, shell web build, signed-in owner following NFL Dallas, NBA Lakers, NHL; live ESPN data; opened at `/sports` in a browser                       | hero, ticker, board, standings, news render   |
| Phone size                      | same, 390 by 844                                                                                                                                                  | single column, no overlap                     |
| Standings pickers               | switched NHL to NBA and Atlantic to Pacific                                                                                                                       | table changed; saved choice written (PUT 200) |
| Keyboard on the ticker          | focus the followed ticker, ArrowRight                                                                                                                             | strip scrolled, back chevron appeared         |
| Error recovery                  | a request failed at the network layer; Try again clicked                                                                                                          | screen loaded                                 |

No network response was intercepted or rewritten. Screenshots are kept with the task proof.

## Found and fixed during live proof

- A stray word "null" printed under the headline when no follow needed a choice. The empty notice
  was passed straight to the browser's append. Fixed in `page.mjs`, re-checked live.

## Found and fixed after review

- The story carousel crashed on first paint when a story led the page (as with real data on a
  quiet day), leaving only the notice lines. Its auto-advance told the carousel to paint controls
  before the carousel finished being built. The first notice is now skipped and a test covers it.
- The 2759-line stylesheet is split into four sheets by screen area (page and standings, ticker
  and Today desk, broadsheet, news), joined byte for byte in the original order. Desktop and phone
  re-checked live.

## Review round 1

- Text links to Settings inside the screen (Manage, "Choose leagues in Settings", "Choose teams to
  follow") are kept. The legacy screen and the approved mockup have them, and the brief says no
  redesign. Where they lead is not proven, because the Sports Settings pages are not in this
  package yet. Moving them to the header cog is a follow-up decision for Ben.
- Fixed: links now accept only web addresses and in-app paths, so a feed cannot plant a script
  address. The two resize listeners now remove themselves when their strip leaves the page.

## Not proven

- **Today sports desk in a browser.** The Rust shell has no widget slot on Today, so the desk page
  is a second package screen reachable only by a direct frame address. Covered by the node tests
  only. Today needs a module widget slot before this can be shown.
- **Team and league crests, photos and story links.** The shared screen frame allows images only
  from its own origin and has no pop-up permission. Crests fall back to colour swatches and
  external links may not open. Both are host limits, not Sports changes.
- **Story feedback.** The package has no route for it, so the control is omitted.
- **Locale.** `/api/me/locale` is unreachable from a package screen, so dates use the browser
  zone and region.
- **Rare first-request failure.** A few times the first request after an idle spell came back 400
  from the server's network layer (logged before any package code ran). A reload or Try again
  cleared it. Not caused by this part, not investigated further.
- **Second device on the network.** Proof ran against localhost only.
- **The shell web folder used for proof** is built from the repo and swapped in by the live test
  when `SPORTS_LIVE_WEB` is set. It is not the production installer.

## Gate

`pnpm test:rust-sports` and `pnpm test:rust-sports-live` pass on this branch.
