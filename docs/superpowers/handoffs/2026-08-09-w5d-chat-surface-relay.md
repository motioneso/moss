# w5d-chat-surface relay — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (lane D, §54-70
collision map, §104-117 design forks, §118-135 exit criteria). Grounded on `origin/main = c8946358f`
— re-verify still current (no new commits landed since) before planning.
**Issues:** #1255, #1451. **Tier:** routine. **Worktree/branch:** this worktree, `w5d-chat-surface`.
**Coordinator:** label `Coordinator`, session id `890502d0-c97b-4ed1-aaae-8c33ec48c98f` (per
handoff doc — re-verify via `herdr pane list`, exactly one pane labeled `Coordinator`).
**Status:** research + spec verification done, escalation message already sent to coordinator
reporting this plan, relaying at context-meter 70% trigger. **No code written yet.**

## Owned files (exclusive to lane D)

`apps/web/src/api/use-assistant-name.ts`, and "the drawer availability gate" = `apps/web/src/chat/chat-drawer.tsx`.
Do not touch `today-page.tsx`, `onboarding/skip-confirm.tsx`, `shell/app-shell.tsx` (lane A),
`packages/chat/src/live/*` (lane B), `module-sdk`/shared api types (lane C).

## Next step: run `plan-build` for both fixes below, then message coordinator, then STOP for approval.

### #1255 — chat-drawer.tsx availability gate

Currently (`chat-drawer.tsx` ~line 150-186): `chatAvailable = hasConnectedProvider(onboardingStatusQuery.data)`
reads CLI install state, wrong per spec. Fix: use the **already-fetched** `chatRouteQuery`
(`queryKeys.ai.capability("chat")` → `lookupAiCapabilityRoute("chat")`, defined in
`packages/shared/src/ai-types.ts` as `AiCapabilityRouteDto`) — set
`chatAvailable = chatRouteQuery.data?.route?.available === true`. This is boolean-shaped,
provider-agnostic — satisfies spec's design fork #2 and Hard Invariants (no provider/model leak).
No new endpoint needed.

- Extract as a small pure exported fn (mirror the existing `recordsFromMessages` export pattern —
  see `tests/unit/chat-drawer-activity.test.tsx` for the mount-free test style to follow).
- `onboardingStatusQuery` becomes unused after the swap (confirmed only 3 uses in file: decl ~160,
  ~173, and the `isSuccess` check at ~494 gating `ConnectProviderEmpty` vs `EmptyState`) — replace
  that `isSuccess` check with `chatRouteQuery.isSuccess` and delete the `onboardingStatusQuery`
  declaration + now-unused `hasConnectedProvider`/`getOnboardingStatus` imports (grep first to
  confirm `getOnboardingStatus` isn't used elsewhere in the file).
- Test: unit test proving the extracted fn flips true/false on `route.available` regardless of
  install state (exit criteria §132: "gate flips with model availability, not install state, in
  both directions"). `tests/unit/onboarding-chat-availability.test.ts` (tests `hasConnectedProvider`
  itself) stays untouched — that fn isn't being edited.

### #1451 — fallback assistant-name frame on first paint

`use-assistant-name.ts` (already correct, no logic change needed) reads `queryKeys.settings.persona`
via `getPersonaSettings`; falls back to "Moss" until that query resolves. ~30 consumers across the
app each independently trigger-and-wait, so every page load flashes "Moss" for one frame before a
custom name paints.

Fix (spec's endorsed default: "prefetch on the app shell's query client" — smallest blast radius of
the 3 forks): in `apps/web/src/app.tsx` (NOT owned by any lane, top-level `App()` component, already
has a layered `bootstrapQuery`/`meQuery`/`modulesQuery`/etc. `<LoadingScreen/>` gate pattern ~line
1-203), add:
```tsx
const personaQuery = useQuery({
  queryKey: queryKeys.settings.persona,
  queryFn: getPersonaSettings,
  enabled: meQuery.isSuccess,
  retry: false
});
```
and a gate `if (personaQuery.isLoading) return <LoadingScreen />;` inserted after the existing
meQuery success/error branches (~after line 203) and before the onboarding/shell branch (~line 205)
— so onboarding AND the app shell both wait on the same cache entry before mounting, and all
`useAssistantName` consumers get it resolved for free on first mount.

**Open decision to resolve in the plan:** bound `getPersonaSettings` (`apps/web/src/api/client.ts`
~line 343-345, currently unbounded `requestJson`) with the same `AbortController`+`setTimeout`
pattern already used by `getOnboardingStatus` (`client.ts` ~488-503, `ONBOARDING_STATUS_TIMEOUT_MS
= 4000`) — otherwise gating app boot on this query turns a cosmetic bug into a full boot hang if the
endpoint stalls. Leaning yes; confirm no other `getPersonaSettings` caller (e.g. a settings editor)
is adversely affected by a 4s cutoff before finalizing.

- Exit criteria §133 is explicit: **live-path proof only, no unit test accepted as evidence**
  ("no frame shows the fallback" on a dev instance with a custom assistant name set).

## Reminders

- `plan-build` (not `superpowers:writing-plans`) → `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`.
- Message coordinator for plan approval, STOP before writing code.
- TDD build, commit per task, `git add` by explicit path only.
- Pre-push trio + rebase before push; `coordinated-wrap-up` for PR + live-path proof + report.
- `design-system` skill's `jds-*` audit: likely N/A (no new markup planned, pure logic/query
  changes) — reconfirm once plan is final in case that changes.
- Coordinator session-id in handoff doc (`890502...`) didn't match the pane resolved live earlier
  this run (`9ce2e7df-...`) — likely just a coordinator relay since the handoff doc was written;
  re-resolve fresh via `herdr pane list`, don't treat either as gospel without checking.
