# Plan — 1139-E: Resume Settings export after remount

**Spec:** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md → "Child 1139-E —
Resume an export after remount" (~line 281-336).
**Issue:** Part of #1522.
**Risk tier:** routine.
**Exclusive surfaces:** `apps/web/src/settings/settings-profile-subviews.tsx` (`DataExport`),
one new scenario in `tests/e2e/settings-shell.spec.ts`.

## Seams check (file:line citations, this worktree)

- `DataExport` component, in-memory-only `jobId` state, no persistence:
  `apps/web/src/settings/settings-profile-subviews.tsx:59-89`.
- `ExportJobStatus.status` already includes `"expired"` — no shared-type change needed:
  `apps/web/src/api/client.ts:1400-1404`.
- `startDataExport`/`getDataExportStatus`/`getDataExportDownloadUrl` client fns, unchanged:
  `apps/web/src/api/client.ts:1407-1417`.
- `ApiError` carries `.status` for detecting 404: `apps/web/src/api/client.ts:177-184`.
- Existing guarded-storage precedent (`try/catch`, SSR-safe, prefixed key) to follow the same
  shape for: `apps/web/src/settings/settings-storage.ts:14-41`. Spec calls this key
  **component-private**, so it is NOT added to `SettingsStorageKey` — a new small local helper
  inlined in `settings-profile-subviews.tsx`, not exported from `settings-storage.ts`.
  `localStorage`-prefixed key convention example: `apps/web/src/calendar/calendar-page.tsx:37`
  (`moss.cal.view`) — same `moss.` prefix style, applied to `sessionStorage` instead.
- `tests/e2e/settings-shell.spec.ts:6-40` `mockSettingsApi` helper and `page.route` conventions
  already used for per-test API mocking; no changes needed there, only a new `test(...)` block
  using the same `mockApi`/`page.route` pattern.
- No `GET /api/me/export/active` route exists anywhere under `apps/api` (spec forbids adding one) —
  confirmed absent; not part of this build.

## Determinism boundary

Purely deterministic client state (a job id string) mirrored to `sessionStorage`; no model
involvement, no chat turns, no AI-authored content. N/A beyond that.

## Decisions

### Storage key

- Key: `moss.settings.export-job-id` (sessionStorage, component-private, not part of
  `SettingsStorageKey`).
- Helper functions, module-private to `settings-profile-subviews.tsx`:
  ```ts
  function readStoredExportJobId(): string | null
  function writeStoredExportJobId(jobId: string): void
  function clearStoredExportJobId(): void
  ```
  Each guards `typeof window === "undefined"` and wraps `sessionStorage` access in `try/catch`,
  matching `settings-storage.ts:14-41`'s fallback shape (return `null` / no-op on failure).

### Component behavior changes (`DataExport`, `settings-profile-subviews.tsx`)

- `useState<string | null>` for `jobId` initializes from `readStoredExportJobId()` (lazy
  initializer) instead of `null`.
- `startMutation.onSuccess`: call `writeStoredExportJobId(data.jobId)` in addition to
  `setJobId(data.jobId)`.
- `reset()` (bound to "Prepare a new export"): call `clearStoredExportJobId()` in addition to
  `setJobId(null)`.
- `statusQuery`: on a successfully resolved status of `"expired"`, or on the query's error being
  an `ApiError` with `status === 404` (or any error — "definitively unavailable" per spec — treat
  any non-404 `ApiError`/thrown error the same only if it is NOT a transient/network failure;
  scope this build to `ApiError` with `status === 404` as the concrete "definitively unavailable"
  signal, since that is the only status code the export API returns for a gone/foreign job),
  call `clearStoredExportJobId()` and `setJobId(null)` via a `useEffect` keyed on
  `statusQuery.data?.status` / `statusQuery.error`.
- Retry path (`isFailed` branch's "Try again" button): unchanged call order
  (`reset(); startMutation.mutate(undefined)`) still clears storage then repopulates it on the
  new `onSuccess`, satisfying "retry replaces the stored id."
- No new props, no new exports, no `GET /api/me/export/active`, no `localStorage`, no global
  export context — confirmed against the seams check above.

## Test case (new `test(...)` in `tests/e2e/settings-shell.spec.ts`)

Name: `"data export resumes across remount and clears on new/expired job"` (grep target for the
spec's required `--grep "export.*remount"`).

Behavior asserted, and why each would fail against the current in-memory-only implementation:

1. Mock `POST /api/me/export` → `{ jobId: "job-1", status: "pending" }`; mock
   `GET /api/me/export/status/job-1` → `{ jobId: "job-1", status: "building" }`. Click
   `Prepare export`; assert the building state renders. (Passes today — baseline.)
2. Navigate to another Settings category (e.g. click nav `Modules`), then back to
   `Account & preferences`, remounting `DataExport`. Assert the building state re-renders for
   `job-1` **without a second `POST /api/me/export`** (track requests via `page.on("request")`
   and assert count stays 1). **Fails today**: `jobId` resets to `null` on remount, so the
   component falls back to the `Prepare export` idle state instead of resuming.
3. Change the `status/job-1` route to return `{ jobId: "job-1", status: "ready" }`; assert the
   `Download` link's `href` targets `job-1` (`getDataExportDownloadUrl("job-1")`).
4. Click `Prepare a new export`, remount again (nav away/back). Assert the idle `Prepare export`
   state renders — the old `job-1` does not reattach. **Fails today only if storage was never
   cleared** — asserts `reset()` clears the persisted id, not just in-memory state.
5. Simulate a restored-but-gone job: reload with a stored id `job-2` (via
   `page.addInitScript`/`sessionStorage.setItem` before `goto`), mock
   `GET /api/me/export/status/job-2` → 404. Assert the component falls back to the idle
   `Prepare export` state (not stuck spinning) and that a subsequent read of
   `sessionStorage` for the export key is empty. **Fails today**: no such fallback exists (no
   persistence to fall back from), and without the clear-on-404 effect a resumed 404'd id would
   otherwise leave `jobId` set with no matching status data.

## Verification

```bash
pnpm exec playwright test tests/e2e/settings-shell.spec.ts --grep "export.*remount" > /tmp/1139e-focused.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`.

```bash
pnpm --filter web typecheck > /tmp/1139e-typecheck.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`. (Cross-check with root `pnpm typecheck` per the `pnpm-filter-typecheck-tsrootdir-false-red` memory if this one reads red.)

```bash
pnpm check:file-size > /tmp/1139e-filesize.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`.

Full gate (`pnpm verify:foundation`) only via the `verify-gate` skill's isolated-DB recipe, at
wrap-up.

## Kill gate

Single phase — no phase 2. If the focused Playwright scenario cannot be made to pass without
touching `findActiveJobForUser`, adding `GET /api/me/export/active`, or widening scope beyond the
`DataExport` component (i.e., the locked implementation in the spec turns out to be infeasible
against the real API contract), stop and escalate to the coordinator rather than improvising a
scope change. Call: coordinator.

## Exit criteria

- Focused Playwright scenario above passes.
- `pnpm --filter web typecheck` and `pnpm check:file-size` green.
- Full gate green on an isolated gate DB (wrap-up).
- PR open, rebased on `origin/main`, live-path proof posted.
