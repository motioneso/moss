# #1310 settings-write UI refresh — relay continuation (relay 18)

**Issue:** #1310 (chat settings write persists but UI doesn't update without manual refresh)
**PR (existing, push here):** #1276
**Branch/worktree:** `1264-settings-self-operation`, this worktree
**Coordinator label:** `Coordinator` (confirm still exactly one pane with `herdr pane list` before messaging)
**Plan doc:** `docs/superpowers/plans/2026-07-27-settings-write-ui-refresh.md` (written via `writing-plans` format before the `plan-build` skill-update notice arrived — do not redo, just keep executing; future NEW plans in this repo use `plan-build`, not `writing-plans`)

## Exit criteria (all must hold before wrap-up)
1. Settings write via chat reflected on screen with no manual refresh.
2. Invalidation mechanism is GENERIC — declaration-driven via `affectsQueryKeys`, not theme-specific. No hardcoded query key.
3. e2e UAT proves it on a real dev instance: chat turn → tool → DOM assertion on user-visible words. Asserting DB state does not discharge this.
4. `pnpm verify:foundation` green, real captured exit code (never piped).

## Coordinator's 4 binding conditions (approved the plan with these attached — not yet fully satisfied)
1. **Fail-closed token walk.** Unknown token = ignore silently, never throw, never invalidate everything. Reject `__proto__`/`constructor`/`prototype` and any non-own-enumerable property when resolving a server-supplied dot-path string against the client `queryKeys` object.
2. **Build/test-time validation.** `affectsQueryKeys` is an unvalidated manifest string. Add a test that resolves every declared token against the real `queryKeys` object so a typo/rename fails the build, not the user's screen.
3. **Real-execution test, not synthetic.** The gateway test proving `affectsQueryKeys` flows into the emitted `action_result` must run a REAL tool through the REAL gateway (not a hand-built record) — otherwise a mocked e2e and a synthetic unit test can both stay green while the real seam drifts.
4. **State the mocked-SSE-e2e gap plainly in the PR description.** A Playwright test that mocks the SSE stream does not discharge criterion 3's "real dev instance" requirement. Build it anyway (not blocked on this), but say so as a known gap, not a silent downgrade — this is Ben's call to make, informed.

Also noted for own reasoning: this same token-resolution seam is the fix site for module-declared keys later — keep it module-agnostic (it already is, by construction).

## Skill-update notice already in effect this session (supersedes stale in-context copies)
- **Gate isolation is now mandatory and enforced by a blocking hook.** Never run `pnpm verify:foundation` unscoped (an unscoped run on 2026-07-25 took prod chat down 90 min). Must `export` (not inline) an isolated DB:
  ```bash
  GATEDB=jarvis_gate_<your-slug>
  docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
  docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
  export JARVIS_PGDATABASE=$GATEDB
  ( pnpm verify:foundation > /tmp/cb-vf.log 2>&1; echo "### FINAL verify:foundation rc=$?" >> /tmp/cb-vf.log ) &
  # wait for completion, then:
  grep '### FINAL' /tmp/cb-vf.log
  ```
  DROP the gate DB when done. Never pipe the gate command itself (`| tail`/`| grep` — a blocking hook now rejects this). Stagger vs other agents' gate runs (shared dev Postgres).
