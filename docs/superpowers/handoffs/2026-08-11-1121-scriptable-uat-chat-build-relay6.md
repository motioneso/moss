# Build relay 6 — #1121 scriptable UAT chat, Tasks 5/6

Worktree `/home/ben/Jarv1s/.claude/worktrees/1121-scriptable-uat-chat`, branch
`build/1121-scriptable-chat`. Tree clean, HEAD `bffdefbfb`, 7 commits ahead of origin/main.
Tasks 1-4 done/green. This relay did ONLY verification (no code written, nothing to commit) —
relayed at the 70% context-meter warning before writing any code. `herdr pane list` at relay-start
showed only this session's own pane (`w1:p7R`, label "Issue #1121 scriptable UAT (relay6)") at this
cwd — no collision, but **re-check `herdr pane list` fresh** before your first commit regardless.

**Do NOT re-read relay5's handoff or the full plan doc** — everything you need is below, already
re-verified against the current branch state this relay. Go straight to writing code.

## Value-shape (CONFIRMED against `packages/module-registry/src/chat-multiplexer.ts:405-417`
`readPersistentRuntimeEnabled`)

Reader: `const raw = (row?.value as {value?:unknown}|undefined)?.value; return raw === "true";`
— compares against the **string** `"true"`. The plan doc's Task 5 prose says
`value: { value: false }` (boolean) — **that is wrong, do not use it.** Use:

```ts
await new SettingsRepository().upsertInstanceSetting(scopedDb, {
  key: "chat.persistent_runtime.enabled",
  value: { value: "false" },
  updatedByUserId: actorUserId,
  requestId: "uat-seed-chat-script"
});
```

`packages/settings/src/instance-settings-keys.ts:24` already has the registry entry (#1557) — no
edit needed, confirmed.

## Task 5 — write these files (all confirmed against current branch state, no drift)

**`tests/uat/seed/chunks/chat-script.ts`** (new) — mirror `chunks/ai.ts:11-42` exactly:
```ts
import type { DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { SettingsRepository } from "@moss/settings";

export async function seedScriptedChatProviderChunk(
  runner: DataContextRunner,
  actorUserId: string
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: "anthropic",
      displayName: "UAT Scripted Provider",
      executionMode: "non_interactive",
      encryptedCredential: cipher.encryptJson({ cli: true })
    });
    const model = await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: "uat-scripted-chat-model",
      displayName: "UAT Scripted Chat Model",
      capabilities: ["chat"]
    });
    await new SettingsRepository().upsertInstanceSetting(scopedDb, {
      key: "chat.persistent_runtime.enabled",
      value: { value: "false" },
      updatedByUserId: actorUserId,
      requestId: "uat-seed-chat-script"
    });
  });
}
```
(Confirm `SettingsRepository` package export path is `@moss/settings` — check another chunk file's
import or `packages/settings/src/index.ts` if unsure; not re-verified this relay.)
`CreateAiProviderInput`/`CreateAiModelInput` confirmed at `packages/ai/src/repository.ts:130-158`;
`createProvider` defaults `status: "active"` (repository.ts:385) — no need to pass status.

**`tests/uat/seed/chunks/chat-script.test.ts`** (new) — mirror `chunks/ai.test.ts` structure
exactly: `createMigrationOwnerDb()` + `seedSoloAdmin(migrationDb)` from `../admin.js` +
`./connections.js`, `destroy()`, `createAppRuntimeRunner()`, run the chunk, then assert via a
fresh `AiRepository`/`SettingsRepository` inside `runner.withDataContext`: exactly one active
`anthropic`/`non_interactive` provider, one `chat`-capable model, one instance-setting row with
`value.value === "false"`. Needs `verify-gate` skill's gate-DB isolation (fresh
`jarvis_gate_<slug>` DB via `JARVIS_PGDATABASE`, drop when done) — real DB test.

**`tests/uat/seed/levels.ts`** — confirmed insertion point: between line 73
(`} finally { await migrationDb.destroy(); }`) and line 75
(`if (options.level === "solo-admin") return;`), insert:
```ts
if (options.chatScript) {
  const scriptedRunner = createAppRuntimeRunner();
  try {
    await seedScriptedChatProviderChunk(scriptedRunner, adminUserId);
  } finally {
    await scriptedRunner.destroy();
  }
}
```
Add the `seedScriptedChatProviderChunk` import at top. Deliberately a second scoped runner, not a
restructure of the existing `runner` (line 80).

**`tests/uat/seed/level-validation.ts`** — current file has `parseUatSeedLevel`/
`parseUatExcludeChunks` only (confirmed, read in full this relay). Add, importing
`UAT_CHAT_SCRIPTS`/`UatChatScript` from `./types.js` (already has `UatChatScript = "phase1-smoke"`,
`UAT_CHAT_SCRIPTS`, both confirmed present, no edit needed there):
```ts
export function parseUatChatScript(raw: string): UatChatScript | undefined {
  if (raw === "") return undefined;
  if (!(UAT_CHAT_SCRIPTS as readonly string[]).includes(raw)) {
    throw new Error(
      `unknown UAT chat script "${raw}" — refusing to seed (fail-closed); ` +
        `expected one of: ${UAT_CHAT_SCRIPTS.join(", ")}`
    );
  }
  return raw as UatChatScript;
}
```
Empty-string → `undefined` convention confirmed matches job-search's base-url var
(`cli.ts:80-81`: `resolveMossEnv(...) || undefined`), NOT `parseUatSeedLevel`'s convention (which
requires a value). Add tests to `level-validation.test.ts` (existing file, read in full — mirror
its `describe` block style): empty → undefined, unknown → throws, known id → passthrough.

