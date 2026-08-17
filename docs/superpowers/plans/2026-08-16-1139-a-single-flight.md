# Plan — #1139-A / #1518: Make chat action resolution single-flight

**Spec:** `docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md`, "Child 1139-A" section
(lines 78-137). **Issue:** #1518 (`task`, open). **Risk tier:** routine. **Branch:**
`1139-a-single-flight`.

## Seams check (file:line citations)

- Component under change: `apps/web/src/chat/action-request-card.tsx:38-56` — hand-written
  `resolve` async function backed by `useState<"pending"|"loading"|"done"|"error"|"expired">` and a
  separate `useState<"confirmed"|"rejected"|null>` for decision. Both writable independently — the
  gap the spec targets. Confirmed still present on this branch (not already fixed).
- `useMutation` primitive already used identically elsewhere in this module:
  `apps/web/src/chat/message-row.tsx:286-305` (`createMutation`/`undoMutation`, `mutationFn` +
  `onSuccess`, `disabled={mutation.isPending}`) and `apps/web/src/chat/chat-drawer.tsx:108`
  (`resumeMutation`). Import source: `@tanstack/react-query` (already a project dependency, see
  `apps/web/src/chat/message-row.tsx:1`).
- `resolveActionRequest`, `apps/web/src/api/client.ts:966-975` — `Promise<void>`, so the mutation's
  settled decision must come from the mutation's own return value, not the API call's return value
  (matches spec: "returns that decision so the settled UI derives its label from mutation data").
- `ApiError`, `apps/web/src/api/client.ts:177-185` — carries `.status`. The current 409/expired
  detection (`action-request-card.tsx:47-50`) string-matches `message.includes("expired")`. Since
  the whole `resolve` function is being rewritten onto `useMutation` anyway, detect expired via
  `error instanceof ApiError && error.status === 409` instead — the signal the `#1250` comment
  already names ("server returns 409 for expired requests"), and more robust than message-text
  matching. No behavior-visible change (same copy, same states).
- Focused e2e coverage lives in one exclusive block: `tests/e2e/app-shell.spec.ts:317-432`
  (`test.describe("Chat drawer — Approve/Reject card", ...)`). Confirmed/rejected/transmitted-body
  assertions exist today (lines 372-378, 425-431). **Drift from spec text:** no `expired` assertion
  exists anywhere in `tests/e2e/` today (grepped repo-wide) — the spec's "retain the existing ...
  expired ... assertions" overstates what's there. Net effect is unchanged (final suite must cover
  confirmed/rejected/expired/transmitted-body plus the two new single-flight/unmount cases) so this
  is noted here rather than escalated; nothing to re-scope.
- Route-hold-then-release pattern already used for this exact kind of test:
  `tests/e2e/chat-drawer.spec.ts:681-699` (`gate` object + `Promise<void>` released mid-test).
  Reused for "hold the resolve route open."
- Drawer unmount mechanism: `apps/web/src/chat/chat-drawer.tsx:43,439-443` (`onClose` wired to the
  "Close chat" button) + proof it actually unmounts: `tests/e2e/chat-drawer.spec.ts:646-651`
  ("renders null" when closed). Reused for "unmount the drawer before releasing."
- `tests/unit/action-request-card-preview.test.tsx` — server-`renderToString` only, no
  `resolve`/mutation path exercised (confirmed by read). Spec's "keep it green, edit only if the
  rendered state contract truly changes" — the rendered contract (labels, DOM structure, initial
  `data-state="pending"`) is unchanged by this refactor, so **no edit planned**; will re-run as a
  regression check only.

## Determinism boundary

N/A — no model-authored content involved. This is deterministic client mutation-state wiring
against a real REST endpoint; the resolve decision is always exactly what the user clicked and what
the server actually accepted, never inferred.

## Decisions (signatures, not bodies)

`apps/web/src/chat/action-request-card.tsx`:

- Imports: add `useMutation` from `@tanstack/react-query`; add `ApiError` to the existing
  `../api/client` import. Drop `useState` (no remaining local state). Keep `useEffect`, `useRef`.
- Replace both `useState` calls with:
  ```ts
  const admittedRef = useRef(false); // synchronous double-click guard, not React state
  const mutation = useMutation<"confirmed" | "rejected", unknown, "confirmed" | "rejected">({
    mutationFn: (next) => resolveActionRequest(props.actionRequestId, next).then(() => next),
    onSettled: () => {
      admittedRef.current = false;
    }
  });
  ```