- **Live-path gate is now part of MY finish line.** If work touches a user-facing feature (this does — chat UI refresh), CI-green + review is not enough. Need a live e2e proof posted as `gh pr comment`: feature exercised through the real UI on a live dev instance, with UAT run output + assertions or bounded DOM/network/log evidence. Resolve which specs via `.claude/skills/coordinate/resolve-uat-triggers.sh` (map is deliberately incomplete — empty output ≠ no proof needed). Without this, report state is "code-complete, unverified" — never "done".
- Plan with `plan-build` skill for any NEW plan (this session's existing plan doc stays as-is).
- Relay strictly at context-meter's 70% warning.
- Report to Coordinator terse and result-first in **normal English** — caveman/telegraph mode is REMOVED from this skill family (this supersedes `coordinated-build`'s in-skill caveman instruction).

## Done (committed: `4b5cad05`)
Backend half of the fix, all typechecked clean:
- `packages/module-sdk/src/index.ts` — added `readonly affectsQueryKeys?: readonly string[];` to `ModuleAssistantToolManifest`.
- `packages/ai/src/gateway/types.ts` — added same field to `GatewaySessionRecord`'s `action_result` variant.
- `packages/ai/src/gateway/gateway.ts` — threaded it at all 3 `result.ok`-gated `action_result` emit sites (yolo path, auto-run path, `confirmAndRun` path), each via:
  ```ts
  ...(result.ok && found.tool.affectsQueryKeys
    ? { affectsQueryKeys: found.tool.affectsQueryKeys }
    : {})
  ```
- `packages/settings/src/manifest.ts` — `settings.themeMode.set` tool entry now declares `affectsQueryKeys: ["settings.themes"]`.
- Memory saved (`mem_ms3sg3nt_234808ccd476`) and Coordinator already notified of this slice via `herdr agent prompt`.

Only `settings.themeMode.set` was wired. Sibling tools (locale ×2, quietHours.set, weatherLocation.set, notificationPreference.setEnabled) were deliberately NOT wired — out of scope for #1310, which is theme-specific in its repro. Don't expand scope unless re-tasked.

## Not started — pick up here

### 1. Shared fail-closed token resolver (blocks everything below — do this first)
Decide location: recommend co-locating with `apps/web/src/api/query-keys.ts` (read in full this session, 136 lines — confirmed shape: nested plain object, `as const` string-array tuples at most leaves, but SOME leaves are factory **functions** taking params — e.g. `notesSourceDirectories`, `connectors.featureGrants`, `ai.terminalStatus`, `ai.runtimeConfig`, `ai.actionAuditLog`, `calendar.detail`, `chat.threads`/`messages`, `memory.dashboard`/`dashboardItem`, `people.notesDirectories`, `tasks.detail`/`activity`/`subtasks`/`tags`, `wellness.schedule`/`adherenceSummary` — resolver must skip/reject these, never call them).

Implement e.g. `resolveQueryKeyToken(token: string): readonly unknown[] | undefined` exported from `apps/web/src/api/query-keys.ts`:
- Split token on `.`.
- Walk `queryKeys` by **own-enumerable-property lookup only** at each segment.
- At each segment, explicitly reject `__proto__`, `constructor`, `prototype` (return `undefined` immediately — fail closed, never throw).
- If a segment is missing, or the final value is a function (not an array), or any intermediate value isn't a plain object — return `undefined`.
- Only return the value if the final resolved leaf is itself a real array (the `as const` tuple).

This one function is used by BOTH the frontend effect (#3 below) and the build-time validation test (#2 below) — do not write two divergent copies.

### 2. Build/test-time validation test (Coordinator condition 2)
New root-level test, e.g. `tests/unit/settings-affects-query-keys.test.ts`. Confirmed this session: root `vitest.config.ts` already aliases both `apps/web/src/...` and backend `@jarv1s/*` packages for cross-import in one test file — 5 precedent files already do this (`tests/unit/chat-attachments-validation.test.ts`, `chat-feedback-layout-css.test.ts`, `module-web-reserved-paths.test.ts`, `page-context-sync.test.ts`, `settings-persona-preview.test.ts`) — copy their import style.

Test: import `queryKeys`/`resolveQueryKeyToken` from `apps/web/src/api/query-keys.ts`, import `settingsModuleManifest` (or equivalent tool list) from `@jarv1s/settings`, walk every tool's `affectsQueryKeys` array (skip tools without one), assert `resolveQueryKeyToken(token)` is defined and is an array for every declared token. This must fail if `"settings.themes"` were ever typo'd or renamed.

### 3. Frontend wiring
- `apps/web/src/chat/use-chat-stream.ts` (214 lines, read in full last session, NOT touched yet) — add `readonly affectsQueryKeys?: readonly string[];` to the `TranscriptRecord` interface; parse it defensively in `parseRecord()` (validate it's a string array else `undefined`).
- `apps/web/src/shell/app-shell.tsx` (read in full last session at lines 1-60/150-249, NOT touched yet) — add a generic `useEffect`: track already-processed `actionRequestId`s in a `useRef<Set<string>>`; for each new record where `kind === "action_result" && outcome === "executed" && affectsQueryKeys`, call `resolveQueryKeyToken` per token, and `queryClient.invalidateQueries({ queryKey: resolved })` only when defined. Never invalidate everything as a fallback.

### 4. Real-execution integration test (Coordinator condition 3)
Extend `tests/integration/mcp-gateway-self-operation.test.ts` (542 lines, read in full this session) — reuse its `"first use after install grant runs without an action card"` pattern (~L89-124): real `AiRepository`/`DataContextRunner`, `grantSelfOperationForModule`, real `AssistantToolGateway`, but call the REAL `settings.themeMode.set` tool from `@jarv1s/settings`'s `settingsModuleManifest` instead of the fixture `exampleToolModule`. Assert the emitted `action_result` record's `affectsQueryKeys` equals `["settings.themes"]`. This is real tool execution end to end — satisfies condition 3 directly.

### 5. e2e test
- **First, freshly `Read` `tests/e2e/app-shell.spec.ts` in full** — two prior attempts (in the session before this one) returned stale-content warnings with no body; its actual current content has never successfully been loaded into context. Do this before writing anything.
- Also read `apps/web/src/api/client.ts`'s `listThemes()` (or equivalent) implementation/route to mock correctly.
- Mirror the existing `"granted-tier settings tool executes with no Approve/Reject card (#1264)"` test's SSE-mock technique (`page.route("**/api/chat/stream", ...)`), feed a real-shaped `action_result` record with `toolName: "settings.themeMode.set"`, `outcome: "executed"`, `affectsQueryKeys: ["settings.themes"]`, mock the theme-list route to return a changed value on refetch, assert the DOM updates (user-visible label or `data-theme` attribute) with **no `page.reload()`**.
- **Then, per Coordinator condition 4: state plainly in the PR description that this e2e mocks SSE and does not by itself satisfy the "real dev instance" exit criterion — the live-path UAT proof (see below) is what closes that gap.**

### 6. Commit frontend slice separately
Stage explicit paths only (never `git add -A`):
```
git add apps/web/src/api/query-keys.ts apps/web/src/chat/use-chat-stream.ts apps/web/src/shell/app-shell.tsx tests/unit/settings-affects-query-keys.test.ts tests/integration/mcp-gateway-self-operation.test.ts tests/e2e/app-shell.spec.ts
```

### 7. Pre-push trio + rebase
```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

### 8. Gate run (new mandatory isolation pattern — see skill-update notice above)
Use the export-based `JARVIS_PGDATABASE` pattern verbatim. DROP the gate DB after.

### 9. Live-path UAT proof (new mandatory requirement)
Run `.claude/skills/coordinate/resolve-uat-triggers.sh` to find applicable specs (empty output does NOT mean skip). Run against a live dev instance. Post `gh pr comment` on PR #1276 with UAT output + assertions/evidence. State the mocked-SSE-e2e gap explicitly in the PR description (condition 4).

### 10. `coordinated-wrap-up`
Push to PR #1276, update PR description (exit criteria + condition-4 gap statement), report to Coordinator with the live-path proof. PR/board/merge remain the Coordinator's job — do not merge.

## Known trap this session
`Read` on files edited earlier in the same turn can return a stale-content warning with no body. Workaround: use `grep -n` to re-locate exact current line numbers/content before further edits — grep isn't subject to the same staleness gate.
