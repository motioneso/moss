# Plan note: fix #2939 (drawer message box disappears after typing)

## Diagnosis (traced in code, repro running)

- The two specs fail because the drawer has no chat-capable model in UAT, and
  since #2926 the composer swaps the message box for a connect link as soon as
  the capability lookup resolves unavailable:
  `apps/web/src/chat/chat-drawer.tsx:251-260` (query fires on drawer open,
  `noModelAvailable` when the lookup succeeds with `available: false`),
  `apps/web/src/chat/composer.tsx:453-457` (link replaces `.chatd-input`).
- The lookup resolves after the drawer opens, so a fast test (or typist) fills
  the box first and the swap unmounts it before Send is clicked.
- #2938 (drawer-as-dialog) is exonerated: it is not an ancestor of f3c6f4b63,
  where QA confirmed both failures on main.
- #2737/#2740 (stream pre-start) only affects the event stream, never the
  composer mount. The send path needs no availability: composer `send()`
  (`composer.tsx:234-255`) and drawer `sendMessage` (`chat-drawer.tsx:279-338`)
  post the turn and land on the honest no-model error (`needsProvider`).

## Fix (one render rule in the composer)

- Never swap the message box for the connect link while the user has unsent
  content (typed text or staged attachment chips). Empty composer keeps the
  #2926 honest empty state, so `tests/e2e/chat-ready-state.spec.ts` and
  `tests/unit/chat-drawer-route-empty-state.test.tsx` still pass unchanged.
- Touch one condition: `composer.tsx:453`. Update the `noModelAvailable`
  prop doc (`composer.tsx:71`). No drawer, style, or seed changes.

## Regression test (kept with the project)

- Extend `tests/unit/chat-drawer-route-empty-state.test.tsx` (drawer-level
  string render, same style as the existing cases): no-model route plus
  drawer `initialText` keeps `<textarea>` and hides the connect CTA; empty
  composer still shows the CTA and no `<textarea>`. Red before, green after.
- Extend `tests/integration/ai-capability-routes.test.ts` (HTTP lookup seam):
  no default chat route plus a user override on an active chat model returns
  `available: true` with reason `user-override` for that user, while a user
  without an override still gets unavailable. Red before, green after.

## Lookup check (coordinator follow-up, verified in code)

- In the test setup the lookup is RIGHT: the turn path
  (`selectChatModelForUser` -> `selectModelForCapability` ->
  `resolveModelForCapability`, `packages/ai/src/repository.ts:792-806,1680`)
  and the lookup (`resolveModelForCapability` directly,
  `capability-route-routes.ts:52-54`) share one resolver, UAT seeds no
  override preference, and no chat-capable model exists there at all — the
  turns only ever ended on the honest no-model 400 the specs document. State
  this in the PR body.
- For real users there IS a deeper bug: `resolveModelForCapability`
  (lines 1201-1410) never reads the per-user override preference, while the
  turn path applies it (`resolveChatModelOverride` =
  `override ?? default`). A user whose override points at a working model
  while the instance default route is unconfigured gets `available: false`
  (message box hidden) for a turn that would succeed. Fix in the lookup
  handler only (user-facing question "would MY turn work"; worker and admin
  paths keep instance truth): when the chat lookup resolves no model, fall
  back to `selectChatModelForUser` for this user and report `available: true`
  with reason `user-override`. Touches: `capability-route-routes.ts`,
  `AiCapabilityRouteReason` (`ai-types.ts`), the route schema enum
  (`ai-api.ts`). Client only branches on `available` plus the admin-pin
  reason, so no client change.

## Verification

- Focused unit file green (unpiped, expected exit 0).
- `tests/e2e/chat-ready-state.spec.ts` unchanged behavior (mocked model).
- Each failing spec alone on an isolated provisioned stack:
  `npx tsx tests/uat/run-uat.ts runtime-context`,
  `npx tsx tests/uat/run-uat.ts 1133-chat-attachments` (repro before, pass after).
- Pre-push trio plus fresh rebase; full gate via `scripts/run-gate.sh`;
  live UI proof posted as a PR comment.

## Kill gate

- If the alone-run repro shows a failure other than the no-model swap
  removing the composer, stop and re-scope with the coordinator before
  writing product code. Owner of the call: coordinator.