- Admission guard, replacing the old `resolve`:
  ```ts
  function handleResolve(next: "confirmed" | "rejected") {
    if (admittedRef.current) return;
    admittedRef.current = true;
    mutation.mutate(next);
  }
  ```
  Called from both buttons' `onClick` in place of `() => void resolve(...)`. Writing
  `admittedRef.current` after unmount is a plain ref mutation (no React warning); no
  `isMounted`/`AbortController` added, per spec.
- Derived values (replace `isLoading` and the old `decision`/`status` reads):
  ```ts
  const isExpired =
    mutation.isError && mutation.error instanceof ApiError && mutation.error.status === 409;
  const errorMessage = mutation.isError
    ? isExpired
      ? "This request expired — ask again."
      : mutation.error instanceof Error
        ? mutation.error.message
        : "Could not resolve"
    : null;
  ```
- Eyebrow label: `data-state={mutation.isSuccess ? mutation.data : "pending"}`; text
  `mutation.isSuccess ? (mutation.data === "rejected" ? "Not approved" : "Approved") : "Needs your approval"`.
- Action-area render order (mirrors current ternary, driven by mutation state instead of local
  `status`):
  1. `mutation.isPending` → `Resolving…` (unchanged JSX/copy), no buttons.
  2. `mutation.isSuccess` → nothing (eyebrow already shows the result).
  3. `isExpired` → `<p className="form-error">{errorMessage}</p>`, no buttons (unchanged copy).
  4. else (idle, or a non-expired error) → Approve/Reject buttons (`onClick` calls
     `handleResolve(...)`) plus `{errorMessage ? <p className="form-error">{errorMessage}</p> : null}`
     for the retryable-error case (unchanged copy/behavior).
- Focus-on-settle effect: dependency array becomes `[mutation.isSuccess, mutation.isError]`;
  condition `mutation.isSuccess || mutation.isError` (covers both the plain-error and expired cases,
  matching current `"done" || "error"` behavior — expired was already a member of the old `"error"`-ish
  focus set via the separate `"expired"` status, which was NOT in the old effect's condition; **this
  is a one-line behavior addition**: expired resolutions will now also receive focus, consistent with
  "existing focus-on-success/error behavior stays" reading error broadly rather than reproducing the
  old omission as a bug).

## Test cases to add (behavior + why they'd fail against the current/broken code)

All added inside the existing `test.describe("Chat drawer — Approve/Reject card", ...)` block in
`tests/e2e/app-shell.spec.ts`, following the same `mockApi` + SSE `action_request` event setup as
the existing two tests (lines 317-360 pattern, reused as scaffolding).

1. **"a same-task double click on Approve sends exactly one resolve request"** — hold
   `**/api/chat/action-requests/*/resolve` open behind a `Promise`/`gate.resolve` (pattern from
   `chat-drawer.spec.ts:681-699`), count intercepted requests. Inside `page.evaluate`, look up the
   Approve `<button>` in `.action-request-card` and call `.click()` on it twice synchronously (same
   JS task — no `await` between calls) so both handler invocations race the same pre-mutate tick.
   Assert: exactly one resolve request received; while held, `.action-request-actions` is not
   present and `Resolving…` is visible; `[data-state="confirmed"]` is not present. Release the gate;
   assert `[data-state="confirmed"]` renders `"Approved"` exactly once.
   _Why it fails today:_ the old code's only ordering guard was `setStatus("loading")`, a React
   state update — not synchronous — so a second click fired in the same task before the first
   render commit reads `status === "pending"` too and calls `resolve` again, sending two requests.
2. **"unmounting the drawer while a resolution is pending raises no console or page error"** —
   register `page.on("console", ...)`/`page.on("pageerror", ...)` collectors before navigation. Hold
   the resolve route open, click Approve once, then click "Close chat" (unmounts per
   `chat-drawer.tsx:439-443` / proof at `chat-drawer.spec.ts:646-651`) while the request is still
   pending, then release the held route. Assert the collected error arrays are empty after release.
   _Why it fails today:_ the old code's `.catch`/`.then` continuation calls `setStatus`/`setDecision`
   unconditionally after `await`, which is a no-op post-unmount in React 18 (batched, warning-free)
   for a **single** in-flight call — this test is guarding the _combination_ the spec calls out
   (unmount-safety of the admission ref specifically), so it must pass against the new code and
   would be the regression net if a future edit reintroduces an unmount-unsafe write (e.g. a second
   ref/flag guarded incorrectly).
