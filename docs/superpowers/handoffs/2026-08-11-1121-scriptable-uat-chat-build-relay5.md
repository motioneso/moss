# Build relay 5 — #1121 scriptable UAT chat, Tasks 5/6

Worktree `/home/ben/Jarv1s/.claude/worktrees/1121-scriptable-uat-chat`, branch
`build/1121-scriptable-chat`. Tree clean, HEAD `bffdefbfb`, 7 commits ahead of origin/main. Tasks
1-4 done and green (see `...-build-relay4.md`). This relay did full pre-code verification for
Tasks 5/6 against the CURRENT branch state — zero drift found anywhere, no re-verification needed.
No code written yet. Coordinator (`coord-relay9`, pane label `Coordinator`) notified of this relay.

## Value-shape resolution (CONFIRMED, do not re-derive)

Reader `packages/module-registry/src/chat-multiplexer.ts:405-415` `readPersistentRuntimeEnabled`:
`const raw = (row?.value as {value?:unknown}|undefined)?.value; return raw === "true";` — object
wrapper `{value: <string>}`, compared against the literal string `"true"`.

Writer `packages/settings/src/repository.ts:29-38` `UpsertInstanceSettingInput.value: Record<string,
unknown>` — no coercion, persisted verbatim.

**Task 5's seed chunk must call** `upsertInstanceSetting(scopedDb, { key:
"chat.persistent_runtime.enabled", value: { value: "false" }, updatedByUserId: actorUserId,
requestId: "uat-seed-chat-script" })` — string `"false"`, not boolean. This pins the bounded
engine (off).

`packages/settings/src/instance-settings-keys.ts:24` already has `{ key:
"chat.persistent_runtime.enabled" }` (#1557, non-secret) — **no edit needed**.

## Task 5 — confirmed current file states (re-read this relay, all match plan citations exactly)

- `tests/uat/seed/types.ts` — **already has** (from Task 1, no edit needed): `UatChatScript =
  "phase1-smoke"` (line 47), `UAT_CHAT_SCRIPTS` (49), `SeedOptions.chatScript?: UatChatScript`
  (70).
- `tests/uat/seed/chunks/ai.ts:11-42` `seedAiProviderChunk` — exact template to mirror (imports
  `DataContextRunner` from `@moss/db`, `AiRepository`/`createAiSecretCipher` from `@moss/ai`, one
  `runner.withDataContext({actorUserId}, async (scopedDb) => {...})` block).
- `tests/uat/seed/chunks/ai.test.ts` — exact test template: `createMigrationOwnerDb()` +
  `seedSoloAdmin(migrationDb)` from `../admin.js`/`./connections.js`, then `destroy()`, then
  `createAppRuntimeRunner()`, run the chunk, assert via a fresh `AiRepository` inside
  `runner.withDataContext`.
- `packages/ai/src/repository.ts:130-138` `CreateAiProviderInput` (`providerKind`, `displayName`,
  `executionMode?`, `encryptedCredential`) and `:150-158` `CreateAiModelInput`
  (`providerConfigId`, `providerModelId`, `displayName`, `capabilities`, ...) — both confirmed
  current, match plan's Task 5 chunk spec verbatim. `AiProviderKind` (`packages/shared/src/
  ai-types.ts:1`) includes `"anthropic"`.
- `tests/uat/seed/levels.ts` — insertion point confirmed **exactly** at plan's cited lines: the
  first `try/finally`'s close is line 73 (`} finally { await migrationDb.destroy(); }`), the
  `if (options.level === "solo-admin") return;` is lines 75-77. Insert the `if
  (options.chatScript) {...}` block (plan's exact code, using `createAppRuntimeRunner()` +
  `seedScriptedChatProviderChunk` + its own `try/finally destroy()`) between them, unchanged from
  plan.
- `tests/uat/seed/level-validation.ts` — current file has `parseUatSeedLevel`/
  `parseUatExcludeChunks` only, **no `parseUatChatScript` yet** — add it, mirroring
  `parseUatSeedLevel`'s fail-closed pattern exactly (empty string → `undefined`, unknown →
  throws).
- `tests/uat/seed/cli.ts` — `seedLevel({...})` call confirmed at **line 83** exactly as plan
  cites; add `JARVIS_UAT_SEED_CHAT_SCRIPT` read via `resolveMossEnv(process.env,
  "JARVIS_UAT_SEED_CHAT_SCRIPT") ?? ""` through `parseUatChatScript`, thread into the call as
  `chatScript`.

**Remaining work, exactly per plan's Task 5 "Files" + "Test cases" sections** (plan doc:
`docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md`, read that section fresh, it's
short): write `chunks/chat-script.ts`, its test (real DB — gate-DB isolation via `verify-gate`
skill, mirror `chunks/ai.test.ts`), the `levels.ts` insert, `parseUatChatScript` +
its test, `cli.ts` env threading, and the `levels.test.ts` regression cases (solo-admin
with/without `chatScript` against `selectChatModelForUser()`).

## Task 6 — confirmed current file state

`packages/chat/src/live/engine-selection.ts` matches handoff-relay4 and plan exactly:
`isBoundedFallbackEngine(provider, executionMode)` at lines 62-68 (pure rename from
`isOneShotEngine`, confirmed already landed), `createChatEngine` at 75-112 checks
`opts.persistentRuntimeEnabled && provider === "anthropic"` FIRST (lines 84-88) ahead of the
bounded-fallback branch. **No test file exists yet anywhere under `packages/chat/src/live/`** —
create `packages/chat/src/live/engine-selection.test.ts` new.

`ClaudePrintChatEngine` constructor (`claude-print-chat-engine.ts:47-55`) is side-effect-free at
construction (just stores opts) — a bare `fakeIo` stub is enough for the `toBeInstanceOf` check.
Reuse the exact `fakeIo(files = {})` helper pattern from `tests/unit/claude-print-chat-engine.
test.ts:43-59` (`TmuxIo` type from `@moss/ai`).

**Test cases, verbatim from plan Task 6:**
1. `isBoundedFallbackEngine("anthropic", "non_interactive")` → `true`.
2. `createChatEngine("anthropic", <sessionKey>, <fakeIo>, { executionMode: "non_interactive",
   persistentRuntimeEnabled: false })` → `toBeInstanceOf(ClaudePrintChatEngine)`. The
   `persistentRuntimeEnabled: false` must be passed **explicitly**, not omitted — that's the actual
   regression case (proves Task 5's seeded pin keeps the bounded engine selected even though
   #1557's real consumer now exists).

## Shared-checkout state

Only this session's pane at this worktree cwd is active (`herdr pane list` at relay-start showed
one other pane at the same cwd, labeled "Issue #1121 scriptable UAT (relay3)", `agent_status:
"done"` — stale, not running). Re-check `herdr pane list` again before your first commit.

## Commit boundary

Nothing committed this relay (verification only, tree still clean at `bffdefbfb`). Commit Task 5
and Task 6 separately (mirrors Task 3/Task 4 split), each via `shared-checkout` skill's
explicit-path procedure, each verified with `git show --name-only HEAD` after.

## Next steps for successor

1. Follow `coordinated-build` skill from step 2 (Build) — planning/approval already happened
   upstream (this plan doc), step ½/1 verification is DONE (this doc).
2. Write Task 5 files + tests (list above), Task 6 test (list above).
3. Scoped vitest per file; repo-wide `pnpm exec tsc --noEmit` unpiped+sentinel; scoped eslint
   unpiped+sentinel. Task 5's DB test needs `verify-gate` skill's gate-DB isolation (fresh
   `jarvis_gate_<slug>` DB, exported `JARVIS_PGDATABASE`, drop when done).
4. Commit per task (shared-checkout skill, explicit paths, never `git add -A`).
5. Full gate (`verify-gate` skill → `pnpm verify:foundation`), then `coordinated-wrap-up`
   (push after pre-push trio, open/update PR, live-path proof or honest "code-complete,
   unverified" status), message the `Coordinator` label pane (re-resolve fresh — do NOT reuse
   `w1:p7P`, pane ids reflow) tagging tier `sensitive`.
6. Never touch `docs/coordination/`, no repo-wide `pnpm format`, no broad `git add`.
