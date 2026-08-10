# Relay 2 — w3a-audit-truth (lane A: #1256, #1252, #1251)

**Plan doc (authority, has everything):**
`docs/superpowers/plans/2026-08-09-wave-3-lane-a-action-audit-truth.md`
**Coordinator label:** `Coordinator` — re-resolve fresh via `herdr pane list`, don't reuse this pane
id: as of this relay it was `w1:p3B`, status `working`.
**Risk tier:** security — Fable plan-review required before coordinator approval.

## State: all grounding + all design decisions done. No code written. Plan text not fully written.

This relay's only job was to close the one open design fork from relay 1. That's done — see the
plan doc's **"Resolved since last relay (2026-08-09, second pass)"** section. Read that section,
trust it, don't re-derive:
- #1256 response shape is decided (additive `outcome` field, 409 for expired, 404 unchanged).
- `resolveActionRequest` return-type widening and its one real call site are identified.
- A known, *intended* test-behavior change is flagged: `tests/integration/ai-tools.test.ts:300`
  currently asserts the exact misleading-audit-state bug this wave fixes. Updating its expectation
  is in-scope for #1256 — call this out explicitly to Fable.
- A schema trap is flagged: check `resolveAiAssistantActionRouteSchema` for fast-json-stringify
  field-stripping before adding `outcome` to the response.

## What's NOT done — pick up here, in order

1. Write the full `plan-build`-shaped task list into the plan doc (append a new section, don't
   replace grounding): task boundaries in #1251 → #1252 → #1256 order (both #1251/#1252 confined to
   `gateway.ts`; #1256 also touches `routes.ts` + `packages/shared` schema + the composition root in
   `packages/module-registry/src/index.ts` — mirror the existing `rpcConnection`/`getRpcConnection`/
   `adoptChatRpcConnection` late-bound getter/setter pattern there for a new `gateway`/`getGateway`/
   `adoptGateway` triple). Exact function/type signatures, a test case per spec Exit Criterion (spec:
   `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md`, "Exit criteria" section), a kill
   gate, unpiped verification commands with expected exit codes.
2. Get Fable's plan-review (mandatory, security tier). Flag the ai-tools.test.ts:300 expectation
   change explicitly — that's the one decision most likely to draw a challenge.
3. Message `Coordinator` (re-resolved fresh, per above) with the finished plan path. Wait for
   approval before writing any code.
4. Once approved: TDD build task-by-task, commit per task via the `shared-checkout` skill (shared
   worktree). Pre-push trio, `coordinated-wrap-up` (own gate on isolated DB per `verify-gate` skill —
   never run `pnpm verify:foundation` unscoped), PR, live-path proof (#1256 is UI-adjacent — a real
   approve/deny through the real UI on a live dev instance, plus the resulting audit row).
5. Opus adversarial QA verdict posted as a `gh pr comment` (spec exit criteria, applies to every
   lane).

## Do not re-litigate

Both the original grounding (relay 1) and the #1256 response-shape decision (this relay) are
verified/reasoned against the actual branch and spec text. Re-grep/re-read only if something looks
drifted, not routinely. No code has been written or committed in this lane — starting the build
fresh once approved, not resuming mid-build.
