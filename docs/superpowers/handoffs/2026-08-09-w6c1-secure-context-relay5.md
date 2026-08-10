# w6c1-secure-context relay #5

Branch/worktree: `w6c1-secure-context` (this worktree). Coordinator label: `Coordinator`
(confirm via `herdr pane list` before messaging — don't assume it's still the same pane number).

Plan: `docs/superpowers/plans/2026-08-09-w6c1-secure-context.md` — read Task 6's section only
(already ~done, see below), then Task 7 when unblocked.

## Done, committed, green

- Task 6 static deliverables: `c0fdcc174` — new UAT spec
  `tests/uat/specs/1402-weather-location-settings.uat.spec.ts` + two `blocking` rows in
  `.claude/skills/coordinate/uat-trigger-map.tsv`.
- Prettier, eslint, full-repo typecheck, and `tests/unit/settings-personal-panes.test.tsx` all
  pass clean.

## Blocking: live UAT run fails, not yet root-caused

`pnpm exec tsx tests/uat/run-uat.ts tests/uat/specs/1402-weather-location-settings.uat.spec.ts`
→ real exit 1 (log's own `EXIT=1` line — the background-task notification claimed exit 0, that's
the wrapper's code, not the run's; known trap, don't trust it).

Failure — test 1 (`manual override persists across reload...`), at spec line 75:
```
await page.getByLabel("Weather location longitude").fill(OVERRIDE_LON);
```
```
Test timeout of 60000ms exceeded.
Error: locator.fill: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByLabel('Weather location longitude')
```
Label (line 73) and latitude (line 74) fills on the SAME three fields succeed immediately before
this. All three fields were also already read via `.inputValue()` a few lines earlier in the same
test (lines 68-70), proving they exist and are queryable at test start. So the longitude input
specifically stops being actionable between the latitude fill and the longitude fill.

Ruled out: `ProfilePane`'s "Weather location" `Group` in
`apps/web/src/settings/settings-personal-panes.tsx` is unconditionally rendered — no
error-boundary/early-return could be hiding it.

Not yet ruled out / prime suspect: the `weatherLocationLoaded`-ref-guarded `useEffect` in the same
file that syncs server data into local form state exactly once on load. If it fires mid-test
(e.g. a slow initial query resolving between the label and longitude fills) it could re-render the
inputs. Re-render alone shouldn't cause "waiting for locator" (that reads as element genuinely
absent/detached, not just value-reset) — but a full unmount/remount of the `Group` (e.g. a loading
state briefly swapping in a skeleton) would explain it. Read that effect and the query's loading
branch before touching anything else.

**Environment blocker**: `test-results/` (Playwright's trace/error-context output dir) is
permission-denied for both `Bash` (`ls`/`find`) and the `Read` tool in this environment — can't
inspect the trace directly. If this is still blocked for you, ask the coordinator whether a
different tool/session can pull it, rather than burning turns retrying the same denied path.

## Next steps for successor

1. Read `apps/web/src/settings/settings-personal-panes.tsx` around the weather-location query/effect
   (search for `weatherLocationLoaded`, `weatherLocationQuery`) — check for a loading-state branch
   that could unmount the `Group`'s inputs.
2. If found: this is a real Task 4-5 bug, out of Task 6's original scope but blocking its live proof
   — fix it (small, targeted) and re-run.
3. If not found: try re-running the same UAT spec once more to check flake vs. deterministic. If
   deterministic, consider whether the spec itself should wait for network-idle /
   `weatherLocationQuery` to settle before starting to fill (e.g. `await
   expect(page.getByLabel(...)).toBeEnabled()` or a brief `waitForLoadState('networkidle')`) before
   assuming an app bug.
4. Once `1402-weather-location-settings.uat.spec.ts` passes live (exit 0), proceed to Task 7:
   pretrio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`, then the
   full gate via the **`verify-gate`** skill (never raw `pnpm verify:foundation`).
5. Then `coordinated-wrap-up`: isolated gate DB, push, PR, live-path proof comment (UAT output +
   screenshots), report to coordinator. Never merge/board/close — coordinator only.

Relay trigger for you is the same meter 70% warning, not a felt %.
