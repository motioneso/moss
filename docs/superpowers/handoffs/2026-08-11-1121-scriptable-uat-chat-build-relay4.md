# Build relay 4 — #1121 scriptable UAT chat, Tasks 5/6

Ben unblocked Tasks 5/6 at #1557 merged to main (`02951d46b6f`). Branch `build/1121-scriptable-chat`
rebased onto `origin/main` cleanly (no conflicts) — HEAD is now `d79e41156` → `02951d46b` (Tasks
1-4 committed and still green post-rebase: `run-uat.test.ts` + `provisioner.test.ts` +
`prod-compose-cli-tools-prefix.test.ts` = 9/9 pass, rc=0).

Plan doc: `docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md`, Task 5 section
(seed wiring) and Task 6 section (engine-selection regression test) — read those in full before
writing code, this doc only lists deltas from what the plan assumed pre-merge.

## Confirmed against post-merge reality (no more re-checking needed)

- `isBoundedFallbackEngine` — **name unchanged**, not renamed from `isOneShotEngine` as the plan
  speculated. Lives at `packages/chat/src/live/engine-selection.ts:62-68`, signature
  `(provider: ProviderKind, executionMode: AiProviderExecutionMode | undefined): boolean`.
- `createChatEngine` (`engine-selection.ts:75-112`) checks `opts.persistentRuntimeEnabled &&
  provider === "anthropic"` FIRST (lines 84-88), ahead of the `isBoundedFallbackEngine` branch —
  matches the plan's Task 6 test-case description exactly.
- `packages/chat/src/live/engine-selection.test.ts` **does not exist yet** — Task 6 creates it new.
- `INSTANCE_SETTINGS_REGISTRY` in `packages/settings/src/instance-settings-keys.ts:24` **already
  has** `{ key: "chat.persistent_runtime.enabled" }`, non-secret, exactly the shape the plan
  expected — confirms the plan's own instruction: **no edit needed to this file.**

## OPEN QUESTION — resolve before writing chunks/chat-script.ts

The plan's draft chunk code calls `upsertInstanceSetting(..., { value: { value: false }, ... })` —
an object shape. But `instance-settings-keys.ts:20-23`'s comment on the `chat.persistent_runtime.
enabled` entry says **"boolean-string, default absent = off"**, which suggests the real stored
value is a string `"true"`/`"false"`, not `{ value: false }`.

**First thing to do in the fresh session:** read `packages/module-registry/src/chat-multiplexer.ts`
around lines 401-436 (the `chat.persistent_runtime.enabled` pre-auth reader — the file already
greps to have `readPersistentRuntimeEnabled`-shaped functions there, defaulting to off on read
failure) to get the exact value shape the reader expects, and `packages/settings/src/repository.ts`
around line 353 (`upsertInstanceSetting`'s signature) for the `value` field's real type. Match
`chunks/chat-script.ts`'s upsert call to what the reader actually parses — do not trust the plan's
draft object-shape verbatim, it predates #1557 landing.

## Not yet started (all of Task 5 and Task 6 code)

Task 5 files, per plan (none written yet):
- `tests/uat/seed/chunks/chat-script.ts` (new) — mirror `chunks/ai.ts:11-42`'s
  `seedAiProviderChunk` pattern (read it first, already fetched this session — `AiRepository`,
  `createAiSecretCipher`, `runner.withDataContext`). Resolve the value-shape question above before
  writing the `upsertInstanceSetting` call.
- `tests/uat/seed/levels.ts` — insert the `if (options.chatScript) {...}` block the plan specifies,
  between the first `try/finally` close and the `solo-admin` early return (plan cites current lines
  73-77; **re-read the file directly, do not trust the line numbers** — standard drift risk).
- `tests/uat/seed/level-validation.ts` — add `parseUatChatScript`, mirroring `parseUatSeedLevel`.
- `tests/uat/seed/cli.ts` — thread `JARVIS_UAT_SEED_CHAT_SCRIPT` env var through
  `parseUatChatScript` into the `seedLevel({...})` call (plan cites line 83 — re-check).
- Test cases: `seedScriptedChatProviderChunk` (real DB — needs the `verify-gate` skill's gate-DB
  isolation, this one touches a live Postgres, unlike Task 4's pure-mock tests), regression checks
  on `selectChatModelForUser()` with/without `chatScript`, `parseUatChatScript` empty/unknown-id
  cases. Full list in the plan's Task 5 "Test cases" bullet.

Task 6 file, per plan (not written yet):
- New `packages/chat/src/live/engine-selection.test.ts`. Two assertions per plan:
  `isBoundedFallbackEngine("anthropic", "non_interactive")` → `true`; `createChatEngine("anthropic",
  ..., { executionMode: "non_interactive", persistentRuntimeEnabled: false })` returns a
  `ClaudePrintChatEngine` instance, with `persistentRuntimeEnabled: false` passed **explicitly**
  (not omitted) — that's the actual regression case per the plan's own explanation, re-read it.

## Verification not yet run for Tasks 5/6

Nothing — no code written yet this relay. When code is written: scoped vitest per file, repo-wide
`pnpm exec tsc --noEmit` unpiped+sentinel, scoped eslint unpiped+sentinel. Task 5's DB-touching
test needs the `verify-gate` skill's gate-DB-isolation procedure (fresh `jarvis_gate_<slug>` DB,
exported `JARVIS_PGDATABASE`, drop when done) — Task 4 did NOT need this (pure mocks); Task 5 does.

## Shared-checkout state

Confirmed via `herdr pane list` at rebase time: only this session (`Issue #1121 scriptable UAT
(relay3)`) was at this worktree's cwd. Re-check again before the next commit — state may have
changed since.

## Commit boundary

Nothing to commit yet this relay (investigation only, tree is clean post-rebase). Commit Task 5 and
Task 6 as separate commits (mirrors the Task 3 / Task 4 split), each via the `shared-checkout`
skill's explicit-path procedure, each verified with `git show --name-only HEAD` after.
