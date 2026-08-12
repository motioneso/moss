# #1554 Phase 2 — relay 13 (task #8, final)

Branch `1554-persistent-provider-chat-runtime`, worktree
`.claude/worktrees/1554-persistent-provider-chat-runtime`. Plan:
`docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`. All 7 prior tasks complete
(relay-12 confirmed task #7 / e2e-P2 at `a10487de8`). This relay executed task #8: pre-push trio,
rebase check, gate, push, PR, this doc.

## Pre-push trio fixes (before this relay's gate run)

Two commits, both already on this branch:

- `3be3d33f4` — `chore(1554): pre-push trio cleanup — prettier + lint fixes`. 14 files, prettier
  formatting + 2 `prefer-const` fixes (`cli-runner/src/main.ts` forward-reference `let` → mutable
  box object; `persistent-pool-reap.test.ts` straight-line merge) + 4
  `consistent-type-imports` fixes (inline `typeof import(...)` → top-level `import type * as X`).
- `b9591dc55` — `fix(chat): extract session-runtime-helpers to clear file-size gate`. Gate run 1
  failed at `check:file-size`: `chat-session-manager.ts` hit 1019 lines (cap 1000; origin/main was
  998, this branch's own Decision-2 commit added +21). Fixed by extracting `delay`,
  `applyRemoteReap`, `countSubscribersFor` into new `packages/chat/src/live/session-runtime-helpers.ts`
  (pure extraction, no behavior change) — file now 992 lines. Re-verified: typecheck/lint/
  check:file-size all EXIT=0, and all 150 tests across the 9 `chat-session-manager*.test.ts` files
  passing.

Final pre-push trio re-run this relay, all clean: `format:check` EXIT=0, `lint` EXIT=0, full
`typecheck` (root `tsc` + `@moss/web` + external-modules) EXIT=0.

## Rebase

`git fetch origin` → origin/main unchanged at `fd93546fc` (same as the earlier rebase target this
chain already landed on). `git rev-list --left-right --count HEAD...origin/main` → `22  0`: branch
is 22 ahead, 0 behind. **No rebase action needed** — already current.

## Gate

Isolated DB `jarvis_gate_1554p2_1786568959` (reused across both runs; run 1 failed before any
DB-mutating step). Run 1: `### FINAL rc=1`, failed at `check:file-size` (see above, now fixed). Run
2 (after the extraction fix): `### FINAL rc=0`, **190 test files passed, 1889 tests passed, 2
skipped**, duration 1401.38s. Independently confirmed by both me (direct log tail) and the
coordinator.

Notable, non-blocking: the dev `jarv1s-postgres` container wasn't running at the start of this
relay (`docker exec` → "No such container"); started via
`docker compose -f infra/docker-compose.yml up -d postgres greenmail`, which created a fresh empty
volume (`infra_jarv1s-postgres-data`) — no prior dev data existed under this name on this host.
Doesn't affect the gate (isolated DB), flagged for whoever next needs dev-DB data.

## Push + PR

Never pushed before (`git ls-remote` empty pre-push). Plain `git push -u origin
1554-persistent-provider-chat-runtime` — no force needed (no already-pushed commits rewritten).

**PR: https://github.com/motioneso/moss/pull/1593** — "feat(chat): persistent-provider pool
lifecycle — #1554 Phase 2", base `main`. Body covers: pool admission cap + LRU eviction, all-busy
fallback, idle-reap timer (live-reads `chat.persistent_idle_reap_minutes` fresh every tick),
`RpcPush` `sessionReaped` channel + MCP-token revocation on reap, the two settings keys, e2e-P2
description, and full test-plan checklist (format/lint/typecheck/gate/e2e-P2/rebase, all green).

Explicitly states, citing the plan's **Determinism boundary** and **Finding A** sections by name:
backend-only, no UI surface, so CLAUDE.md's Live-Path Gate doesn't apply — no live dev-instance
Playwright proof needed or attempted.

**Settings-UI exposure — checked, not auto-generated.** Dispatched a subagent to verify: the admin
settings UI does **not** auto-generate fields from `RUNTIME_CONFIG_REGISTRY` — there's no generic
registry-driven settings page in this codebase at all (one existed, was deleted per #1313; see
`apps/web/src/api/query-keys.ts:64-66`). The two new keys
(`packages/settings/src/runtime-config-keys.ts`) are registered and admin-API-settable (`PATCH
/api/admin/runtime-config/chat.persistent_pool_cap` etc.) but render in **no UI page today** — zero
references anywhere in `apps/web`. PR body states this plainly: not user-visible, and making these
admin-editable would need new frontend work not in scope here.

**Not merged, #1554 not closed, project board untouched** — per hard ban, throughout.

## Coordinator report

Resolved fresh via `herdr pane list` (not trusted from any stale doc): coordinator is pane
`w1:p7P`, session id `0bb9f516-c026-454f-bc97-dc9faf43bd20`, label "Coordinator", status
`working`, cwd `coord-overnight-20260810`. Reporting to that id directly after this doc is
committed.

Earlier in this relay, `SendMessage` to `"Coordinator"` and to that same id both failed
("No agent named ... is reachable"); no working `ListAgents` tool was present in this session's
toolset. Retried the same id after a fresh `herdr pane list` confirmed it live — see next message
in this thread for outcome.

## Task tracking

No `TaskGet`/`TaskUpdate` tool present in this session's toolset (consistent with every prior relay
in this chain) — cannot mark task #8 complete via tooling. Noting here instead, per instructions.

## Status

Task #8 (final task in the plan) complete: gate green, PR open at #1593, this doc committed. #1554
Phase 2 build work is done pending coordinator/reviewer sign-off.
