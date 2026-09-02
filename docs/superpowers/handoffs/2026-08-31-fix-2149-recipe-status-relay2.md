# Handoff: fix #2149 (recipe rebuild leaves recipeStatus "missing") — relay 2

Worktree: `/home/ben/Jarv1s/.claude/worktrees/fix-2149-recipe-status`, branch `fix/2149-recipe-status`.
Still no code fix committed. This relay found the real mechanism — start building, don't re-investigate.
Coordinator: Herdr agent named `coordinator`. Re-verify exactly one live instance with `herdr agent list`
before messaging it (per `coordinated-build`).

## The actual bug: not a database race, an ordering bug in the chat approval gateway

Earlier investigation (see `2026-08-31-fix-2149-recipe-status-relay.md` in this same folder) chased a
possible race between the recipe-confirm write and a concurrent health-refresh write in
`packages/sports/src/source/repository.ts`. That was a dead end — proven safe both by hand-tracing and
by an existing test (`tests/integration/sports-sources-repository.test.ts`, the test named "serializes
stale writes behind rebuild and assignment replacement source locks"). Do not re-open that line of
investigation.

The real bug is in the generic tool-approval flow, in `packages/ai/src/gateway/gateway.ts`, and it
affects every write tool that requires user confirmation in chat, not just sports:

1. User clicks Approve in chat. This calls `resolveActionRequest` (gateway.ts ~line 511-552).
2. `resolveActionRequest` writes the assistant-action's row status to `"confirmed"` and **commits that
   transaction** (line 544-546, `resolveAssistantAction`).
3. `resolveActionRequest` then calls `this.deps.confirmations.resolve(actionRequestId, status)`
   (line 550) — this only *signals* an unrelated in-flight promise; it does not run the tool.
4. Separately, the original chat-turn code path (`confirmAndRun`, gateway.ts ~line 695-796) has been
   sitting since before Approve was clicked, awaiting that exact signal at
   `const outcome = await pendingResolution;` (line 747).
5. Only after that signal arrives does `confirmAndRun` call `runHandler` (line 776), which is what
   actually runs the module's tool code — for sports, this is what finally calls
   `confirmRecipeRebuild` -> `replaceRecipe`, the write that sets `recipe_status` to `"feed"`/`"ready"`.

So there is a real, unguarded window between step 2 (the action row already reads "confirmed" to
anyone polling it) and step 5 (the tool's actual database write, which is what changes recipe_status).
The UAT's `confirmThroughMoss()` helper (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`
~line 204-243) polls `/api/ai/assistant-actions` until the action's status is `"confirmed"`, then the
test immediately calls `listSources()` — which can and does win that race, reading the row before
`replaceRecipe` has committed.

This is not sports-specific and not a one-off flaky race — it is structural: "confirmed" currently
means "user granted permission," not "the tool finished running." Every write-tool confirmation in
chat has this same window; sports recipe rebuild is just the one test that happens to assert on the
result immediately after seeing "confirmed."

## What I have NOT yet confirmed

- The exact shape of the assistant_actions status column/type (`AiAssistantActionStatus` — grep did
  not resolve before this relay; check `packages/ai/src/repository.ts` or wherever that type is
  declared, and the DB migration for the `app.ai_assistant_actions` table) — specifically whether a
  status value already exists for "confirmed and executed" (e.g. `"executed"`) distinct from
  "confirmed" (permission granted), or whether only pending/confirmed/rejected/cancelled exist.
- Whether `recordAudit`'s outcome ("success"/"failed", gateway.ts line 789-794) is stored on the same
  row and could be reused as the actually-done signal, or is write-only/audit-log-only and not
  readable via the same GET the UAT polls.
- Exactly which route serves `/api/ai/assistant-actions` (likely `packages/ai/src/routes.ts`) and what
  it currently returns as "status" — confirm it echoes the raw DB `status` column with no derived
  "done" field.

## Recommended fix direction (confirm against the code above before committing to it)

Root cause is that the poller (and everyone else) treats "confirmed" as terminal, but it isn't — the
tool run is still async at that point. Two candidate fixes, in order of preference:

1. **Preferred: make `resolveActionRequest` (or the call site) synchronously await the actual tool
   execution before returning "resolved" to the Approve endpoint**, and only persist the row's final
   status once the tool handler has actually finished (e.g. write "confirmed" AND drive the handler run
   in the same call, updating status to a terminal executed/failed state afterward, rather than
   signalling a separate already-running waiter to do it later). This removes the window entirely
   instead of narrowing it. Needs care: `confirmAndRun`'s waiter (`pendingResolution`) is also what
   drives the live chat SSE stream (`action_result` events) — don't break that notification path while
   collapsing the timing gap.
2. **Fallback if (1) turns out to be a large refactor for one session:** add a real terminal state
   (e.g. `"executed"`/`"failed"`) that `runHandler`'s completion writes, distinguish it from
   `"confirmed"` in the DB and in the GET route's response, and update the UAT's polling helper
   (`confirmThroughMoss`) to wait for that terminal state, not for `"confirmed"`. This fixes the
   *observable* problem exactly but leaves the same ordering hazard for any other caller (chat UI,
   other tests, real users refreshing a page right after clicking Approve) who might still read
   "confirmed" during the window and see stale data — weigh this against the brief's "fix the root
   cause once, not the observed assertion" instruction before choosing this path.

Given the brief's explicit instruction to fix the root cause, option 1 is preferred unless it proves
too large for one session — in which case stop and report a concrete split to the coordinator instead
of half-implementing it, per the boot brief's "if too large, stop with a concrete split" instruction.

## Regression check

Whichever fix lands, the smallest regression check is an integration test in `tests/integration/`
(pattern: see `tests/integration/sports-sources-repository.test.ts` for the `withDataContext` +
`resetFoundationDatabase` + `DataContextRunner` pattern already used in this repo) that: creates a
pending write-tool action, resolves it via the gateway's confirm path, and asserts that by the time the
resolve call/response completes, the underlying tool's database write has already committed (i.e. no
separate poll-and-wait is needed to observe the effect) — using the sports recipe-rebuild path as the
concrete tool under test, or a smaller synthetic tool if the gateway is more directly testable that way.

## Reminders from the brief (still apply)

- Fix the root cause once. Preserve module isolation and existing source-state rules.
- Run the `verify-gate` skill for focused verification (never run `pnpm verify:foundation` raw), plus
  the matched isolated database-backed UAT
  (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`).
- Open a separate PR closing #2149. Do not touch `docs/coordination` or run repo-wide formatting.
- No plan has been approved by the coordinator yet. Message the coordinator with this finding and a
  proposed plan, and wait for approval before writing the fix, per `coordinated-build`.
- Plain English in every message to the coordinator and any spawned agent — name what things do, not
  what the repo calls them, keep jargon out of chat/status/handoffs (global CLAUDE.md rule).
