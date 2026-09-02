# Handoff: fix #2149 (recipe rebuild leaves recipeStatus "missing")

Worktree: `/home/ben/Jarv1s/.claude/worktrees/fix-2149-recipe-status`, branch `fix/2149-recipe-status`.
No commits yet — this is pure investigation handoff, first relay (relay1), nothing built.
Coordinator: Herdr agent named `coordinator` (codex, confirmed single live instance at handoff time).

## The bug (from issue #2149)

After a user confirms a "rebuild this source's recipe" action in chat for a legacy scrape source,
reading the source list back right after shows its recipe status still as "missing" instead of
"feed" or "ready" — even though the confirm step itself reported success. Seen in the real,
database-backed version of `tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`
(the FotMob fixture, "Moss previews and confirms a legacy scrape recipe rebuild" step).

## Where the write happens

Two places write the recipe status column, both in `packages/sports/src/source/repository.ts`:

1. `replaceRecipe` (~line 662-697) — the confirm path. Sets recipe status to "feed" or "ready"
   unconditionally when the user confirms a rebuild. Looks correct on its own.
2. `persistRuntimeResults` (~line 321-409) — a periodic health-check path that re-derives the
   recipe status every time it writes fresh health results for a source. The suspect formula, at
   line 386-393:

   ```
   const recipeStatus =
     source.retrieval_method === "feed"
       ? "feed"
       : assignments.some((a) => a.health_reason_code === "recipe_drift")
         ? "drift"
         : source.recipe_status === "missing"
           ? "missing"
           : "ready";
   ```

   This re-reads `source.recipe_status` from the same row it is about to overwrite, and just
   echoes "missing" back if that's what it currently is. The `source` row is read fresh
   (`.forUpdate()`, same transaction) right before this, so in a single, non-concurrent run this
   is a no-op — it can only ever preserve a value that's already committed as "missing", not
   invent one from nothing.

## What I ruled out (traced by hand, not verified against a live DB)

I spent most of this session tracing whether a **race** between the confirm-recipe write and a
concurrent call to `persistRuntimeResults` (triggered by a health refresh — `/api/sports/overview`,
or the client's periodic polling, hits `packages/sports/src/source/public-source-reader.ts`
`refresh()`, which calls `persistRuntimeResults` at the end) could explain a stale "missing" being
written back after a real confirm. Traced through:

- `persistRuntimeResults` filters incoming health results by `runtimeFingerprint` matching the
  source's *current* `recipe_fingerprint` (falling back to `validation_fingerprint`) before
  accepting them (`sourceAccepted` gate, ~line 348-375). A stale refresh started before confirm
  carries the *old* fingerprint, which should mismatch the post-confirm fingerprint and get
  filtered out with zero rows accepted, skipping the whole recipe-status rewrite.
- The initial `source` SELECT in `persistRuntimeResults` uses `.forUpdate()`, so under Postgres
  READ COMMITTED it blocks on a concurrent confirm's row lock and, once unblocked, reads the
  **latest committed** row — not a stale snapshot.
- Every interleaving I traced by hand (confirm blocks health-refresh, health-refresh blocks
  confirm, health-refresh commits first, confirm commits first) ends with confirm's unconditional
  `recipe_status: "ready"` as the last writer, or with the health-refresh's write filtered out by
  the fingerprint check.

**I could not construct a hand-traced interleaving that reproduces the bug.** That doesn't mean
the race isn't real — Postgres locking subtleties are easy to get wrong on paper — it means the
next step needs an actual reproduction, not more manual tracing.

## Recommended next step (don't re-derive the above, start here)

1. Write a small script or vitest test that opens **two real concurrent transactions** against a
   scratch Postgres (via the `verify-gate` skill's scratch DB, not the dev DB) — one simulating
   `confirmRecipeRebuild` → `replaceRecipe`, one simulating a `persistRuntimeResults` call using a
   *pre-confirm* snapshot (old fingerprint, old assignment ids) — and deliberately sequence them
   (e.g. with a manual lock-step using `pg_sleep` or explicit statement ordering) to see which
   interleavings, if any, actually land "missing" as the final row value. This makes the race
   real or rules it out with evidence instead of hand-tracing.
2. If no interleaving reproduces it: the bug is likely NOT concurrency. Re-check instead whether
   `confirmRecipeRebuild`'s response is actually awaited all the way through before the UAT test's
   next `listSources` call — e.g. a route handler or chat-tool wrapper that resolves the HTTP
   response before the DB transaction commits (a `withDataContext` transaction that commits
   *after* the function already returned would look exactly like this bug, deterministically,
   with zero raciness). Check `packages/sports/src/chat-tools.ts` `sportsConfirmSourceRecipeExecute`
   (~line 219-235) and however the chat-tool execution result gets awaited before the "Approve"
   http response returns, and the assistant-actions polling in the UAT spec's `confirmThroughMoss`
   helper (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts` ~line 204-243) for
   any point where a promise isn't awaited before the action is marked "confirmed".
3. Only once the actual mechanism is confirmed (race vs. ordering vs. something else), fix the
   root cause — not the read side. If it does turn out to be the `persistRuntimeResults` formula
   racing on a stale `source.recipe_status`, the fix is to stop using that field as its own input:
   derive "missing" from whether the recipe genuinely doesn't exist in the *fresh* row this same
   transaction just read (equivalent to `recipe_fingerprint IS NULL`, enforced by the
   `sports_custom_sources_recipe_shape_check` DB constraint in
   `packages/sports/sql/0191_sports_public_source_runtime.sql`), not from re-reading the column
   this function is about to write — but confirm the actual mechanism first.

## Reminders from the brief (still apply)

- Fix the root cause once, preserve module isolation and existing source-state rules (no admin
  bypass etc. — not touched by this area anyway).
- Add the smallest regression check for whatever the confirmed mechanism turns out to be.
- Run the `verify-gate` skill for focused verification (never run `pnpm verify:foundation` raw),
  plus the matched isolated database-backed UAT
  (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`) via the coordinate skill's
  UAT trigger map.
- Open a separate PR closing #2149. Do not touch `docs/coordination` or run repo-wide formatting.
- No plan has been approved by the coordinator yet — the coordinator has not seen a plan message
  from this lane. The successor should message the coordinator (Herdr agent name `coordinator`,
  re-verify exactly one live instance with `herdr agent list` before addressing it) with the
  reproduction result and proposed plan, and wait for approval before writing the fix, per
  `coordinated-build`.
