# Rust phase 5, Meals part 35: Household, Log, settings and plan helpers

## What shipped

- Two new areas on the Meals screen: Household and Log. The tab strip now has five tabs.
- Household: people list, "Who eats together" rules (with more than one person), add, edit and
  remove with a confirmation. The self member has no Remove.
- Log: day navigation, totals, entries grouped by occasion, add, edit, re-estimate (Retry) and
  delete with a confirmation. Polls while visible. Empty state "Nothing logged".
- Settings page at `/settings/meals` (manifest `screens` plus the `settings` entry), opened from the
  header cog: Units (US or Metric) and the default Pantry mode for new plans.
- Plan helpers: Swap (choices screen), Move, Eaters, Text, and New plan. "Start a plan" on the
  empty week. A meal already written as text offers only Text.
- Ported from the TypeScript screens with no redesign. The CSS was already in place.
- App map: manifest navigation, settings and the `meals.screen` feature text updated.
- Package version 0.3.0, changelog updated. New files are bundled in `package.rs` and checked in
  the package test.

## Live proof

- Real shell server built from this worktree, signed Meals package installed, two accounts.
- Browser pass at 390 and 1280 wide: 60 of 60 checks passed. Household add, edit, invalid name,
  Escape, remove. Log add, edit, previous and next day, delete. Plan tools, Move, Eaters, Swap,
  Text. Settings saves for Units and Pantry mode. New plan form. Empty plan, Log and Household for
  the second person. Nothing intercepted or rewritten.
- `pnpm verify:static` passes every step except the migration-number check, which fails on another
  pull request (#4367, Meetings), not on this branch.
- `pnpm test:rust-meals` through the gate script at the final commit (1cacf02), exit 0: module tests
  111 passed (44, 16, 9, 11, 8, 22, 1), package tests 7 passed, installed-package tests 13 passed.
  The shell test `meals_server` is ignored outside the live gate, so the live pass above is its run.

## Fixes found by the live pass

- Editing a log entry right after adding it was refused as stale, because the background estimate
  moves the entry's revision. Save now re-reads the current revision first.
- Typing in the Text box never enabled "Save text". The screen now redraws on input.

## Not proven

- Swap choices were not written: the live server has no model for choices, so the screen showed
  Writing and no Choose button was exercised.
- Clearing text (which asks the model to rewrite the meal) and starting a plan to completion
  were not exercised for the same reason. The New plan form opens but was not submitted.
- The log estimate from the screen was not checked against a model. It stayed Estimating.
- On a phone, dialog buttons sit below the visible part of the tall frame until you scroll. The
  script clicked them directly. Part 34's dialogs behave the same way.
- The review fixes (one key per Add dialog, dropped late loads, no polling after leaving) came after
  the live pass and were checked by lint, the static gate and the package tests only, not live.
- Screenshots come from a scripted browser, and no check from a separate phone on the home network.
