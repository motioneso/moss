# Rust Phase 5: Sports part 19 (settings screen) report

Task JS-335. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: Added. Plan: `2026-11-13-rust-phase5-news-sports-weather-plan.md`. No Vikunja card was
found for this task, so no card was updated.

## What was built

The Sports settings page as a package screen at `/settings/sports`, reproducing the TypeScript
settings in `packages/sports/src/settings/` with no redesign (mockup approved 2026-11-17).

- Following: followed chips, team and league search with loading, error (Retry), partial and
  no-match notices, Browse leagues by confederation with lazy rosters, follow and unfollow.
- News sources: the built-in ESPN row with Edit coverage, custom sources with health badge,
  Retry, Rebuild, Edit coverage, Remove, photo status and "Stop using Moss's photos", the
  preview-then-confirm flow with the authorization checkbox, and "Add a source".
- Configure standings: collapsed by default, sport and country tree, Select all, Clear all.
- Empty, loading and error states for each block.
- Navigation and settings descriptions in `moss.module.json` now point at `/settings/sports`.
- Plain ES modules and CSS under `modules/sports/ui/`, embedded by `host/src/package.rs`. No new
  crate and no new package dependency.

## Proof

| Claim                    | Check                                                                                                        | Result                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Pure rules are right     | 10 new node tests (23 in the folder)                                                                         | pass                                     |
| Package ships the screen | `the_package_ships_the_sports_screens` extended                                                              | pass in the package gate                 |
| Real screen, desktop     | Real HTTPS server, signed-in owner following NFL Dallas, NBA Lakers, NHL; live ESPN data; `/settings/sports` | follows, sources, standings render       |
| Phone size               | same, 390 by 844                                                                                             | single column, no overlap                |
| Search                   | searched real, united, city, fc, lakers                                                                      | live results grouped by league (GET 200) |
| Browse by confederation  | opened Browse leagues                                                                                        | US majors, Europe and the rest listed    |
| Unfollow                 | removed Cowboys                                                                                              | chip gone (DELETE 200, list reloaded)    |
| Standings save           | Select all then Clear all                                                                                    | 64 of 64 then 0 of 64 (PUT 200 both)     |
| Add a source             | opened the toggle                                                                                            | URL field and Check shown                |

No network response was intercepted or rewritten.

## Found and fixed

- A check box had no id, which broke focus restore after repaint. Fixed.

## Review rounds

Recorded on the task.

## Not proven

- **The partial-search notice live.** Searching real ESPN data never hit the cold-roster limit, so
  "Still covering more leagues" did not appear. It is covered by the node tests only.
- **Add and edit source against a real publisher, rebuild, photo opt-out.** Not run live, because
  that needs a real publisher feed and writes to it. Covered by node tests and route tests.
- **Story preferences.** The package has no story-feedback route, so the section is omitted.
- **Crests and icons from other sites.** The shared frame allows images only from its own origin,
  so initials and glyph fallbacks show. The browser logged the blocked ESPN logo loads.
- **The package live test.** It failed at the existing check for exactly one featured story with
  a real body (`sports_server.rs:469`), on live ESPN data. That check belongs to part 18 and does
  not touch this screen. Three live runs held the server for the browser proof and each reached
  that point. The package gate passed.
