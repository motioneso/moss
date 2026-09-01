# Handoff — build-2175-safety-core, context checkpoint (no relay budget left)

Worktree: `~/Jarv1s/.claude/worktrees/2175-safety-core`
Branch: `build/2175-safety-core`
Plan: `docs/superpowers/plans/2026-09-01-2175-safety-core-build.md` — read Tasks 2-4 sections only,
Task 1 is done.

## Approval already granted (do not re-ask)

Coordinator approved the plan and answered all three open items:
1. Migration number 0208 is free and reserved for this lane. File path:
   `packages/integrations/sql/0208_integration_unsuppressed_tools.sql`.
2. The plain-success summaries stay exactly as the plan wrote them: "Action performed
   successfully." and "Read succeeded."
3. `MOSS_PERSONA_INTEGRATION_RESULT_TRUST` goes into `composeMossPersona` for every surface, not
   gated to the default surface (like the existing tool-result defense block, not like the
   app-map block).

## Done

Task 1 (tool hints) is committed at `7bfc5188e` — readOnly/idempotent/destructive on
`IntegrationToolDescriptor`, mapped in `mcp-client.ts` and `openapi-convert.ts`, tests in
`tests/unit/integrations-tool-hints.test.ts`. All green.

## In progress — Task 2 (outcome envelope + prompt rule)

Two test files are written and confirmed RED for the right reason (missing exports, not typos).
They are staged but not committed. Do not rewrite them, just make them pass:

- `tests/unit/integrations-envelope.test.ts` — drives the envelope through the real
  `createIntegrationsActiveModulesResolver` -> `execute` path using a real local HTTP server
  (same pattern as `tests/unit/integrations-openapi-invoke.test.ts`), so no mocking of the
  network call itself. Checks: read-only tool -> `status: "ok", action: "read"`; non-read-only ->
  `action: "performed"`; absent `readOnly` -> `"performed"`; HTTP 500 -> `status: "error"`,
  `summary: INTEGRATION_SUMMARY.callFailed`; detail passes through byte-identical.
- `tests/unit/chat-runtime-persona.test.ts` — added a new `describe` block for
  `MOSS_PERSONA_INTEGRATION_RESULT_TRUST`: checks the exact wording pieces, under-40-words, and
  that it appears on both the drawer surface and a module surface.

Failure reasons confirmed: `INTEGRATION_SUMMARY` doesn't exist yet, `execute` doesn't return the
envelope shape yet, `MOSS_PERSONA_INTEGRATION_RESULT_TRUST` isn't exported yet.

## Next action — make Task 2 green

Follow the plan doc's Task 2 section exactly (`packages/integrations/src/tool-manifests.ts`,
`packages/chat/src/live/runtime.ts`). Widen `execute`'s signature to accept `ctx` as the third
param (`ToolExecute` in `packages/module-sdk/src/index.ts` already carries it — this is additive).
Add `IntegrationOutcomeEnvelope` and `INTEGRATION_SUMMARY` to `tool-manifests.ts` exactly as the
plan's code block. Add `MOSS_PERSONA_INTEGRATION_RESULT_TRUST` near `MOSS_PERSONA_TOOL_GUIDANCE`
in `runtime.ts` and push it into every surface's `parts` array in `composeMossPersona`, not gated
on `DEFAULT_CHAT_SURFACE`.

Run: `npx vitest run tests/unit/integrations-envelope.test.ts tests/unit/chat-runtime-persona.test.ts`
until both pass, then also re-run Task 1's tests and the existing
`tests/unit/integrations-tool-manifests.test.ts` to confirm nothing broke (that file's fake
`execute` calls now need a 3rd `ctx` arg if it calls `execute` directly — check before assuming).
Commit Task 2 with explicit paths (never `-A`), `Co-Authored-By: Claude` trailer.

Then continue with Tasks 3 and 4 exactly as the plan doc describes — call-memory store, the new
SQL migration (0208, confirmed free), the escape-hatch column plumbing, the call ceiling and size
budget. One task per commit.

When Tasks 1-4 are all green: pre-push trio (`format:check && lint && typecheck`, then rebase on
`origin/main`), then `coordinated-wrap-up` — gate via the `verify-gate` skill (never improvised,
never unscoped, never piped), push, open PR, report to the coordinator. Never merge, close the
issue, or touch the board. No live proof until code, CI, and independent QA gates are ready —
never port 1533.

If you also hit a 70% context trigger with still no PR open, do not relay again — message the
coordinator (pane found via `herdr agent list`, agent name `coordinator`) and ask for the lane to
be re-sliced, the same way this checkpoint did.
