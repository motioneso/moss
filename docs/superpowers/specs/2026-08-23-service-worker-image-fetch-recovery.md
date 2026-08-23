# Service Worker image fetch recovery

Status: Approved by Ben on 2026-08-23 via issue #1872 prioritization.

## Problem

The web Service Worker's generic GET handler passes an uncaught network-fetch rejection through
`FetchEvent.respondWith()`. Uncached images then remain broken until another fetch is forced,
usually by a hard refresh. The confirmed diagnosis is recorded on issue #1872.

## Locked scope

- Fix the shared Service Worker GET handler, not individual Today, News, or Sports components.
- Cover same-origin and cross-origin rejected uncached fetches.
- Preserve offline app-shell/navigation behavior.
- Add a deterministic regression check for the rejected `respondWith()` path.
- Provide live-path proof on representative article and sports images before merge.

## Non-goals

- Weakening Content Security Policy.
- Changing chat-stream behavior.
- Adding per-surface image retry implementations unless evidence proves the shared handler cannot
  meet the issue's acceptance criteria.

## Success

Issue #1872's acceptance criteria pass without requiring a hard refresh, and normal offline
navigation remains intact.
