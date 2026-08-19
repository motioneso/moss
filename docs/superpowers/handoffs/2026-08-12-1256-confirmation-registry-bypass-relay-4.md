# Relay 4 — #1256 confirmation registry bypass

**Branch/worktree:** `1256-confirmation-registry-bypass` (this worktree, unchanged — do not
`pnpm install`). **Risk tier:** security.

## State — do not re-read relay-1/2/3, the plan, or the issue

All 5 build tasks are DONE and committed, branch already based on latest `origin/main`
(merge-base == `origin/main` HEAD `33f57b1fa5`, confirmed, no rebase needed):

```
7c900fa34 test(1256): add regression coverage for assistant-action resolve parity
bec70c3dc feat(module-registry): wire ai resolve route to chat's live AssistantToolGateway
4e760537e fix(ai): route assistant-action resolve through injected gateway resolver
a5309f390 feat(ai): add repository.getAssistantAction single-row getter
```

Pre-push trio run and result:
- `pnpm lint` → EXIT=0
- `pnpm typecheck` → EXIT=0
- `pnpm format:check` → EXIT=1, but the **only** warning is
  `docs/superpowers/plans/2026-08-12-1256-confirmation-registry-bypass.md` (a relay-1 doc, never
  touched by this lane's commits). Confirmed pre-existing, not introduced by any commit above —
  don't "fix" it (out of scope, would touch a doc outside this task). Note it in the PR/QA report
  as a known pre-existing drift, not a blocker.

`tests/integration/ai.test.ts` regression suite (new `describe("assistant action resolve parity")`
block, 3 cases) passes together with the full `test:ai` file set:
`export JARVIS_PGDATABASE=jarvis_gate_1256 && pnpm test:ai` → 50/50 passed, EXIT=0. Required
`pnpm build:app-map` first (generates `dist/app-map.json`, gitignored, needed by
`registerBuiltInApiRoutes`) — not mentioned in earlier relay docs, do this before any integration
test run in this worktree if `dist/app-map.json` is missing (ENOENT otherwise).

## What the fix does (for the PR description — don't re-derive from diff)

`POST /api/ai/assistant-actions/:id/resolve` previously persisted confirm/reject/cancel straight
via `repository.resolveAssistantAction`, with no check that a live confirmation-registry waiter was
pending — a stale/expired row could still be flipped to `confirmed` via this route even though
chat's own resolve route (`/api/chat/action-requests/:id/resolve`) already refused that. Fixed by
routing the ai route through the same `AssistantToolGateway.resolveActionRequest` gate, wired via a
late-bound `adoptChatGateway` setter threaded through `module-registry`'s composition root (mirrors
the existing `adoptChatRpcConnection`/`adoptDropSessionsForProvider` pattern). Additive-only schema
change (409 added to `resolveAiAssistantActionRouteSchema`). Manifest route untouched.

**QA-flag, not a blocker:** `resolveActionRequestFn` (the setter's target) is a module-level
`let` in `packages/module-registry/src/index.ts` because the ai module's `registerRoutes` closure
lives in the module-level `BUILT_IN_MODULES` array, a different function scope than
`registerBuiltInApiRoutes` (a local declaration there doesn't compile — `TS2304`, hit and fixed
during this build). Consequence: if more than one `createApiServer` call shares a Node process, the
last `adoptChatGateway` call wins for all of them. Benign for the shipped test suite (one server per
integration test file/process) but worth a second set of eyes given the security tier — call it out
explicitly in the QA report.

## Next steps — coordinated-wrap-up, starting from a clean slate

1. `verify-gate` skill, full `pnpm verify:foundation` on an isolated gate DB (reuse `jarvis_gate_1256`
   or fresh per that skill's own instructions — don't skip it for the format:check note above, run
   the real gate and record its actual exit code).
2. Push branch, open PR. Body: summary above + the QA-flag paragraph + gate result. Release-note
   line: "Fixed a gap where a stale assistant-action confirmation request could still be approved
   through the API even after the live confirmation prompt had expired." No UAT/live-path claim —
   this is an internal API-contract fix with no direct UI caller change; note "code-complete,
   no UAT needed" unless you find one when opening the PR.
3. Report to Coordinator: **flag security tier, request Opus QA**, include the module-level-
   singleton note verbatim above.

## Constraints (verbatim, unchanged)

Work only in this worktree/branch. `git add` by explicit path only, never `-A`/`.`. Never touch
`docs/coordination/`, the board, milestones, or merge. No secrets anywhere. Resolve route is
manifest-declared (`packages/ai/src/manifest.ts:350-356`, `permissionId: "ai.assistant-actions"`) —
this lane only added a 409 to its schema, nothing removed.
