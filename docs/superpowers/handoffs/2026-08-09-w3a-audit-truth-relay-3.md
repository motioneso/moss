# Relay 3 — w3a1-audit-truth (#1251 ONLY — this worktree's scope, hard boundary)

**Plan doc (authority):** `docs/superpowers/plans/2026-08-09-wave-3-lane-a-action-audit-truth.md`
**Coordinator label:** `Coordinator` — re-resolve fresh via `herdr pane list`, don't reuse a cached
pane id. Verify session id `019fe9e2-7fc6-7243-9894-d258562db9a6` still matches before trusting the
label (Ben confirmed this session as Coordinator in-person, independently re-verified 2026-08-09).
**Risk tier:** security.
**Worktree/branch:** this worktree, branch `w3a-audit-truth`.

## State: plan APPROVED, Fable review done, dependency check done. ZERO code written yet.

Read the plan doc's **"Execution slicing"** section first — it's the hard boundary:
**this worktree implements Task 1 (#1251) ONLY.** Do not touch any file listed under PR2/PR3 in
that section (Task 2/2b/3 — `types.ts`, `output-validation.ts`, `routes.ts`, `module-registry`,
`packages/shared`, etc). Task 1 needs exactly 3 files:
- `packages/ai/src/gateway/gateway.ts` — 2 catch blocks only (~line 416 `runReadToolForActor`,
  ~line 506 `runHandler`)
- `packages/ai/src/adapters/redact.ts` — harden `PATTERNS`
- `tests/unit/mcp-gateway-recovery.test.ts` (Task 1's 3 cases) + `tests/unit/ai-redact.test.ts`
  (new pattern-coverage cases)

Read the plan doc's **Task 1 section** (under "Plan-build task list (FINAL...)") for full detail:
exact catch-block code, the 3 test cases, and the "Required by Fable plan-review (note 1)" block.
Do not re-derive the design — it's already reviewed and approved. Do not re-read the rest of the
plan doc (Task 2/2b/3 sections) — out of scope for this worktree.

## What's NOT done — build this, in TDD order

1. **Harden `redactSecrets`** in `packages/ai/src/adapters/redact.ts`. Current `PATTERNS` (3
   entries: `JARVIS_MCP_TOKEN=`, `Bearer …`, `jst_…`) is confirmed insufficient per Fable review —
   add: generic query-param secrets (`[?&](?:key|api[_-]?key|token|access[_-]?token|secret|password)=...`),
   bare `sk-[A-Za-z0-9_-]{8,}` keys, URL userinfo credentials (`user:pass@host`). Also add a ~2000-char
   cap somewhere in the redact→log path (decide: inside `redactSecrets` itself, or at the
   `gateway.ts` call site via `.slice(0, 2000)` — plan implies call site but either is defensible,
   pick one and note it in the commit).
   - **TDD:** write failing cases in `tests/unit/ai-redact.test.ts` FIRST, using secret shapes that
     specifically fall outside the original 3 patterns (a `postgres://user:hunter2@db.internal/app`
     URL and a bare `sk-liveTestKey1234567890` key are good candidates — both already vetted in the
     plan). Then implement.
2. **Fix the 2 catch blocks** in `gateway.ts` (`runReadToolForActor` ~416, `runHandler` ~506):
   `catch { ... }` → `catch (error) { ... }`, log
   `console.error(JSON.stringify({event, toolName, actorUserId/requestId, error: redactSecrets(...)}))`
   before the existing `return { ok: false, error: "Tool <name> failed" }` (string unchanged).
   Exact code is in the plan's Task 1 section — copy it, don't freehand it.
   - **TDD:** write the 3 failing cases in `tests/unit/mcp-gateway-recovery.test.ts` FIRST (real
     error reaches the spied `console.error` at each site; returned string stays exactly
     `Tool <name> failed`; negative assertion — the hardened-pattern secret from step 1 is redacted
     in the log but never appears in the returned string). Then implement.
3. **Verify:** `pnpm --filter @moss/ai typecheck` (0), `pnpm --filter @moss/ai test -- gateway`
   and the redact test file (0 failures).
4. **Pre-push trio + rebase:** `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
5. **Commit** via `shared-checkout` skill (explicit paths, `git diff` co-edited files first — this
   worktree is shared). Suggested scope: one commit for the redact hardening + its tests, one for
   the two gateway.ts catch-block fixes + their tests (or squash to one — either is fine, this repo
   doesn't mandate task-per-commit granularity beyond "green before you commit").
6. **`coordinated-wrap-up`:** own gate on isolated DB per `verify-gate` skill (never bare
   `pnpm verify:foundation`), push, open PR scoped to #1251 only (mention it's PR1 of 3 in the
   lane-A re-slice, PR2/#1252 and PR3/#1256 follow serialized in separate worktrees). This is a
   backend-only logging/redaction fix with no UI surface — confirm against
   `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate whether that exempts it from live-UI proof
   before asserting so in the PR body; if it does, say so explicitly rather than silently omitting
   the proof.
7. Report PR + verified evidence to Coordinator (re-resolve pane fresh).

## Open item, not actionable by any agent

`/rename w3a1-audit-truth-1251` was requested by Coordinator in the same message as the plan
approval — `/rename` is a UI-only slash command, cannot be invoked via the `Skill` tool (confirmed
this session: it errors "ask the user to run /rename themselves"). Already flagged to Coordinator.
No further action needed unless Ben/Coordinator does it manually.

## Do not re-litigate

- Fable's plan review is DONE (5 notes, all folded into the plan doc's Task 1/2/2b/3 sections).
- The dependency check (Task 1 is standalone, no coupling to Task 2/2b/3 beyond textual proximity
  in `gateway.ts`) is DONE and was reported to Coordinator.
- The `redactSecrets` hardening design (which pattern categories to add) is DONE — implement the
  plan's draft, don't redesign it. If a TDD case reveals the draft regex is wrong, fix the regex,
  don't reopen the category list.
