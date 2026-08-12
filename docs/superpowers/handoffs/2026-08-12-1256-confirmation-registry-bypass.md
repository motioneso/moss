# Build Handoff — 1256-confirmation-registry-bypass

**Spec:** none on disk — the issue cross-references
`docs/superpowers/specs/2026-07-25-1250-1253-approval-request-lifecycle.md` ("Fix 3") but that
file does not exist in this tree (#1250/#1253 are both closed already; the fix for #1256 was
apparently never folded in, or the spec was never committed). Build directly against the issue
body, which fully specifies the fix. Escalate to the coordinator if the fix as scoped doesn't
match what you find in code.
**GitHub issue:** #1256 — read it in full (`gh issue view 1256 --repo motioneso/moss --comments`).
**Risk tier:** `security` — this is an authorization/confirmation-control bypass (a route can
persist `confirmed` state with no live waiter, and never unblocks a real waiter), even though RLS
still scopes it to the owner. Opus adversarial QA required before merge.
**Worktree:** `.claude/worktrees/1256-confirmation-registry-bypass`
**Branch:** `1256-confirmation-registry-bypass` off `origin/main` (current HEAD `33f57b1fa`)
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; resolve pane fresh.
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`.
**Relay trigger:** context-meter 70% warning, or a compaction summary → message coordinator, use
`relay` skill.

## The bug (from the issue, verified still present on `main` as of this handoff)

`packages/ai/src/routes.ts:532-551` — `POST /api/ai/assistant-actions/:id/resolve` calls
`repository.resolveAssistantAction` directly, bypassing `ConfirmationRegistry` /
`AssistantToolGateway.resolveActionRequest` entirely. Two consequences:

1. It can persist `confirmed` when there is no live waiter — the exact divergence
   `AssistantToolGateway.resolveActionRequest`'s fail-closed guard exists to prevent (see
   `packages/ai/src/gateway/gateway.ts:388-390`).
2. Even when a waiter is live, resolving via this route never unblocks it — the blocked tool call
   sits until its own timeout regardless of what the user chose.

RLS still scopes the row to its owner via `withDataContext` — not cross-user, but an untrue
record of the actor's own action plus a silently stranded tool call.

## Fix (issue's own prescription)

Re-point the handler at `gateway.resolveActionRequest` — the same call
`packages/chat/src/routes.ts:385` already makes — so it inherits the fail-closed timeout guard and
owner-match check. **Do not delete the route**: it's manifest-declared public API
(`packages/ai/src/manifest.ts:350-356`, `permissionId: "ai.assistant-actions"`) and permission
grants may reference its id (cf. #1246). If the response needs to carry the resolution outcome,
that's an additive schema change to the existing declared route, not a new route.

Add a test asserting both routes (`/api/ai/assistant-actions/:id/resolve` and the chat gateway
path) return identical outcomes for the same request id — including the expired-waiter case — so
the two paths cannot drift apart again.

## Start

1. `pnpm install`
2. Read issue #1256 in full — it IS your spec.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** (small, well-bounded scope) →
   coordinator approval → TDD build → **`coordinated-wrap-up`** (PR + report).

## Exit criteria

- `resolve` route re-pointed at `gateway.resolveActionRequest`; both paths behave identically
  including the expired/no-waiter case.
- Route not deleted; manifest declaration and `permissionId` unchanged.
- Regression test proving the two paths can't drift.
- Full gate green on an isolated gate DB. PR open, rebased on `origin/main`, security tier.
- No user-facing UI surface here (internal API contract fix) — note that explicitly in the PR
  instead of a UAT run, per `coordinated-wrap-up`'s live-path-gate section, unless you find a UI
  caller during the build that changes this.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known.
