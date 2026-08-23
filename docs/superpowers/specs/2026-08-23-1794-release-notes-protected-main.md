# Release notes through protected main (#1794)

**Status:** Approved by Ben on 2026-08-23 by directing the coordinator to pick up #1794.

## Outcome

User-facing release notes remain grouped by Pacific calendar date and reach `main` through the
normal protected-branch pull-request path. The automation never pushes directly to `main`.

## Required behavior

- The first usable release note on a Pacific date creates that date group.
- Later notes on the same date append without replacing earlier entries.
- `Added`, `Fixed`, and `Changed` remain grouped within each date.
- `Category: N/A` produces no entry.
- Concurrent merges cannot silently drop notes.
- Automation creates or updates a release-note branch and pull request; protected `main` remains
  untouched until that pull request passes CI and merges normally.

## Verification

- A focused self-check covers first note, same-day append, later date, and `N/A`.
- A concurrency check proves two inputs do not lose either note.
- A real merged test pull request produces or updates the release-note pull request, which passes
  CI without an admin bypass or direct push.

## Non-goals

- A release-notes service, database, queue, or new dependency.
- Changing the pull-request release-note schema.
