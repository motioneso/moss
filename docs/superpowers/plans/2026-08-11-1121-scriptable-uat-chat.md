# Plan — #1121: deterministic scriptable UAT chat

Part of #1121 (`task` label, open). Spec (approved):
`docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md`. Risk tier: `sensitive`.

This plan covers **Phase 1 only** in task detail (fixture contract + executable + harness/seed
wiring + unit/integration tests = spec §§1-3 + automated checks 1-5). Phase 2 (convert the 7 mapped
UAT specs + new confirmation spec + live-path evidence = automated check 6) is scoped but not
task-broken-down here — it is kill-gated on Coordinator review of Phase 1, per plan-build rule 6.

## Seams check

Carried forward, re-confirmed this session per relay1/relay2 (`docs/superpowers/handoffs/2026-08-11-
1121-scriptable-uat-chat-relay.md`, `...-relay2.md`) — not re-verified again here, trusted:

- `tests/uat/run-uat.ts:45-46` `readUatLevel` regex; `tests/uat/provisioner.ts` `UatProvisionOptions`
  608-618, `provisionForUat` 663-665, `SeedHook` 368-376, `composeSeedHook` 391-421.
- `tests/uat/seed/guard.ts:20` `assertTargetIsEphemeral`, called at `cli.ts:47-59`/`admin.ts:35`.
- `tests/uat/seed/chunks/ai.ts:11-42` `seedAiProviderChunk` — direct template.
- `packages/chat/src/live/claude-print-chat-engine.ts` `buildCommand` 245-282, `buildStructuredCommand`
  285-310 (must be rejected), `writeClaudeMcpConfig` 312-330.
- `packages/ai/src/adapters/tmux-bridge.ts:93` `transcriptGlobDir(provider, cwd, homeBase?)`.
- `packages/ai/src/gateway/confirmation-registry.ts:12`, `gateway.ts` `confirmAndRun` 528 (called
  218/247), read-only bypass 470.
- `apps/web/src/chat/action-request-card.tsx:62` `.action-request-card` selector.
- No server-side `mcp__jarvis__<name>` transform exists (`packages/chat/src/routes.ts:277`,
  `packages/ai/src/gateway/gateway.ts:256`, `claude-permission-hook.ts:409`) — fixture derives the
  dot→underscore name itself.
- Fixmes to replace: `runtime-context.uat.spec.ts:111,122`; `1133-chat-attachments.uat.spec.ts:155`;
  `1264-settings-self-operation.uat.spec.ts:87`; `self-operation-content-commands.uat.spec.ts:44,51,59`;
  `1311-install-grant.uat.spec.ts:94`; `app-map-grounding.uat.spec.ts` 12 deferral comments 10-139.
- `tests/uat/seed/levels.ts:58-77` `seedLevel` — early `return` at 75-77 for `solo-admin`, before
  `seedAiProviderChunk` at line 89 (gap 3, below). `tests/uat/seed/types.ts` `SeedOptions` (43-56, no
  `chatScript` field yet). `tests/uat/seed/cli.ts:74-83` env-var reads + `seedLevel` call at 83.

New this session (not in relay1/relay2, needed for exact signatures):

- `packages/settings/src/instance-settings-keys.ts:14-23` `INSTANCE_SETTINGS_REGISTRY` — flat array
  of `{key, secret?}`; `chat.multiplexer` (line 16) is the closest non-secret `chat.*` precedent for
  the new `chat.persistent_runtime.enabled` entry.
- `packages/settings/src/repository.ts:29-38` `UpsertInstanceSettingInput` (`key`, `value:
Record<string, unknown>`, `updatedByUserId`, `requestId`, optional `action`/`metadata`);
  `:353-373` `SettingsRepository.upsertInstanceSetting`; `:520-527` `setRegistrationSettings` shows
  the boolean-value convention: `value: { value: <boolean> }`.
