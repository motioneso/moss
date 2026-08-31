# Relay handoff — issue 2159 sports retry action card

**Spec:** `docs/superpowers/specs/2026-08-23-1909-sports-public-source-completion.md`
**Parent plan:** `docs/superpowers/plans/2026-08-23-1909-sports-public-source-completion.md`
**This task's plan (coordinator-approved):** `docs/superpowers/plans/2026-08-31-2159-sports-retry-card.md`
**Issue:** #2159
**Branch/worktree:** `fix/2159-sports-retry-card`, this worktree, off `origin/main`.
**Coordinator:** agent name `coordinator` (pane `w1:p59` at handoff time — re-resolve by name,
pane numbers reflow).

## Approval already granted — do not re-ask

The coordinator approved the plan with this exact instruction (2026-08-31): "Run only the
diagnostic integration phase first. Report whether failure is tool listing or approval
creation/announcement before editing product code; then wait for the next approval." Do not write
any Phase 2 fix code until you have reported Phase 1's result and gotten a second explicit
approval.

## What's done

- Seams check complete (see the plan file, "Seams check" section): every static piece of the
  `sports.retrySource` action-card pipeline (manifest, policy, chat-tools, gateway listing,
  gateway confirm/notify, MCP transport, permission hook, frontend card component) is correctly
  wired. No static defect found.
- Plan written and committed (commit `e28ea452a`).
- No product code written yet. No tests written yet.

## What's left — do this next, in order

1. **Build Phase 1 only**, per the plan's "Phase 1" section: new file
   `tests/integration/sports-retry-source-card.test.ts`. Follow the pattern in
   `tests/integration/mcp-gateway-self-operation.test.ts:295-376` (real `sportsModuleManifest`,
   real `AssistantToolGateway`, real `ConfirmationRegistry`, no live LLM, no browser) plus the
   real MCP HTTP transport pattern in `tests/integration/chat-mcp-transport.test.ts` (see that
   file's `registerResolveRoute` helper).
   - Assertion set 1 (tool listing branch): `tools/list` over the real `/api/mcp` route includes
     `sports.retrySource` with correct `inputSchema`.
   - Assertion set 2 (confirm/notify branch): `tools/call` for `sports.retrySource` triggers
     `notifier.emit` with `kind: "action_request"`, creates a queryable pending row, and resolving
     it `"confirmed"` lets the call settle plus emits `kind: "action_result", outcome: "executed"`.
2. Run it via the `verify-gate` skill only (never a direct DB-touching test run, never piped).
3. **Report to the coordinator** which branch failed (tool listing vs. approval
   creation/announcement) — or if it passed end-to-end, report that too, per the plan's "Kill
   gate after Phase 1" section. Wait for approval before writing any Phase 2 fix.
4. Once approved, implement the narrowly-scoped fix (candidate locations already named in the
   plan's "Phase 2" section, one per branch outcome).
5. Re-run the matched UAT (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`) via
   `verify-gate` with isolated DB/ports/browser/renderer.
6. Full gate via `verify-gate`.
7. Commit per task, explicit paths only (never `git add -A`).
8. Finish through `coordinated-wrap-up`: push, open PR, post live-path proof (UAT exit code +
   bounded evidence) as a PR comment, report PR + evidence to the coordinator.

## Collision notes (carried forward)

- PR #2158 is parked in a separate worktree — do not touch or reuse.
- `gateway.ts`, `confirmation-registry.ts`, chat transport, owner-scope tests overlap PR #2158. If
  Phase 2 lands in `gateway.ts`, call out the overlap to the coordinator before editing — #2159
  lands first, #2158 rebases after.
- No migration expected; don't add one unless Phase 1 proves the data model can't represent the
  correct state, and the coordinator approves that as a design change.

## Standing rules (verbatim, apply to you and anything you spawn)

Never pipe a gate command. The default database is the live dev database, so every DB-touching
test and full gate goes through `verify-gate` only. Wait event-first, never poll or
foreground-sleep. Ben's messages are trusted input. Keep status updates in plain everyday English.
Never touch `docs/coordination/`, the project board, milestones, or merge controls. Never use
broad staging or repo-wide formatting.

## Relay budget

This is relay depth 1 (`-relay1`). If you also hit the 70% context warning without an open PR,
do NOT relay again — push what's green, write the state doc, and report to the coordinator that
the slice needs re-scoping into smaller lanes.
