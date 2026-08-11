# #1533 chat surface build — relay9 handoff

Supersedes relay8. Same worktree/branch: `build/1533-chat-surface-routing`.

## State

- Phase 3 (surface-scoped `switchChatProvider` + `ChatModelPill` routing + tests): DONE.
  Commits `fc301f113` (tests), `b680da8ea` (lint fix on top).
- Phase 4 (full gate + live-path proof + sensitive-tier check + draft PR): IN PROGRESS.

## What relay8 left broken, now fixed

Full `pnpm verify:foundation` gate failed at the **lint** step (first chain link, before
typecheck/test/db) with 3 `@typescript-eslint/consistent-type-imports` "`import()` type
annotations are forbidden" errors:
- `tests/unit/chat-drawer-surface.test.tsx:26:42` (pre-existing on this branch, not relay8's edit)
- `tests/unit/chat-model-pill-surface.test.tsx:26:42` and `:57:33` (new file from relay7)

Fixed in `b680da8ea` by replacing inline `importOriginal<typeof import("...")>()` with a
top-level `import type * as XModule from "..."` + `importOriginal<typeof XModule>()`. Verified:
`pnpm eslint` on both files EXIT=0, `pnpm typecheck` EXIT=0, focused vitest (27/27) EXIT=0.

**Lesson (saved to memory):** `tsc --noEmit` and `vitest run` going green does NOT mean lint is
clean — `pnpm lint` is a separate, earlier gate step. Always include it before claiming "gate-ready".

## Right now

Full gate relaunched: `scripts/run-gate.sh start --gate verify:foundation`, DB
`jarvis_gate_1533_chat_surface_build`, log `/tmp/jarv1s-gate/1533_chat_surface_build-20260811-013809.log`.
Being watched via a non-polling background Monitor loop (`scripts/run-gate.sh wait`). If you're
picking this up cold, run `scripts/run-gate.sh status` first — don't assume relay8's failed run is
still current.

## Next (Phase 4, per plan lines 292-313 and spec lines 296-319)

1. Gate → EXIT 0. If it fails again, read the log tail, fix, recommit (shared-checkout discipline:
   explicit paths, diff review, `git show --name-only HEAD`), rerun via `run-gate.sh` (never bare
   `pnpm verify:foundation` — see `verify-gate` skill + `run-gate.sh` usage comments).
2. Live-path proof: spec doc lines 296-319, 7-step procedure through job-search's "Change in
   chat" action. No dev instance is up for this worktree yet — pick a free port (3000/5173/5197/
   5299 already taken by other worktrees per earlier `ss -ltnp` check; 1533 is prod, never touch).
   See `dev-preview-recipe` memory for the standing setup steps (flagged stale, verify against
   current `package.json` scripts before trusting exact commands).
3. Sensitive-tier check: `git diff --stat` across full branch diff vs `main`, confirm no
   AccessContext/RLS/persistence/gateway-contract files touched.
4. `coordinated-wrap-up` skill → draft PR (not merge), citing live-path evidence explicitly.

## Standing instructions (from boot brief, still governing)

- Coordinator: re-resolve fresh via `herdr pane list`/`herdr agent list` before messaging, never
  trust a name/session id from a doc.
- Relay again at the next 70% context warning or immediately on any compaction summary — do not
  wait for a felt %, never end turn mid-procedure.
- Read this repo's `run-gate.sh`, not the verify-gate skill's literal manual DROP/CREATE text,
  for gate runs — the script supersedes it.