- **On `main` @ `7aa85f628`** (this branch's base): `packages/chat/src/live/engine-selection.ts:44-53`
  exports `isOneShotEngine(provider, executionMode)`, selecting the bounded engine purely from
  `(provider, executionMode)`; `chat.persistent_runtime.enabled` has zero consumers (matches relay1's
  zero-grep-match finding).
- **On `#1557`'s branch** (`worktrees/1557-p1-persistent-adapter`, checked directly, not just via
  the Coordinator's report): the function is renamed `isOneShotEngine` →
  `isBoundedFallbackEngine(provider, executionMode)` (`engine-selection.ts:62-68`, same signature,
  same tuple-only logic — a pure rename), and `createChatEngine` (`:75-90`) gains a real consumer:
  `opts.persistentRuntimeEnabled` (boolean, resolved from `chat.persistent_runtime.enabled` by
  `runtime.ts:114-138`) checked _before_ the bounded-fallback branch — `true` + `provider ===
"anthropic"` now routes to `ClaudePersistentRuntimeEngine` instead of `ClaudePrintChatEngine`.
  **Merge-order collision, Coordinator-flagged:** Task 6's regression test must target the
  post-#1557 name/shape, and Task 5's seed-written `chat.persistent_runtime.enabled = { value: false
}` is what keeps scripted UAT on the bounded-fallback engine once #1557 lands (this pin is now
  load-bearing, not inert — see Dependency/merge order below).
  Automated check 5 stays a **regression test of existing selection behavior**, not new logic; Phase
  1 registers + pins the key, it does not build #1557's persistent-runtime engine itself (still
  out of scope here).
- `packages/ai/src/repository.ts:131-146` `CreateProviderInput`/model-create fields (`providerKind`,
  `executionMode?` defaults `"non_interactive"` at :391, `capabilities: readonly AiModelCapability[]`
  at :154); `:1411-1424` `selectChatModelForUser` → `getChatModelOverrideSettings` →
  `selectModelForCapability(scopedDb, "chat")` — an active, unbound `chat`-capable model is
  automatically selectable (same implicit-default-provider fallback `ai.ts:16-19` documents).
- `tests/uat/seed/level-validation.ts:1-38` `parseUatSeedLevel`/`parseUatExcludeChunks` — fail-closed
  pattern to mirror for the new `parseUatChatScript`.
- `tests/uat/provisioner.ts:446-478` `createUatProvisionPlan` — `up -d jarv1s --wait` step at line
  469 is where `JARVIS_CLI_TOOLS_PREFIX` must be process-env-overridden before spawn; `:549-575`
  `runCommand` uses bare `spawn(command, args, {...})` with no `env` override, so it inherits
  `process.env` — same technique already used at `:362`
  (`process.env[REAL_CHAT_ENV_FILE_RESULT_ENV] = path`).
- `infra/docker-compose.prod.yml:152` hardcodes `JARVIS_CLI_TOOLS_PREFIX: /data/cli-tools` (relay1
  citation, trusted, not re-read this session).

## Non-goals (per spec, unchanged)

Real-model instruction-following/tool-choice/prose proof; provider auth/discovery/billing/latency;
generic model simulation, fixture loops/branching/inheritance/record-replay/provider-parity; mocking
REST/repositories/MCP gateway/confirmation registry/RLS/vault/module handlers; #1089 latency
injection; #1557's persistent-runtime selection or live-path evidence.

## Determinism boundary

- Fixture owns tool choice, fixture-declared arguments, and the final reply only — never DB/vault
  writes, never a product REST shortcut (locked boundary 2).
- Default behavior (no `chatScript`) byte-for-byte unchanged: no scripted provider, normal
  `/data/cli-tools`, existing credential-free seed, `selectChatModelForUser()` stays `null` (boundary
  3, automated check 3).
- Confirmation-registry flow stays real; a confirmation-required write renders `.action-request-card`
  and executes only after Playwright clicks Approve — no scripted-mode bypass (boundary 7).
- Actor identity comes only from the server-minted MCP bearer read out of `--mcp-config`; fixtures
  never carry actor/user IDs (boundary 6). Bearer is used only in the Authorization header — never
  logged, persisted, or placed in evidence (boundary 5).
- Scripted transport is pinned bounded one-shot only: `-p` + exactly one session flag required;
  `buildStructuredCommand`'s stream-JSON shape is recognized only to be rejected non-zero with the
  locked-boundary-10 diagnostic (boundary 10).
- No model guidance/prompt text is authored by this change — the fixture's "prompt" is deterministic
  fixture data, not an LLM instruction budget. N/A here.

## Phase 1 tasks

### Task 1 — chat-script allowlist + fixture contract types

**Files:**

- `tests/uat/seed/types.ts` — add `export type UatChatScript = "runtime-context" | ...` (start with
  only the id(s) Task 6's own tests back with real fixture JSON; each Phase-2 task appends its id
  when it adds that id's fixture JSON — mirrors `UAT_SEED_LEVELS`/`UAT_SEED_CHUNKS`) and
  `export const UAT_CHAT_SCRIPTS: readonly UatChatScript[]`; add `readonly chatScript?: UatChatScript`
  to `SeedOptions`.
- `tests/uat/fixtures/scripted-provider/script-schema.ts` (new) — exports:
  ```ts
  export interface ChatScriptCall {
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }
  export interface ChatScriptTurn {
    readonly expectIncludes: readonly string[];
    readonly calls: readonly ChatScriptCall[];
    readonly reply: string;
  }
  export interface ChatScriptFixture {
    readonly version: 1;
    readonly turns: readonly ChatScriptTurn[];
  }
  export function loadChatScriptFixture(id: UatChatScript): ChatScriptFixture;
  export function resolveCaptures(value: unknown, captures: ReadonlyMap<string, unknown>): unknown;
  ```
  `loadChatScriptFixture` reads `tests/uat/fixtures/chat-scripts/<id>.json`, validates shape (version
  === 1, turns is a non-empty array, no unknown keys, `${name}` tokens only reference declared
  captures), throws on any deviation — no loops/conditionals/sleeps/JS/shell/URLs/inheritance (spec
  §1). `resolveCaptures` implements the closed set: `firstAttachmentId` and JSON-pointer lookups into
  a prior MCP result; throws on unknown capture name or invalid pointer.

**Test cases (behavior, not bodies):**

- Valid minimal fixture loads and round-trips.
- Missing file, malformed JSON, `version !== 1`, empty `turns`, unknown top-level key, or a
  `${unknownCapture}` reference each throw with a distinguishing message.
- `resolveCaptures` substitutes a known capture recursively inside nested arguments and throws on an
  invalid JSON pointer.

### Task 2 — fixture executable: launch-shape parsing + state cursor

**File:** `tests/uat/fixtures/scripted-provider/bin/claude` (new, executable Node script).

Exports (for unit testing without spawning a process) from a co-located
`tests/uat/fixtures/scripted-provider/launch-args.ts`:

```ts
export type ParsedLaunch =
  | {
      readonly kind: "bounded";
      readonly sessionFlag: { mode: "new" | "resume"; id: string };
      readonly mcp?: { configPath: string; allowedTools: readonly string[] };
      readonly promptText: string;
      readonly model?: string;
    }
  | { readonly kind: "no-mcp"; readonly promptText: string }
  | { readonly kind: "rejected"; readonly reason: string };
