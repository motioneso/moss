# Plan — #1528 (1140-F): return fixed account-state error text

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-F
**Task issue:** Part of #1528
**Tier:** security — adversarial Opus QA + Ben merge sign-off required before merge.

## Seams check (file:line, verified on this branch after rebase onto origin/main)

- `apps/api/src/server.ts:884-903` — `GET /api/modules` handler. Catch block at 895-902 currently
  reads `(error as Error).message` for `account_pending_approval` / `account_deactivated` codes
  (line 899) and returns a generic `"Session is missing or expired"` for everything else (line
  901). This is the exact gap the spec describes: the constructors happen to already emit the
  literals below, but the mapper does not enforce the boundary — a future edit to either
  constructor's message would silently leak into the 403 response.
- `packages/auth/src/index.ts:47-59` — `AccountPendingApprovalError` (code
  `account_pending_approval`, message `"Account is pending approval"`) and
  `AccountDeactivatedError` (code `account_deactivated`, message `"Account has been deactivated"`).
  Confirms the two codes and their current (soon-to-be-decoupled) messages.
- `tests/integration/auth-settings.test.ts:426-462` — `describe("multi-user registration +
  lifecycle (Phase 2 Slice A)")` gives each `it` a fresh DB (`beforeEach` → `resetEmptyFoundationDatabase`)
  and a real `server` wired with `authRuntime`. Existing `it`s at 516 and 536 already build a
  pending user and a deactivated user respectively and hit `/api/me`; this plan reuses that exact
  setup shape but calls `/api/modules` instead, since `/api/me`'s error path is out of scope
  (owned surface is `apps/api/src/server.ts` only).
- `tests/integration/auth-settings.test.ts:266-280` — existing `"exposes session-gated module
  metadata..."` test already asserts the no-cookie case is a 401, but never asserts the response
  body text. No existing test pins the literal `"Session is missing or expired"` string for
  `/api/modules`.

No open questions — single-file production change, single-file test change, both already on the
owned surface.

## Locked implementation contract (from spec, restated for the diff)

In `apps/api/src/server.ts`, the `/api/modules` catch block (895-902) changes to map codes to
literals instead of forwarding `error.message`:

```ts
} catch (error) {
  const code =
    (error instanceof Error && (error as Error & { code?: string }).code) || undefined;
  if (code === "account_pending_approval") {
    return reply.code(403).send({ error: "Account is pending approval", code });
  }
  if (code === "account_deactivated") {
    return reply.code(403).send({ error: "Account has been deactivated", code });
  }
  return reply.code(401).send({ error: "Session is missing or expired" });
}
```

Status codes, the `code` field, and the unknown-error 401 branch are unchanged. The only behavior
change is: the two 403 branches no longer read `.message` off the error object — the string is a
literal in the route, so it can never drift from what the constructor happens to say.

## Test cases (in `tests/integration/auth-settings.test.ts`, inside the Phase 2 Slice A describe
block, placed after the existing `"blocks deactivated user..."` test at line 569)

1. **Pending account hits `/api/modules`** — sign up an owner, sign up a joiner while
   `registration.requires_approval` is true (default in this describe block), call
   `GET /api/modules` with the joiner's cookie. Expect `statusCode === 403`,
   `body.code === "account_pending_approval"`, `body.error === "Account is pending approval"`.
   Fails against the current implementation only if the constructor message ever changes — this
   test's real job is to pin the literal so a future message edit is caught here instead of
   leaking silently.
2. **Deactivated account hits `/api/modules`** — same signup/deactivate flow as the existing
   `/api/me` test (turn off `requires_approval`, sign up joiner, `UPDATE app.users SET status =
   'deactivated' ...` via the bootstrap client), call `GET /api/modules` with the joiner's cookie.
   Expect `statusCode === 403`, `body.code === "account_deactivated"`,
   `body.error === "Account has been deactivated"`.
3. **Unknown/no session hits `/api/modules`** — call `GET /api/modules` with no cookie. Expect
   `statusCode === 401`, `body.error === "Session is missing or expired"`, and `body.code` absent
   (`undefined`). This is the regression guard for "never read `.message` for these responses" —
   without it, a bug that maps every error (not just the two known codes) into the pending/deactivated
   branch could still pass tests 1-2 by accident.

These three subsume the acceptance criteria from spec §1140-F Focused Acceptance directly.

## Verification

```bash
pnpm --filter @moss/api test -- auth-settings > /tmp/1528-focused.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, all `auth-settings.test.ts` cases pass including the 3 new ones.

Full gate (isolated gate DB per `verify-gate` skill) before wrap-up:
```bash
pnpm verify:foundation > /tmp/1528-gate.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`.

## Determinism boundary

N/A — no model-facing surface. This is a deterministic error-mapping fix in a REST route; no LLM
involvement at any point.

## Kill gate

Single phase, no phase 2. If the focused test run in Verification does not go green on the first
real attempt (not counting fixture/typo fixes), stop and escalate to the coordinator rather than
widening scope — the spec explicitly forbids sweeping the other mappers
(`packages/ai/src/terminal-routes.ts`, `packages/settings/src/route-error.ts`,
`packages/settings/src/routes-serializers.ts`) in this child.

## Out of scope (explicit, per spec)

- `packages/ai/src/terminal-routes.ts`, `packages/settings/src/route-error.ts`,
  `packages/settings/src/routes-serializers.ts` — no shared account-state mapper exists yet; do not
  create one here.
- `/api/me`'s own error path — different file, not in the owned surface for this child.