**`tests/uat/seed/cli.ts`** — `seedLevel({...})` call confirmed at line 83 exactly. Add:
```ts
const chatScript = parseUatChatScript(
  resolveMossEnv(process.env, "JARVIS_UAT_SEED_CHAT_SCRIPT") ?? ""
);
```
Thread into the `seedLevel({ level, excludeChunks, withoutNewsJsonBinding,
jobSearchAiProviderBaseUrl, chatScript })` call. Add `parseUatChatScript` to the existing
level-validation import.

**`tests/uat/seed/levels.test.ts` regression cases** (existing file, read in full — mirror its
`describe("seedLevel", ...)` style, uses `createAppRuntimeRunner`/`createMigrationOwnerDb` from
`./connections.js`): `seedLevel({ level: "solo-admin" })` (no chatScript) still leaves
`new AiRepository().selectChatModelForUser(scopedDb)` ⇒ `null`; `seedLevel({ level: "solo-admin",
chatScript: "phase1-smoke" })` makes it resolve the neutral scripted model.

## Task 6 — `packages/chat/src/live/engine-selection.test.ts` (new file, none exists yet, confirmed)

`engine-selection.ts` confirmed current (read in full this relay): `isBoundedFallbackEngine`
lines 62-68, `createChatEngine` 75-112, persistentRuntimeEnabled branch checked first (84-88).
`ClaudePrintChatEngine` constructor (`claude-print-chat-engine.ts:47-55`) confirmed side-effect-free
(just stores opts) — a bare `fakeIo` stub is enough, no `spawn` mock needed. Use ONLY this minimal
helper (do not import the `fakeChild`/`spawnMock` machinery from
`tests/unit/claude-print-chat-engine.test.ts:43-59` — that's for launch-behavior tests, not needed
here):
```ts
import { describe, expect, it } from "vitest";
import type { TmuxIo } from "@moss/ai";
import { isBoundedFallbackEngine, createChatEngine } from "./engine-selection.js";
import { ClaudePrintChatEngine } from "./claude-print-chat-engine.js";

function fakeIo(): TmuxIo {
  return {
    async run() { return { code: 0, stdout: "" }; },
    async readFile() { throw new Error("not used"); },
    async writeFile() {},
    async sleep() {}
  };
}

describe("isBoundedFallbackEngine", () => {
  it("anthropic + non_interactive is bounded-fallback", () => {
    expect(isBoundedFallbackEngine("anthropic", "non_interactive")).toBe(true);
  });
});

describe("createChatEngine", () => {
  it("selects ClaudePrintChatEngine when persistentRuntimeEnabled is explicitly false", () => {
    const engine = createChatEngine("anthropic", "session-1", fakeIo(), {
      executionMode: "non_interactive",
      persistentRuntimeEnabled: false
    });
    expect(engine).toBeInstanceOf(ClaudePrintChatEngine);
  });
});
```
(Check `TmuxIo`'s exact method signatures against `@moss/ai`'s export if the above doesn't
typecheck — not re-verified field-by-field this relay, only cross-checked against the
`claude-print-chat-engine.test.ts` fakeIo shape above.) The `persistentRuntimeEnabled: false` must
be explicit — that's the actual regression case (proves Task 5's seeded pin keeps bounded engine
selected even though #1557's real consumer now exists).

## Next steps (unchanged from relay5, restart the coordinated-build skill's Build step)

1. Follow `coordinated-build` skill from Build step (planning done upstream). TDD each file above.
2. Scoped vitest per file; Task 5's DB test needs `verify-gate` skill gate-DB isolation.
3. Commit Task 5, then Task 6, separately via `shared-checkout` skill (explicit paths, never
   `git add -A`), `git show --name-only HEAD` after each. Re-check `herdr pane list` before each
   commit.
4. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`,
   full gate (`verify-gate` skill → `pnpm verify:foundation`, expect EXIT=0).
5. `coordinated-wrap-up`: push, open/update PR, live-path proof or honest "code-complete,
   unverified" (Task 5/6 don't touch a UI surface directly — Phase 1 exit criteria here are the
   vitest/tsc/eslint/verify:foundation gates). Message the `Coordinator` label pane (re-resolve
   fresh via `herdr pane list`, do NOT reuse `w1:p7R` or any pane id from this file — they reflow)
   tagging tier `sensitive`.
6. Never touch `docs/coordination/`, no repo-wide `pnpm format`, no broad `git add`, never move the
   board/close the issue/merge.

If you hit the 70% meter warning or see a compaction summary before finishing: commit whatever is
green first, then relay again per the `relay` skill.