export function parseClaudeLaunchArgs(argv: readonly string[]): ParsedLaunch;
```

Recognizes exactly the flag set in spec §2 (`-p`, `--session-id`/`--resume`, `--permission-mode
dontAsk`, `--mcp-config`/`--settings`/`--allowedTools` or `--tools ""`, `--append-system-prompt-file`,
`--strict-mcp-config`, optional `--model`, trailing prompt) plus the `buildStructuredCommand` shape
(`--print --input-format stream-json --output-format stream-json --include-partial-messages
--verbose --no-session-persistence ... --json-schema ...`), which always parses to `"rejected"`.
`"no-mcp"` (bare `--tools ""`) always fails closed per spec §2 ("cannot prove the real gateway
without `--mcp-config`").

State cursor: `tests/uat/fixtures/scripted-provider/session-state.ts`:

```ts
export interface ScriptCursor {
  readonly scriptId: string;
  readonly turnIndex: number;
  readonly captures: Readonly<Record<string, unknown>>;
}
export function readCursor(stateDir: string, sessionId: string): ScriptCursor | undefined;
export function writeCursor(stateDir: string, sessionId: string, cursor: ScriptCursor): void; // mode 0600
```

Never stores prompt text, MCP config, bearer, tool results, or attachment content (spec §2 point 2).

**Test cases:**

- Each documented flag combination parses to the expected `ParsedLaunch`; missing `-p`, missing a
  session flag, both session flags, or an unrecognized flag → `"rejected"`.
- The full `buildStructuredCommand` shape → `"rejected"` with the bounded-engine diagnostic reason.
- Bare `--tools ""` → `"no-mcp"` (parses) but Task 3's caller fails it closed before any MCP call.
- `writeCursor` then `readCursor` round-trips; a missing/mismatched prior cursor is reported as
  `undefined` (caller treats as "must be turn 0" and rejects otherwise).
- Written state file has mode `0600` (`fs.statSync(...).mode & 0o777 === 0o600`).

### Task 3 — fixture executable: MCP call + transcript append (main entrypoint)

**File:** `tests/uat/fixtures/scripted-provider/bin/claude` main body wires Tasks 1+2 to:

1. read `--mcp-config`, extract `url`/`headers.Authorization` bearer from the
   `{mcpServers:{jarvis:{type:"http",url,headers:{Authorization:"Bearer <token>"},timeout}}}` shape
   (`claude-print-chat-engine.ts:312-330` `writeClaudeMcpConfig` is the writer to match);
2. require the URL to be the in-stack `/api/mcp` endpoint;
3. call `tools/list`, require the fixture-declared bare tool name present;
4. derive `mcp__jarvis__<dot-to-underscore tool name>` and require it to match a command-line
   `--allowedTools` pattern (exact or trailing-`*` prefix only — no regex);
5. call `tools/call` with fixture arguments (captures resolved via Task 1's `resolveCaptures`);
6. on a confirmation-pending response, poll/wait for the real registry outcome (no fixed sleep — poll
   the JSON-RPC result until terminal, bounded by the harness's existing UAT timeout) rather than
   assuming synchronous completion;
7. on success, append `assistant` tool-activity + final `assistant`/`end_turn` records to
   `transcriptGlobDir("anthropic", cwd, process.env.JARVIS_CLI_HOME_BASE)/<sessionId>.jsonl` (must
   call `@moss/ai`'s exported helper, never reimplement path encoding) and exit 0;
8. on any failure (undeclared tool, out-of-pattern tool, MCP error, mismatched `expectIncludes`,
   ambiguous/zero eligible turns, EOF before all turns) exit non-zero, append nothing, and write to
   stderr only script id / turn index / failure class.

**Test cases (integration, real DB + real MCP, no browser):**

- Valid bounded invocation against a seeded read-only tool: `tools/list` succeeds, `tools/call`
  succeeds, transcript record appended, exit 0.
- Undeclared tool and a declared-but-out-of-`--allowedTools`-pattern tool both fail before
  `tools/call` is ever issued (assert via a spy/mock transport that `tools/call` was not sent).
- A confirmation-required write stays unmutated until registry approval, then completes after
  approval (drives the real `ConfirmationRegistry`, not a bypass).
- No prompt text, MCP config contents, bearer, tool arguments/results, or reply text appears in
  captured stderr for any failure case.

### Task 4 — harness wiring: `chatScript` threading + compose fix

**Files:**

- `tests/uat/run-uat.ts` — extend the `readUatLevel` regex (currently
  `.../export\s+const\s+uatLevel\s*=\s*\{...\}\s+as const/` at lines 45-46) with one more optional
  trailing group `(?:,\s*chatScript:\s*["']([a-zA-Z0-9_-]+)["'])?` after `withJobSearchFixture`;
  validate the captured id against `UAT_CHAT_SCRIPTS` (throw `invalid uatLevel.chatScript` if not
  present, mirroring the existing `invalid uatLevel.level`/`without chunk` throws at lines 57-63);
  thread into `provisionForUat`'s second argument as `chatScript`.
- `tests/uat/provisioner.ts` — add `readonly chatScript?: UatChatScript` to `UatProvisionOptions`
  (608-618); thread through `buildSeedHookInput` into `SeedHook`'s ctx (368-376) as `chatScript?:
string`; `composeSeedHook` (391-421) adds `-e JARVIS_UAT_SEED_CHAT_SCRIPT=${chatScript ?? ""}`
  alongside the existing `-e` entries. In `provisionForUat`, immediately before the
  `createUatProvisionPlan` step that runs `up -d jarv1s --wait` (currently line 469), when
  `opts?.chatScript` is set: `process.env.JARVIS_CLI_TOOLS_PREFIX =
"/app/tests/uat/fixtures/scripted-provider"`; restore/delete the override in the function's
  existing `finally`/teardown path so it never leaks into a later provisioning attempt in the same
  process (mirrors the `process.env[REAL_CHAT_ENV_FILE_RESULT_ENV]` precedent at line 362).
- `infra/docker-compose.prod.yml:152` — change `JARVIS_CLI_TOOLS_PREFIX: /data/cli-tools` to
  `JARVIS_CLI_TOOLS_PREFIX: ${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}`. Prod default unchanged
  (compose reads the shell/`.env` value only if set); scripted UAT runs set it via the provisioner
  as above.

**Test cases:**

- `readUatLevel` (via `run-uat.test.ts`, existing file) parses a spec with `chatScript: "..."` present
  and absent; an unknown id throws.
- `buildSeedHookInput`/`composeSeedHook` arg-building test (new, in `provisioner`'s existing test
  file if one exists, else a new `tests/uat/provisioner.test.ts` scoped to pure arg-building, no
  Docker) asserts the `-e JARVIS_UAT_SEED_CHAT_SCRIPT=...` entry appears only when `chatScript` is
  set, empty string otherwise (same "always pass, empty means off" convention as the job-search var).
- `docker compose -f infra/docker-compose.prod.yml config --quiet` (with and without
  `JARVIS_CLI_TOOLS_PREFIX` exported) resolves to `/data/cli-tools` by default and to the exported
  value when set — asserts the compose fix is correct without a live stack.

### Task 5 — seed wiring: scripted provider chunk + gap-3 solo-admin call + instance setting

**Blocked on #1557 merging to `main` — do not build any part of this task before then.** Per
Coordinator ruling (Dependency/merge order below), Tasks 5 and 6 both wait so the seed chunk and its
test are written once against the real post-merge registry/engine-selection state, not against a
guess.

**Files:**

- `packages/settings/src/instance-settings-keys.ts` — **#1557 adds this same key first** (its own
  Phase 1 registers `chat.persistent_runtime.enabled` for its rollout flag). Once #1557 is on
  `main`, confirm the entry already exists in `INSTANCE_SETTINGS_REGISTRY` (14-23) — if so, this
  file needs **no edit** (do not add a duplicate); if #1557 landed with a different shape than
  `{ key: "chat.persistent_runtime.enabled" }` (e.g. marked `secret`), flag that back to the
  Coordinator before writing the seed chunk's value, since the value shape below assumes non-secret.
- `tests/uat/seed/chunks/chat-script.ts` (new):
  ```ts
  export async function seedScriptedChatProviderChunk(
    runner: DataContextRunner,
    actorUserId: string
  ): Promise<void>;
  ```
  Mirrors `seedAiProviderChunk` (`chunks/ai.ts:11-42`): one `runner.withDataContext` block that (a)
  creates a provider via `AiRepository.createProvider` with `providerKind: "anthropic"`,
  `executionMode: "non_interactive"`, `displayName: "UAT Scripted Provider"`, encrypted credential
  `cipher.encryptJson({ cli: true })` (never a real credential); (b) creates a model via
  `createModel` with `providerModelId: "uat-scripted-chat-model"`, `displayName: "UAT Scripted Chat
Model"`, `capabilities: ["chat"]`, no service binding (so it wins the instance-default fallback
  `selectModelForCapability` uses); (c) calls `new SettingsRepository().upsertInstanceSetting(
scopedDb, { key: "chat.persistent_runtime.enabled", value: { value: false }, updatedByUserId:
actorUserId, requestId: "uat-seed-chat-script" })`.
- `tests/uat/seed/levels.ts` — between the first `try/finally`'s close (current line 73) and the
  `if (options.level === "solo-admin") return;` (75-77), insert:
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
  Deliberately a second, narrowly-scoped runner — not a restructure of the existing `runner` created
  later (line 80) for the admin+data/multi-user chunk ladder.
- `tests/uat/seed/level-validation.ts` — add, mirroring `parseUatSeedLevel`:
  ```ts
  export function parseUatChatScript(raw: string): UatChatScript | undefined;
  ```
  Empty string → `undefined` (absent, same convention as job-search's base-url var); non-empty and
  not in `UAT_CHAT_SCRIPTS` → throws fail-closed.
- `tests/uat/seed/cli.ts` — read `JARVIS_UAT_SEED_CHAT_SCRIPT` (`resolveMossEnv(process.env,
"JARVIS_UAT_SEED_CHAT_SCRIPT") ?? ""`) via `parseUatChatScript`, thread into the `seedLevel({...})`
  call at line 83 as `chatScript`.

**Test cases:**

- `seedScriptedChatProviderChunk` (real DB, existing seed-test harness pattern per `chunks/ai.test.ts`)
  creates exactly one active `anthropic`/`non_interactive` provider + one `chat`-capable model with
  the neutral display names, and one `chat.persistent_runtime.enabled = { value: false }` instance
  setting row.
- `seedLevel({ level: "solo-admin" })` (no `chatScript`) still leaves `selectChatModelForUser()` ⇒
  `null` (automated check 3, regression).
- `seedLevel({ level: "solo-admin", chatScript: "<id>" })` makes `selectChatModelForUser()` resolve
  the neutral scripted model, and leaves the News JSON binding chunk untouched (not called at
  solo-admin regardless).
- `parseUatChatScript` empty-string → `undefined`; unknown id → throws.

### Task 6 — engine-selection regression test

**Blocked on #1557 merging to `main` — do not build before then** (see Dependency/merge order).

**File:** existing `packages/chat/src/live/*.test.ts` covering `engine-selection.ts` (or new
`engine-selection.test.ts` if none exists — confirm at build time, not re-checked this session).

**Test case:** `isBoundedFallbackEngine("anthropic", "non_interactive")` → `true` (renamed from
`isOneShotEngine` by #1557 — confirmed on `#1557`'s branch, `engine-selection.ts:62-68`, same
signature); `createChatEngine("anthropic", ..., { executionMode: "non_interactive",
persistentRuntimeEnabled: false })` returns a `ClaudePrintChatEngine` instance. Asserting
`persistentRuntimeEnabled: false` explicitly (rather than omitting the option) is the actual
regression case post-#1557: it proves the scripted provider's seeded `chat.persistent_runtime.
enabled = false` pin (Task 5) keeps the bounded engine selected even though a real consumer of that
flag now exists — the thing check 5 needs to guard now that #1557 wires a consumer.

## Dependency / merge order

Two real collisions with #1557 ("persistent chat runtime adapter", also in Phase 1, also building
now), found by the Coordinator against #1557's actual branch diff and confirmed directly against
`worktrees/1557-p1-persistent-adapter` this session:

1. **Symbol rename.** #1557 renames `isOneShotEngine` → `isBoundedFallbackEngine` in
   `packages/chat/src/live/engine-selection.ts` (pure rename, same signature) and adds a real
   consumer of `chat.persistent_runtime.enabled` (`createChatEngine`'s `opts.persistentRuntimeEnabled`
   branch, checked ahead of the bounded-fallback fork). Task 6's test must be written against the
   post-#1557 name and must assert the flag-off case explicitly, not just the tuple-only case.
2. **Registry-key collision.** #1557 also adds `chat.persistent_runtime.enabled` to
   `INSTANCE_SETTINGS_REGISTRY` (`packages/settings/src/instance-settings-keys.ts`) — same key,
   semantically compatible (both treat it as a non-secret boolean gate), but a literal two-lane
   merge conflict on the same array if both land independently.

**Rule:** Tasks 5 and 6 (the only tasks touching `engine-selection.ts` or
`instance-settings-keys.ts`) do not start until #1557 is merged to `main`. Every other Phase 1 task
(1-4) is independent of #1557 and proceeds now. Once #1557 lands, Task 5 confirms (does not
re-add) the registry entry and Task 6 is written directly against `isBoundedFallbackEngine`.

## Kill gate

**Observation:** Coordinator review of Phase 1 — the fixture executable's unit/integration tests
(Tasks 2-3) all green, the harness/seed wiring tests (Tasks 4-5) all green, the compose fix verified
by `docker compose config`, and `pnpm verify:foundation` green via the `verify-gate` skill.
**Owner:** Coordinator (sensitive tier). Phase 2 (spec conversion) is not planned in task detail
until this review lands — per plan-build rule 6, planning past the first shipped phase is exactly
the accumulation risk this rule exists to prevent.

## Phase 2 (scoped, not task-broken-down — planned after Phase 1 review)

Convert the 7 mapped cases from the spec's Acceptance mapping table (`app-map-grounding`,
`runtime-context`, `1133-chat-attachments`, `1264-settings-self-operation`,
`self-operation-content-commands`, `1311-install-grant`, plus new
`scripted-chat-confirmation.uat.spec.ts`), each adding its own `tests/uat/fixtures/chat-scripts/
<id>.json` and appending its id to `UAT_CHAT_SCRIPTS` (Task 1). Each converted spec asserts both the
final reply and the real tool result/effect (spec's Acceptance-mapping header). Live-path evidence:
a real UAT run against the scripted fixture, per `docs/DEVELOPMENT_STANDARDS.md`, evidence limited to
scenario ids/test names/exit codes.

## Verification (Phase 1 exit)

```bash
pnpm exec vitest run tests/uat > /tmp/1121-uat-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all new Task 1/2/4/5/6 test files passing, no existing UAT unit test regressed.

```bash
pnpm exec vitest run packages/chat/src/live > /tmp/1121-engine-selection.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, Task 6's regression test passing.

```bash
docker compose -f infra/docker-compose.prod.yml config --quiet > /tmp/1121-compose.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` both with and without `JARVIS_CLI_TOOLS_PREFIX` exported (run twice).

Full gate (Task 3's integration test needs a real DB — run only via the `verify-gate` skill, never
bare):

```
verify-gate skill invocation → pnpm verify:foundation, expected EXIT=0
```

## Reminders (carried from relay1/relay2)

Never touch `docs/coordination/`; no repo-wide format; explicit `git add` paths only. No
credential/private-content exposure in fixtures, logs, docs, prompts. Scope ends at PR + report —
never move the board, close the issue, or merge.
