# #1310 settings-write UI refresh — relay continuation (relay 20)

**Issue:** #1310 · **PR (existing, push here):** #1276
**Branch/worktree:** `1264-settings-self-operation`, this worktree (shared — confirm no other
live session in it via `herdr pane list` before any git op)
**Coordinator label:** `Coordinator` — confirm exactly one pane holds it via `herdr pane list`
before messaging. **NEW as of this relay: Coordinator says the live-path UAT proof (item 9 below)
is now a hard merge gate, not a nice-to-have** — `coordinate` skill family updated on main
(`8f1b6d44`). PR #1276 does not merge without a `gh pr comment` posted with real-browser UAT
proof (assertions/evidence + run output). A mocked-SSE e2e does not discharge it.
**Plan doc:** `docs/superpowers/plans/2026-07-27-settings-write-ui-refresh.md` (writing-plans
format, not plan-build — keep executing as-is per prior relay note).
**Prior handoff (fuller context, read only if this doc is insufficient):**
`docs/superpowers/handoffs/2026-07-27-1264-settings-self-operation-relay-18.md`

## Exit criteria (all must hold before wrap-up)
1. Settings write via chat reflected on screen with no manual refresh.
2. Invalidation mechanism is GENERIC — declaration-driven via `affectsQueryKeys`. No hardcoded
   query key, no theme-specific branching (epic #1262's generic settings writer needs this same
   seam for every setting later).
3. e2e UAT proves it on a real dev instance: chat turn → tool → DOM assertion on user-visible
   words (not internal ids/query keys). Asserting DB state does not discharge this.
4. `pnpm verify:foundation` green, real captured exit code (never piped).

## Done this session (commits `a05fad65`, `ba39b153`, `302fd117`) — tasks 1-4 of 10
1. `apps/web/src/api/query-keys.ts` — `resolveQueryKeyToken(token)`: fail-closed dot-path walker,
   own-enumerable only, rejects `__proto__`/`constructor`/`prototype`, rejects function leaves and
   non-plain-object intermediates, only resolves real `as const` array leaves.
2. `tests/unit/settings-affects-query-keys.test.ts` — walks every `settingsModuleManifest`
   tool's `affectsQueryKeys` and asserts each token resolves. Passing.
3. `apps/web/src/chat/use-chat-stream.ts` — `affectsQueryKeys?: readonly string[]` added to
   `TranscriptRecord`, parsed defensively in `parseRecord`.
   `apps/web/src/shell/app-shell.tsx` — generic `useEffect` (placed right after the
   `pendingNotesDelete` `useMemo`, ~L195): dedupes by `actionRequestId` in a
   `useRef<Set<string>>`, for each executed `action_result` record with `affectsQueryKeys`,
   resolves each token via `resolveQueryKeyToken` and calls
   `queryClient.invalidateQueries({ queryKey: [...resolved] })` only when resolved is defined.
4. `tests/integration/mcp-gateway-self-operation.test.ts` — new test "real settings.themeMode.set
   run threads affectsQueryKeys into the emitted action_result (#1310)": real
   `AiRepository`/`DataContextRunner`/`AssistantToolGateway`, real
   `grantSelfOperationForModule(settingsModuleManifest)`, calls the real
   `settings.themeMode.set` tool, asserts emitted `action_result.affectsQueryKeys` equals
   `["settings.themes"]`. Ran green in isolated gate DB, 10/10 tests passed in that file
   (`rc=0`, log was `/tmp/cb-vf-relay19.log`, since discarded — rerun to reverify if needed).

Backend threading (`affectsQueryKeys` field on manifest/gateway types + 3 emit sites,
`settings.themeMode.set` manifest entry) was already done in an earlier relay, commit `4b5cad05`
— not touched this session, still correct.

## Not started — pick up here (handoff-18's items 5-10, unchanged)

### 5. e2e test
- **First, freshly `Read` `tests/e2e/app-shell.spec.ts` in full** before editing — do not trust
  any stale-content warning silently; if one appears, re-`Read` or use `grep -n` to get ground
  truth before touching the file (this file has a known history of stale reads across sessions).
- Also read `apps/web/src/api/client.ts`'s `listThemes()` (or equivalent) to mock its route
  correctly.
- Mirror the existing `"granted-tier settings tool executes with no Approve/Reject card (#1264)"`
  test's SSE-mock technique (`page.route("**/api/chat/stream", ...)`), feed a real-shaped
  `action_result` record with `toolName: "settings.themeMode.set"`, `outcome: "executed"`,
  `affectsQueryKeys: ["settings.themes"]`, mock the theme-list route to return a changed value on
  refetch, assert the DOM updates (user-visible label or `data-theme` attribute) with **no
  `page.reload()`**.
- **Newly noticed this session, unverified — check before writing:** `MEMORY.md` picked up a new
  entry `vitest-env-pragma-matches-anywhere.md` — "the directive in a plain comment silently flips
  that file's environment." Unclear if it applies to Playwright specs or only vitest unit tests;
  worth a quick check if the new e2e test behaves oddly (e.g. wrong test environment) before
  assuming it's your own bug.
- State plainly in the PR description that this e2e mocks SSE and does not by itself satisfy the
  "real dev instance" exit criterion (see item 9 — now a hard gate, not just Ben's-call-informed).

### 6. Commit the e2e test
`git add tests/e2e/app-shell.spec.ts` (only — everything else from handoff-18's step 6 is already
committed individually this session).

### 7. Pre-push trio + rebase
```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

### 8. Gate run (mandatory isolation — never skip, never pipe the gate command itself)
```bash
GATEDB=jarvis_gate_<your-slug>
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
export JARVIS_PGDATABASE=$GATEDB
( pnpm verify:foundation > /tmp/cb-vf.log 2>&1; echo "### FINAL verify:foundation rc=$?" >> /tmp/cb-vf.log ) &
wait
grep '### FINAL' /tmp/cb-vf.log
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
```

### 9. Live-path UAT proof — HARD MERGE GATE (coordinator correction this session)
Run `.claude/skills/coordinate/resolve-uat-triggers.sh` (empty output ≠ skip). Run against a live
dev instance. Post `gh pr comment` on PR #1276 with UAT output + assertions/evidence — real UI, real
browser, chat turn → tool → visible DOM change. Without this the PR literally cannot merge per
the updated `coordinate` skill family (`8f1b6d44`).

### 10. `coordinated-wrap-up`
Push to PR #1276, update PR description (exit criteria + the mocked-SSE-e2e gap statement +
confirmation that item 9's live proof is attached), report to Coordinator with the live-path
proof. PR/board/merge remain the Coordinator's job — do not merge.

## Traps carried forward
- `Read` on files edited earlier in the same turn can return a stale-content warning with no
  body — use `grep -n` to re-locate exact current content before further edits.
- Never `git add -A` — this worktree/repo is shared; stage explicit paths only.
- Confirm the Coordinator pane fresh via `herdr pane list` (label `Coordinator`) before every
  message — don't reuse a pane id from this doc.
