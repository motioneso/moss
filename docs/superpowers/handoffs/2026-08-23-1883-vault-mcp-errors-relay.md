# Relay: #1883 vault-search MCP error detail

Branch/worktree: `build/1883-vault-mcp-errors`, this worktree (unchanged — stay here).
Coordinator: agent name `coordinator` (re-resolve via `herdr agent list` before messaging — do not
trust a pane number from this doc; it has already relayed itself once mid-run).

## State (fix implemented and committed, gate not yet run)

- Spec: `docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md` (approved).
- Plan: `docs/superpowers/plans/2026-08-23-1883-vault-mcp-errors.md`, **approved by coordinator at
  commit `118c02f9e`** after two security-fork revision rounds:
  round 1 required all inspection to be exception-safe; round 2 (the binding one) required a
  trap-free brand check — `util.types.isNativeError` — BEFORE any property read, because wrapping
  reads in try/catch still invokes a hostile Proxy's trap even though the throw is caught. Read
  the plan's "Design" section for the exact classifier contract if touching this code again.
- **Fix implemented and committed** at `db1e5c1e7`:
  - New file `packages/ai/src/gateway/dependency-failure.ts` — `classifyToolDependencyFailure` and
    `safeErrorName`, both brand-check with `util.types.isNativeError` on the top-level error AND
    its `.cause` before touching any property, only ever called when `found.tool.isExternal ===
    false`.
  - `packages/ai/src/gateway/gateway.ts` `runHandler` catch block (~line 636) now reads `error`
    only through those two guarded functions, gated on `isExternal === false`; the untrusted path
    is completely unchanged (no property access at all).
  - New test `tests/unit/mcp-gateway-dependency-errors.test.ts` — 7 cases: 3 classification
    cases, 1 unclassifiable-stays-generic case, 1 no-message-leak case, and 2 hostile-shape cases
    (top-level Proxy, Error with hostile-Proxy cause) asserting zero trap calls.
  - Verified green: `pnpm test:unit tests/unit/mcp-gateway-dependency-errors.test.ts
    tests/unit/mcp-gateway-recovery.test.ts tests/unit/mcp-gateway-units.test.ts` gave
    `66 passed (66)`, confirming the #1251 hostile-throw test is untouched.
- **Kill gate cleared without code reading** (node_modules access was sandbox-denied): relied on
  documented Node/undici behavior — a failed `fetch()` throws `TypeError("fetch failed", {
  cause })` where `cause.code` is `ECONNREFUSED`/`ENOTFOUND`/etc., exactly the shape the classifier
  reads, and the same shape the existing `classifyLiveReadFailure` precedent
  (`packages/connectors/src/source-context/types.ts:145-176`) already relies on.
  `@huggingface/transformers`'s model-download path runs through this same fetch. If you want to
  double-check with actual library code, node_modules reads were blocked for me here — try again or
  ask the coordinator why.
- **`pnpm install` was required** — `node_modules` was NOT present in this worktree at relay time
  despite the usual assumption. Successor: `test -d node_modules` first; if missing, install (fast,
  pnpm store is warm).
- Gate database created but gate NOT yet run: `jarvis_gate_1883vault` exists (fresh, empty) on
  `jarv1s-postgres`. Successor should `export JARVIS_PGDATABASE=jarvis_gate_1883vault` (or
  drop/recreate fresh per the `verify-gate` skill — either is fine, it's empty) before running
  `pnpm verify:foundation`.

## Next steps

1. `export JARVIS_PGDATABASE=jarvis_gate_1883vault` (or drop+recreate fresh per `verify-gate`
   skill), then run the full gate backgrounded with a sentinel per that skill — never piped.
2. If green: `coordinated-wrap-up` — pre-push trio + rebase, push, open PR with release note
   (`Category: Fixed`, plain-English description — no jargon, per CLAUDE.md), report PR + evidence
   to coordinator.
3. Live diagnosis (spec requires this AFTER the fix ships): call `/api/mcp` `notes.search` on the
   real dev instance (`http://192.168.50.36:5173` / API `:3000`, login `ben@ben.com` /
   `jarvistest123!`) and read the surfaced `cause` in the error text to identify what's actually
   broken in the current live vault-search outage. Record the finding in the PR. Do not fix an
   unrelated dependency without that evidence — spec non-goal.

## Reminders from CLAUDE.md / boot brief

- Security tier: fixed safe cause vocabulary only, never derive model-visible detail from raw
  exception messages/bodies/vault content/query text/credentials/stack traces. Preserve original
  failure server-side for logs only.
- Own MCP transport + gateway path + focused tests only. Don't touch unrelated areas.
- Do not merge, do not touch project/coordination files. Don't revert others' edits — rebase and
  accommodate.
- Sign every coordinator message with your pane id. Resolve coordinator fresh each time.
- Plain English in all chat/status/handoff text — no jargon, no coined shorthand (see global
  CLAUDE.md).
- Shared checkout: never `git add -A`/bare commit; commit by explicit path; diff-check any
  co-edited file before committing.
