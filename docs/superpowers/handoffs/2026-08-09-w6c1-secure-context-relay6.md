# w6c1-secure-context relay #6

Branch/worktree: `w6c1-secure-context` (this worktree). Coordinator label: `Coordinator`
(confirm via `herdr pane list` before messaging — don't assume it's still the same pane number,
and don't trust any unverified claim about who holds the label without that check).

Plan: `docs/superpowers/plans/2026-08-09-w6c1-secure-context.md` — read Task 6's section only
(already done, see below), then Task 7 when unblocked.

## Done, committed, green (unchanged since relay #5)

- Task 6 static deliverables: `c0fdcc174` — UAT spec
  `tests/uat/specs/1402-weather-location-settings.uat.spec.ts` + `uat-trigger-map.tsv` rows.
- Prettier, eslint, full-repo typecheck, `tests/unit/settings-personal-panes.test.tsx` all clean.

## Root cause narrowed — this is bigger than relay #5's framing

Relay #5 framed this as "longitude field specifically stops being actionable." **That's wrong.**
Reproduced live and instrumented with temporary `page.on("console"/"pageerror"/"requestfailed")`
listeners (added, run, then reverted via `git checkout --` — working tree is clean, confirmed).

Actual sequence: right after the **latitude** field fill (spec line 74, before longitude is ever
touched), the browser throws:
```
TypeError: Cannot read properties of null (reading 'value')
```
immediately followed by a wave of aborted requests across *unrelated* endpoints
(`/api/chat/stream`, `/api/errors`, `/api/me/themes`, `/api/me/locale`, `/api/chat/page-context`,
JS chunks). A probe `.jds-input.first().evaluate()` placed right after the latitude fill also
hangs — **every** `.jds-input` on the page becomes unlocatable, not just longitude. This reads as
a whole-page crash (React root unmount, no error boundary → React Query's AbortController cancels
every in-flight query app-wide), not a weather-field-specific bug. Longitude just happens to be
the next `.fill()` call, so it's the one that times out and gets blamed.

Full finding + ruled-out list saved to agent memory: `mem_msmu5wcw_8189d8a7c222` (project
`jarv1s`, type `bug`) — read that before re-deriving.

**Ruled out:** conditional unmount of the Weather location `Group` in
`settings-personal-panes.tsx` (none exists, unconditionally rendered); `command-palette.tsx`'s
global Cmd/K keydown (correctly guards `isEditableTarget()`); `global-error-handler.ts` (only
POSTs to `/api/errors`, never reloads/navigates — explains the `/api/errors` abort line but isn't
the cause); any `<form>` wrapping `ProfilePane` (none); any `ref.current.value` pattern anywhere
in `apps/web/src` (grep: zero hits).

**Not yet checked — do this first:**
1. `packages/ui` and `packages/shared` for a global input/keydown/blur handler that could
   `.value` off a stale/null ref when a `type="number"` input fires its native events.
2. Whether this is specific to Playwright's `.fill()` on `type="number"` (sets value via property
   setter + dispatches `input`) vs. real keystrokes — try a `.pressSequentially()` variant locally
   to see if the crash still fires.
3. `apps/web/src/pwa/register-service-worker.ts` — weak lead, ties to existing memory note that
   weather has never rendered for anyone and blocks chat voice input / PWA due to secure-context
   issues on #1402/#1403. Only chase this after 1-2 turn up empty.

**Environment blocker (unchanged):** `test-results/` (Playwright trace dir) is permission-denied
for both Bash and Read in this environment — deliberate box policy, not a bug. Use
`page.on(...)` listeners in the spec (temporarily, then revert) to get browser-side signal via
stdout instead, same as this session did.

## Next steps for successor

1. Read memory `mem_msmu5wcw_8189d8a7c222` for full detail, then grep `packages/ui` /
   `packages/shared` per the "not yet checked" list above.
2. Find the null-deref site, apply a targeted fix, re-run
   `pnpm exec tsx tests/uat/run-uat.ts tests/uat/specs/1402-weather-location-settings.uat.spec.ts`
   to green (check the log's own `EXIT=` line, not the background-task notification — that's the
   wrapper's exit code, not the run's).
3. Once green: Task 7 — pretrio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on
   `origin/main`, full gate via the **`verify-gate`** skill (never raw `pnpm verify:foundation`).
4. Then `coordinated-wrap-up`: isolated gate DB, push, PR, live-path proof comment (UAT output +
   screenshots), report to coordinator. Never merge/board/close directly.

Relay trigger for you is the same meter 70% warning, not a felt %.