3. Keep test 1 (existing, "renders Approve/Reject card and resolves on Approve") and test 2
   (existing, "Reject resolves the card") as-is — they already cover confirmed, rejected, and
   transmitted-body.
4. **New: "an expired (409) resolution shows the expiry message and no retry controls"** — mock
   `**/api/chat/action-requests/*/resolve` to `route.fulfill({ status: 409, ... })` with a JSON body
   matching the real error-body shape `readErrorBody` expects (check
   `apps/web/src/api/client.ts` around `readErrorBody` for the exact field name before writing this
   fixture). Click Approve once. Assert `"This request expired — ask again."` is visible and no
   `Approve`/`Reject` buttons are present afterward.
   _Why it fails today:_ this exact copy/state already exists in the current component, so this
   test is new regression coverage (the "drift" noted in the seams check), not a red-then-green
   TDD case against broken code — write it, confirm it passes against the new mutation-based
   `isExpired` derivation, and treat a red result here as a bug in the new code, not an expected
   starting point.

## Verification commands

```bash
cd /home/ben/Jarv1s
pnpm exec vitest run tests/unit/action-request-card-preview.test.tsx > /tmp/1139a-unit.log 2>&1; echo "EXIT=$?"
# expected: EXIT=0, all existing assertions green, unchanged.

pnpm exec playwright test tests/e2e/app-shell.spec.ts --grep "Approve/Reject card" > /tmp/1139a-e2e.log 2>&1; echo "EXIT=$?"
# expected: EXIT=0, 5 tests passing (2 existing + 3 new: single-flight, unmount-safe, expired).

pnpm format:check > /tmp/1139a-fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1139a-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1139a-tc.log 2>&1; echo "EXIT=$?"
# expected: EXIT=0 each, pre-push trio.
```

Full gate (`pnpm verify:foundation` via the `verify-gate` skill's isolated-DB recipe) runs once at
`coordinated-wrap-up` time, per that skill — not repeated here.

## Live-path artifact

Per the spec's "Live-path artifact" section: a #1000 ephemeral live instance, real login, reload,
open the default chat drawer, double-click Approve on one real pending action request, show the
real resolve endpoint reaches one terminal decision. This requires a genuine write-tier tool call to
produce a real `app.ai_assistant_action_requests` row — confirmed (`packages/ai/src/repository.ts:1728`)
this is a persisted server-side table, not something the mocked e2e "example.write" tool (test-only
fixture, no production equivalent — grepped, not found outside `tests/e2e/`) can produce. The
scripted `tests/uat/specs` harness has no chat-capable AI provider at any seed level (confirmed
precedent: `1264-settings-self-operation.uat.spec.ts` and `1311-install-grant.uat.spec.ts` file
headers, both citing the same gap, #1121) — so this is **not** planned as a new
`tests/uat/specs/*.uat.spec.ts` file or `uat-trigger-map.tsv` row; it follows the spec's own
explicit instruction (a live walkthrough on a real ephemeral instance) instead, done at
`coordinated-wrap-up` time. If no live instance with a real configured AI provider is reachable at
that point, report honestly per the live-path-gate rule: code-complete, unverified, and say
specifically what's missing — do not fabricate or skip the proof silently.

## Kill gate

Single-phase build (one component, one test file). Kill/escalate condition: if the same-task
double-click (test 1) cannot be made deterministic in Playwright — i.e., the two synchronous
`.click()` calls inside `page.evaluate` still sometimes produce 2 requests even against the new
`admittedRef` guard after a few reruns — stop and escalate to the coordinator with the failure
output; that would mean the admission-guard design itself (not the test) is wrong, a fork the spec
didn't anticipate. Owner: build agent first pass, coordinator if the design fork is real.

## Rulings ledger

- Expired-detection changed from string-match (`message.includes("expired")`) to status-code check
  (`ApiError.status === 409`) as part of the mutation rewrite. Decision, not a deviation requiring
  sign-off: same external behavior/copy, strictly more robust signal, and the code performing the
  check is being rewritten anyway.
- Focus-on-settle effect now also fires for the expired case (previously omitted from the old
  effect's `"done" || "error"` condition, since `"expired"` was a third status value). Read as
  completing "existing focus-on-success/error behavior stays" rather than reproducing a narrower
  omission; flagged here in case a reviewer disagrees and wants the old omission preserved.
- No new UAT spec file planned (see Live-path artifact section) — precedent from #1264/#1311 shows
  the harness structurally can't drive a real write-tier tool call; the spec's own instructions
  already point at a live-instance walkthrough instead.
