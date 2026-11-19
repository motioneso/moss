# Rust phase 5, Meals part 34: the screen

## What shipped

- The Meals package serves its screen at `/meals` (manifest `screens` plus a `navigation` entry).
- Areas: Plan, Shopping list, Pantry (with Staples and item dialogs), and the recipe view.
  Empty, loading and broken states exist for each.
- New route `POST /meals/screen/tool` (signed-in) runs one Meals tool for a click on the screen.
- App map updated: manifest navigation, settings text and the `meals.screen` feature.
- Package version 0.2.0, changelog updated.

## Screen route security

- A click on the screen is the person's consent, so the route needs no chat approval.
- Destructive tools (household.remove, list.clear, log.delete, plan.delete) need a top-level
  `confirmed: true`, otherwise the route answers 409. The screen sends it only after its own dialog.
- Rows stay private to the signed-in person. The live test confirms a second person cannot read
  the first person's plan or Pantry, and a signed-out call gets 401.

## Live proof

- Real shell server built from this worktree, signed Meals package installed, two accounts.
- Browser pass at 1280 and 390 wide: plan, recipe and back, list, Pantry add, remove and Undo,
  Staples add and Escape, empty week and empty Pantry for the second person. 26 of 26 checks passed.
- Nothing intercepted or rewritten.

## Fixes found by the live pass

- The seeded meal had Safety pending, so the screen showed "Waiting". The seed now records a pass.
- On a phone the Undo bar sat below the visible area. It now sits in the page flow.

## Not proven

- Herdr's own browser tool is not installed here, so screenshots come from a scripted browser.
- Chat from inside the screen is not available in the frame; the screen shows a notice.
- No check from a separate phone over the home network.
