# Lane 1521 (1139-D) continuation — relay handoff

## Task
GitHub #1521 = child "1139-D — Keep private chat closed during focus refetch".
Spec: docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md, section
"Child 1139-D" only. Dependency 1139-C (#1520/PR #1666) is merged, so this is unblocked.
Branch 1521-keep-private-chat-closed-refetch, clean, even with origin/main. No boot file
existed on disk when this lane started (lost/never written) -- not a sign of a problem,
coordinator confirmed proceed.

## Status: still in the plan-build seams-check step. NO CODE WRITTEN YET.

## Coordinator
Herdr pane labeled "Coordinator" (re-resolve pane id fresh each time -- it reflows,
was w1:pH9, then w1:pHK). To reach it: herdr-pane-message skill,
`herdr agent prompt <fresh-coordinator-pane-id> "..."`.
Already confirmed once: go ahead and plan/build #1521 using the spec section as the brief.

A second question is queued with the coordinator right now (delivered, coordinator was
busy, message sat as "queued" — check herdr pane read on the coordinator's current pane
for the reply before deciding). The question, verbatim intent:

Two premise-drift findings versus the 2026-08-10 spec:

1. `apps/web/src/chat/chat-drawer.tsx` lines ~91-103 and ~440-447: fix #1780 (merged,
   commit c2b97ba3e / c6f3bafbf) already added a permanent `privateModeDecidedLocally`
   ref. `closePrivateChat` sets it to `true` synchronously before firing
   `endPrivateChat`, and the privacy-query success effect (lines 99-103) permanently
   no-ops once that ref is true (only a surface change resets it, chat-drawer.tsx:189-204).
   This means the exact race #30 in the spec describes -- a stale focus-refetch response
   landing after close and resurrecting `incognito:true` -- is ALREADY blocked as a side
   effect of #1780. It is not this child's remaining bug.

   What IS still missing: `closePrivateChat` (chat-drawer.tsx:440-447) never awaits
   `endPrivateChat`, never invalidates `queryKeys.chat.privacy`, and has no failure
   branch. If the end request fails server-side, the UI just silently claims "closed"
   forever with no way back to server truth. That's the real gap left to fix.

2. `apps/web/src/main.tsx:16-24`: the global QueryClient sets
   `refetchOnWindowFocus: false`, and the privacy `useQuery` in chat-drawer.tsx:93-97 has
   no per-query override. Grepped all of apps/web/src: no visibilitychange/focus listener
   anywhere touches this query (only packages/sports/src/web/sports-page.tsx:96 overrides
   refetchOnWindowFocus locally, unrelated). So a real browser focus event does NOT
   refetch this query today. The spec's named regression ("trigger a browser focus event
   whose privacy GET still returns true") can't exercise anything real without enabling
   focus refetch somewhere.

Proposed resolution (asked coordinator to confirm or redirect):
  (a) Add a NEW synchronous closing guard ref (distinct from the permanent
      `privateModeDecidedLocally`) so the success effect skips writes only while a close
      is actually in flight, not forever.
  (b) In `closePrivateChat`, await `endPrivateChat`, then in a `finally`: clear the new
      guard AND invalidate `queryKeys.chat.privacy(surface)` so the resulting refetch
      (success -> false, stays closed; failure -> whatever the server truth is) actually
      reaches the UI through the existing effect. Guard vs surface-change race: check
      `surfaceRef.current === initiatingSurface` before invalidating, matching the
      pattern already used in `startPrivateChat` (chat-drawer.tsx:402-438).
  (c) Add `refetchOnWindowFocus: true` to just the privacy `useQuery`, since the child
      issue's own title ("...during focus refetch") implies this query is supposed to
      refetch on focus -- otherwise there's nothing for the guard to guard against, and
      the spec's named e2e scenario has no real mechanism to exercise.

## Next steps for whoever picks this up
1. Check the coordinator's reply first (message was queued, not yet answered as of relay).
   If it says "yes to a/b/c" -- proceed as below. If it redirects (e.g. drop (c)), adjust
   the plan accordingly before writing code.
2. Write the plan-build plan at
   `docs/superpowers/plans/2026-08-20-1139-d-private-close-focus-refetch.md` per the
   `plan-build` skill (decisions/signatures/test-cases only, no function bodies). Exclusive
   surfaces per spec: the privacy-query-sync + `closePrivateChat` seam in
   `apps/web/src/chat/chat-drawer.tsx`, and one named scenario in
   `tests/e2e/chat-drawer.spec.ts` (grep existing tests there for the pattern -- e.g. the
   "private activation blocks send..." test at ~line 98, and "reloading the page restores
   private-mode..." at ~line 148, for the mockApi/page.route conventions already in use).
3. Message the coordinator with the plan path once written -- STOP and wait for approval,
   do not write code before that.
4. Build via TDD, commit per task with `Co-Authored-By: Claude` trailer, `git add` only
   the touched files (chat-drawer.tsx + the one e2e test file).
5. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin
   main && git rebase origin/main`, before every push.
6. `coordinated-wrap-up` skill for the PR: needs a live-path proof comment (real dev
   instance, real UI) per CLAUDE.md's Live-Path Gate -- this touches a user-facing
   surface (chat-drawer.tsx), so CI-green is not enough to merge.
7. Relay again if you hit the context-meter 70% warning or see a compaction summary --
   don't push through it.

## Things already verified true on this branch (don't re-derive)
- `endPrivateChat(surface?)`: apps/web/src/api/client.ts:976-979, POST
  `/api/chat/private/end`, returns void.
- `getChatPrivacyState(surface?)`: client.ts:981-986, GET `/api/chat/privacy`.
- `beaconEndPrivateChat()`: client.ts:988-990, sendBeacon fallback for tab-close, used by
  the `beforeunload` listener at chat-drawer.tsx:165-170 -- unrelated to this fix, don't
  touch.
- e2e mock for `/api/chat/privacy`: tests/e2e/mock-chat-api.ts:72-81, returns
  `{ incognito: state.incognito ?? false }`, a static value per test (tests override with
  their own `page.route` for dynamic behavior, which take precedence -- see comment at
  mock-chat-api.ts:59-61 on route-registration order).
- `git log --oneline` shows #1520/PR #1666 merged 2026-08-17; #1519/PR #1650 merged same
  day (fallback-identity fix, unrelated file region).

## Correction — the real handoff doc (found mid-relay via user message)

The handoff doc is NOT in this worktree. It lives in the main checkout, absolute path:
`/home/ben/Jarv1s/docs/coordination/handoff-1521-keep-private-chat-closed-refetch.md`
(worktrees don't share docs/coordination -- that's coordinator-owned and not checked out
per-lane). Read it directly with that absolute path. It confirms:
- Same spec section, same dependency (#1520/PR #1666 merged) -- matches everything above.
- Coordinator session id: `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad` (label "Coordinator").
- One collision note not previously known: **#1039** ("test: forceReplay vs purge behavior
  on private chat history") touches the same private-chat area and is queued to start
  AFTER this lane (#1521) lands. Not a current conflict -- just don't be surprised if a
  lane for #1039 shows up watching this file next.
- No collision with Workshop lanes (#1752/#1755/#1756).

Ben (or someone relaying through his message channel) also confirmed directly: proceed
as the build lane for #1521 using the spec section as the brief. This matches the
coordinator's earlier queued approval -- both point the same direction. The second
question (about the #1780 lock and refetchOnWindowFocus drift, section above) is still
open with the coordinator -- check for its reply before finalizing the plan, but it's
reasonable to draft the plan doc with proposal (a)(b)(c) while waiting, since redirection
would only mean dropping (c), a small edit.
