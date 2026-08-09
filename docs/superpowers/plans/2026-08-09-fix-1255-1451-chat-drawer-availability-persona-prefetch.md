# Fix #1255 + #1451 — chat drawer availability gate + persona prefetch

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md`, lane D (routine
tier, `apps/web` only). Base `origin/main` = `c8946358f`, re-verified current (no commits touching
`apps/web/src/api/use-assistant-name.ts`, `apps/web/src/chat/chat-drawer.tsx`, `apps/web/src/app.tsx`,
or `apps/web/src/api/client.ts` since).
**Task issue:** Part of #1470 (tracking epic, spec line 5). Direct issues: #1255 (bug, sev:minor),
#1451 (task, sev:cosmetic).
**Owned files (exclusive to lane D):** `apps/web/src/api/use-assistant-name.ts`,
`apps/web/src/chat/chat-drawer.tsx`. Also touches `apps/web/src/app.tsx` (unowned top-level shell,
no other lane claims it) and `apps/web/src/api/client.ts` (shared, edit is additive/isolated to
`getPersonaSettings`). Does not touch `today-page.tsx`, `onboarding/skip-confirm.tsx`,
`shell/app-shell.tsx` (lane A), `packages/chat/src/live/*` (lane B), `module-sdk`/shared api types
(lane C).

## Seams verified (file:line)

- `chatRouteQuery` already exists and fetches the router's capability answer —
  `apps/web/src/chat/chat-drawer.tsx:166-171` (`queryKeys.ai.capability("chat")` →
  `lookupAiCapabilityRoute("chat")`). No new endpoint needed.
- Response shape: `LookupAiCapabilityRouteResponse.route: AiCapabilityRouteDto` with
  `readonly available: boolean` — `packages/shared/src/ai-types.ts:73-78,263-265`.
- Current gate reads install state instead: `chatAvailable = hasConnectedProvider(onboardingStatusQuery.data)`
  — `chat-drawer.tsx:173`.
- `onboardingStatusQuery` has exactly 3 uses in the file: declaration `chat-drawer.tsx:160-165`,
  the `chatAvailable` line above (`:173`), and `onboardingStatusQuery.isSuccess && !chatAvailable`
  at `:494`. `hasConnectedProvider`/`getOnboardingStatus` have no other use in this file (grep
  confirmed) — both imports (`chat-drawer.tsx:13`, `:31`) are safe to drop; `isNoActiveChatModelError`
  on the same import line (`:31`) stays, it's used at `:237`.
- Exported pure-fn pattern to mirror: `recordsFromMessages`, `chat-drawer.tsx:638`, tested
  mount-free in `tests/unit/chat-drawer-activity.test.tsx:6,58` (`import { recordsFromMessages }
from "../../apps/web/src/chat/chat-drawer.js"` — note the `.js` extension on a `.tsx` source file,
  required by this repo's module resolution).
- `useAssistantName` — `apps/web/src/api/use-assistant-name.ts:11-18` — already correct, reads
  `queryKeys.settings.persona` (`apps/web/src/api/query-keys.ts:23`) via `getPersonaSettings`
  (`apps/web/src/api/client.ts:343-345`, currently unbounded `requestJson`). No logic change needed
  in this file.
- App shell query-gate pattern to extend: `apps/web/src/app.tsx` — `meQuery` declared `:81-85`,
  last pre-shell early-return is the `!meQuery.data` `FatalState` branch `:196-203`, the
  onboarding/shell branch starts `:205` (`if (activeForOnboarding) {`). `getPersonaSettings` and
  `queryKeys` are not yet imported in this file (current import block `:7-14`, `:16`).
- Timeout pattern to mirror for `getPersonaSettings`: `getOnboardingStatus`,
  `apps/web/src/api/client.ts:487-501` (`ONBOARDING_STATUS_TIMEOUT_MS = 4000`, `AbortController` +
  `setTimeout` + `finally { clearTimeout }`, `signal` passed through — `requestJson`'s
  `ApiRequestOptions` extends `RequestInit` so `signal` is already accepted, `client.ts:187-190`).
- Other callers of `getPersonaSettings`: only `apps/web/src/settings/settings-ai-pane.tsx:8,66`
  (a settings-editor query). A 4s bound only turns an unbounded hang into a bounded failure for
  that caller too — no adverse effect. **Open decision from the handoff doc is resolved: bound it.**
- No existing test file covers this gate or the persona-prefetch boot path
  (`tests/unit/onboarding-chat-availability.test.ts` tests `hasConnectedProvider` itself, stays
  untouched).

## Determinism boundary

Not applicable — neither fix touches model output or chat turns. Both are query-plumbing/UI-gate
changes over deterministic REST responses.

## Design-system audit

N/A — no new markup, no new classes. Both tasks are logic/query changes only (Task 1 deletes a
branch condition's source query and swaps a boolean expression; Task 2 adds a query + an early
return that already reuses the existing `<LoadingScreen />`).

## Task 1 — #1255: gate on model availability, not install state

File: `apps/web/src/chat/chat-drawer.tsx`.

1. Add a new exported pure function (placed near `recordsFromMessages`, `:638`):
   ```ts
   export function chatAvailableFromRoute(
     data: LookupAiCapabilityRouteResponse | undefined
   ): boolean {
     return data?.route?.available === true;
   }
   ```
   Import `LookupAiCapabilityRouteResponse` as a type from `@moss/shared` alongside the existing
   `ChatAttachmentDto, ChatMessageDto, LocaleSettingsDto` type import (`:24`).
2. Replace `chatAvailable = hasConnectedProvider(onboardingStatusQuery.data)` (`:173`) with
   `chatAvailable = chatAvailableFromRoute(chatRouteQuery.data)`.
3. Replace `onboardingStatusQuery.isSuccess && !chatAvailable` (`:494`) with
   `chatRouteQuery.isSuccess && !chatAvailable`.
4. Delete the `onboardingStatusQuery` declaration (`:160-165`).
5. Drop `getOnboardingStatus` from the `../api/client` import (`:13`) and `hasConnectedProvider`
   from the `../onboarding/chat-availability` import (`:31`, keep `isNoActiveChatModelError`).

### Test — `tests/unit/chat-drawer-availability.test.ts` (new file)

Mount-free, mirrors the `recordsFromMessages` style. Proves exit criterion §132 ("gate flips with
model availability, not install state, in both directions") structurally: the function's only
input is the route response, so install state cannot leak in by construction.

- `chatAvailableFromRoute({ route: { capability: "chat", available: true, reason: "matched-active-model", model: null } })` → `true`.
- `chatAvailableFromRoute({ route: { capability: "chat", available: false, reason: "no-active-model", model: null } })` → `false` — proves the "unavailable" direction independent of `reason`.
- `chatAvailableFromRoute(undefined)` → `false` — proves the pre-resolution state (query not yet
  settled) does not read as available.

Each case would fail against the current (pre-fix) `hasConnectedProvider`-based implementation
because that function takes install state, not route data, as input — there is no route shape to
pass it.

## Task 2 — #1451: prefetch persona on the app shell's query client

### 2a. Bound `getPersonaSettings` — `apps/web/src/api/client.ts`

Mirror `getOnboardingStatus` (`:487-501`) exactly: add `const PERSONA_SETTINGS_TIMEOUT_MS = 4000;`
immediately above `getPersonaSettings` (`:343`), rewrite the body to race an `AbortController`
timeout the same way, passing `signal: controller.signal` into `requestJson` and clearing the timer
in `finally`. Signature is unchanged: `export async function getPersonaSettings(): Promise<GetPersonaSettingsResponse>`.

No test — this mirrors an already-tested pattern 1:1 and its own effect is only observable through
Task 2b's live-path proof.

### 2b. Gate app boot on the persona query — `apps/web/src/app.tsx`

1. Add `getPersonaSettings` to the `./api/client` import block (`:7-14`).
2. Declare a new query alongside the other top-level queries (after `onboardingQuery`, `:154-159`):
   ```tsx
   const personaQuery = useQuery({
     queryKey: queryKeys.settings.persona,
     queryFn: getPersonaSettings,
     enabled: meQuery.isSuccess,
     retry: false
   });
   ```
3. Insert a gate immediately after the `!meQuery.data` `FatalState` branch (`:196-203`) and before
   `if (activeForOnboarding) {` (`:205`):
   ```tsx
   if (personaQuery.isLoading) {
     return <LoadingScreen />;
   }
   ```
   This runs once per boot (React Query caches `queryKeys.settings.persona`), so onboarding and the
   app shell both wait on the same resolved cache entry, and every `useAssistantName()` consumer
   downstream reads a populated cache on its first mount — no code change needed in
   `use-assistant-name.ts` itself. Bounded by 2a's 4s timeout: on error/timeout `personaQuery.isLoading`
   resolves to `false` (React Query with `retry: false`), so a hung persona endpoint falls through to
   the shell exactly like `onboardingQuery` already does (`:206-212`) rather than trapping boot.

### Evidence — live-path only (spec exit criterion §133 is explicit: no unit test accepted)

On a dev instance: set a custom assistant name in Settings → AI persona, sign out, sign back in
(or hard-reload), and confirm via the real UI plus a screen recording/screenshot sequence that no
frame ever shows "Moss" before the custom name — check every surface `useAssistantName()` feeds
(drawer header, composer placeholder, wherever else it's consumed) on first paint. Record the proof
on the PR per the Live-Path Gate.

## Kill gate

Evaluate after Task 1 lands and its unit test passes: if `chatRouteQuery` turns out not to be
`enabled` in some render path where the drawer still needs to show availability (i.e. the "open"
gating at `:169` misses a case the old `onboardingStatusQuery` covered), stop before starting Task 2
and re-open the design question with the coordinator — the two tasks are independent fixes bundled
in one lane, not a single change, so a Task 1 surprise should not silently reshape Task 2. Call made
by whoever is driving the build (this session, escalate to coordinator if genuinely blocked).

## Verification

```bash
pnpm test:unit tests/unit/chat-drawer-availability.test.ts tests/unit/chat-drawer-activity.test.tsx tests/unit/onboarding-chat-availability.test.ts > /tmp/w5d-vitest.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. (`pnpm test:unit <files>` runs exactly those files, per `scripts/test-unit.ts` —
no CLI args means the whole `tests/unit` glob, so the explicit file list is deliberate.)

```bash
pnpm typecheck > /tmp/w5d-tsc.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0` — catches the dropped imports (Task 1) and the new `app.tsx` query wiring (Task 2)
type-checking clean (`typecheck` = root `tsc --noEmit` + `pnpm --filter @moss/web typecheck` +
external-module tsc, per `package.json:26`).

Full gate (`pnpm verify:foundation`) only via the `verify-gate` skill, not run ad hoc, per
project CLAUDE.md.

## Commits

One commit per task (`git add` by explicit path only, per shared-checkout discipline):

1. Task 1 — `chat-drawer.tsx` gate fix + new test file.
2. Task 2 — `client.ts` timeout + `app.tsx` prefetch gate.
