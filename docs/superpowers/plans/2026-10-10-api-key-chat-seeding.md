# API-key Chat: Dev-instance Seeding and UAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dev instance register an API-key provider (for example, a local model proxy) as its default chat provider from environment variables, and let one opt-in UAT spec prove chat with a confirmation card through such a provider.

**Architecture:** The dev-instance config gains three fields read from `MOSS_DEV_INSTANCE_PROVIDER_AUTH`, `_BASE_URL` and `_KEY_FILE`. When auth is `api_key`, the provision step creates or updates one named API-key row, runs the normal model discovery, makes it the instance default and skips the CLI token step. For UAT, one spec opts in through its `uatLevel`; the host reads four `MOSS_UAT_CHAT_PROVIDER_*` variables, and the seed container receives the key by variable name only, so it never lands in an argv or an error message.

**Tech Stack:** TypeScript (strict), Node 24, Vitest, Playwright, Docker Compose, pnpm workspaces (`@moss/*`).

**Spec:** `docs/superpowers/specs/2026-10-10-api-key-chat-design.md` (approved 2026-10-10), sections 6 and 7. Task issue: #3410. This plan continues `docs/superpowers/plans/2026-10-10-api-key-chat.md` (Tasks 1-16) and must run after it: chat only accepts API-key rows once Task 12 lands.

**Revised 2026-10-11** after an independent review. Seeding now checks the chosen chat model against the list the provider returned on this run (Task 18), the seeded-key check reads the stored column and decrypts it (Task 20), leak searches use the key scanner, and phase 5 stays open until a run through the relay passes (Task 21).

## Global Constraints

- Never hardcode a model or provider in product code. Test fixtures may use literal ids.
- Public repo. No credentials, private hostnames, LAN addresses, ports of private services or personal data in code, tests, docs, commits or PR text. Use `$PROXY_URL`, `$PROXY_KEY_FILE`, `$PROXY_ANTHROPIC_MODEL`, `$PROXY_OPENAI_MODEL` in instructions and `http://proxy.test` (no port) in test fixtures. New fixture people are "Ada", never a real name.
- Paths in docs are repo-relative or `~/Jarv1s`, never absolute home paths.
- No PR may push a file from under 1000 lines to over 1000 lines. `tests/uat/provisioner.ts` is at 966. Run `wc -l` on it after Task 19.
- Prettier `printWidth` 100.
- Unit tests run one file at a time: `pnpm test:unit <file>`. The full gate, database tests (`tests/integration/**`, `tests/uat/seed/**` database cases) and UAT runs go only through the verify-gate skill, at the points marked **verify-gate**.
- The key must never appear in any process argv, in a log line, in an error message or in a seeded row other than the encrypted credential. Each such rule has a test that is observed failing with its protection removed ("removal step"), and the removal step records the observed failure in the PR body.
- Leak searches use `/tmp/acp-proof/key-scan.mjs` from the main plan's phase 0 setup. It reads the key file itself and prints only counts, pids and file names. Never put key text, or any slice of it, on a command line.
- OpenAI-compatible means a service that speaks Chat Completions. Docs and PR text say "OpenAI-compatible (Chat Completions)" and claim no more than the proxy that was tested.
- Seeding uses only a model the provider listed on this run. API-key discovery never deletes older model rows, so an older row is not evidence the provider still serves it.
- Phase 5 closes only on a UAT run through the relay that passes. A run that skips because the relay is not configured proves the skip works, nothing more. Seeding success is reported separately.
- Test-only settings stay out of checked-in production compose and out of dev scripts' defaults. The `extra_hosts` entry goes in `tests/uat/compose.override.yml` only.
- Chat, status updates, PR text and handoff docs are plain English for a non-engineer reader: name things by what they do, at most one code-formatted name per sentence, plain ASCII punctuation, no invented shorthand. Pass this instruction on to every agent you spawn. Commit messages and code comments stay precise and technical.

## Review Focus

1. Running `provision` twice with the same settings. Expect the same row updated, never a second "Dev instance API key" row. Pinned in Task 18 ("updates the existing row").
2. A key file with a trailing newline or surrounding spaces, or an empty one. Expect the trimmed key stored, and an empty file refused before any database write. Pinned in Task 18.
3. A proxy that lists no chat-capable model, or an admin-pinned model on another provider. Expect provisioning to fail with a message that says so, not to leave chat silently on another provider. Pinned in Task 18 ("refuses when the chat model belongs to another provider").
4. Three of the four UAT variables set. Expect a failure that names the missing variables and never prints a value. Pinned in Task 19 (`readApiKeyChatUatProvider` partial case).
5. A stray seed-key variable already in the host shell when the spec did not opt in. Expect the seed container to receive an empty value. Pinned in Task 19 ("sends an empty key when the spec did not opt in").
6. Re-provisioning after the proxy stops listing the model chosen last time. Expect a refusal, even though the old model row is still in the database. Pinned in Task 18 ("refuses a stale model the provider no longer lists" and the real-repository integration case).
7. A proxy that lists only embedding models, or nothing. Discovery drops non-chat ids (main plan Task 5), so the list is empty and provisioning refuses before making the row default. Pinned in Task 18 ("refuses an empty model list before making the row default").

---

## Verified Branch State

Checked against the code on 2026-10-10. Line numbers are on the planning branch.

| Fact | Where |
| --- | --- |
| Dev config type and reader, 67 lines, no auth or address fields | `scripts/dev-instance/config.ts:12-20`, `:40-67` |
| Provision steps: admin account, provider rows (CLI auto-register only), cli-runner, cli token | `scripts/dev-instance/provision.ts:88-137` |
| Entry point builds `cipher`, `repository`, `autoRegister` and `ProvisionDeps` | `scripts/dev-instance.ts:86-124` |
| `readSecretFile(path)` refuses group- or other-readable files | `scripts/dev-instance/secrets.ts:13` |
| `discoverAndPersistModels` exists but is not exported from `@moss/ai` | `packages/ai/src/discover-and-persist-models.ts:31`, `packages/ai/src/index.ts` |
| Three test helpers build a full `DevInstanceConfig` | `tests/unit/dev-instance-cli-runner.test.ts:88-97`, `tests/integration/dev-instance-doctor.test.ts:78-89`, `tests/integration/dev-instance-provision.test.ts:54-65` |
| `uatLevel` keys parsed by one regex, 13 groups | `tests/uat/run-uat.ts:75`, mapped at `:109-128` |
| Seed hook passes values with `-e NAME=value`; `runCommand` puts every arg in its error text | `tests/uat/provisioner.ts:259-312`, `:543-575` |
| Seed CLI reads env and calls `seedLevel` | `tests/uat/seed/cli.ts:48-87` |
| AI seed chunks run after `seedAiProviderChunk` in the admin+data block | `tests/uat/seed/levels.ts:136-170` |
| No `extra_hosts` anywhere in UAT compose | `tests/uat/compose.override.yml` |
| Discovery outcome is `{ reason?, message? }`; API-key rows are insert-only, so older model rows survive a new list | `packages/ai/src/discover-and-persist-models.ts:8-11`, `:54-66` |
| The CLI ok case asserts `toEqual({})` on the discovery outcome | `tests/unit/ai-discover-and-persist-models.test.ts:68` |
| `listProviders` selects no `encrypted_credential`; `selectProviderWithCredential` does | `packages/ai/src/repository.ts` |
| `parseAiApiKeyCredential` is exported from `@moss/ai` | `packages/ai/src/credentials.ts:5` |

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `scripts/dev-instance/config.ts` | Modify | Read and validate the three new settings |
| `scripts/dev-instance/api-key-provider.ts` | Create | Create or update the dev API-key row, discover models, make it default |
| `scripts/dev-instance/provision.ts` | Modify | Branch the provider-rows and cli-token steps on auth |
| `scripts/dev-instance.ts` | Modify | Wire the real repository, cipher, discovery and key reader |
| `packages/ai/src/index.ts` | Modify | Export the discovery helper |
| `packages/ai/src/discover-and-persist-models.ts` | Modify | Report the chat model ids the provider listed on this run |
| `tests/uat/compose.override.yml` | Modify | `host.docker.internal` on the `jarv1s` service |
| `tests/uat/api-key-chat-env.ts` | Create | Host-side settings, seed args and seed child env |
| `tests/uat/seed/types.ts` | Modify | Seed-container variable names and the seed value type |
| `tests/uat/provisioner.ts` | Modify | Opt-in option, child env on `runCommand`, seed hook threading |
| `tests/uat/run-uat.ts` | Modify | Parse `withApiKeyChatProvider` |
| `tests/uat/seed/chunks/api-key-chat.ts` | Create | Parse the seed env and seed the provider, model and default |
| `tests/uat/seed/cli.ts`, `tests/uat/seed/levels.ts` | Modify | Read and apply the seed value |
| `tests/uat/specs/3410-api-key-chat.uat.spec.ts` | Create | Drawer chat, confirmation card, task exists |

---

## Phase 4: Dev-instance API-key seeding

### Task 17: Dev-instance config reads the API-key settings

**Files:**
- Modify: `scripts/dev-instance/config.ts`
- Modify: `tests/unit/dev-instance-config.test.ts`
- Modify: `tests/unit/dev-instance-cli-runner.test.ts:88-97`
- Modify: `tests/integration/dev-instance-doctor.test.ts:78-89`
- Modify: `tests/integration/dev-instance-provision.test.ts:54-65`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DevInstanceProviderAuth = "cli" | "api_key"`; `DevInstanceConfig` gains `providerAuth: DevInstanceProviderAuth`, `providerBaseUrl: string | null`, `providerKeyFilePath: string | null`. Task 18 relies on these three names.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/dev-instance-config.test.ts`, add these three lines to BOTH `toEqual` objects (the defaults test at lines 12-20 and the overrides test at lines 36-44), directly after `providerKind`. Leave every other line of those objects exactly as it is.

```ts
      providerAuth: "cli",
      providerBaseUrl: null,
      providerKeyFilePath: null,
```

Then add a new `describe` block at the end of the file:

```ts
describe("dev-instance config: API-key provider (#3410)", () => {
  const apiKeyEnv = {
    MOSS_DEV_INSTANCE_PROVIDER_KIND: "openai-compatible",
    MOSS_DEV_INSTANCE_PROVIDER_AUTH: "api_key",
    MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "http://proxy.test",
    MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "~/ada/proxy-key"
  };

  it("reads auth, address and key file, expanding the home prefix", () => {
    const config = readDevInstanceConfig(apiKeyEnv);
    expect(config.providerAuth).toBe("api_key");
    expect(config.providerBaseUrl).toBe("http://proxy.test");
    expect(config.providerKeyFilePath).toBe(join(homedir(), "ada/proxy-key"));
  });

  it("allows an anthropic API-key provider with no address", () => {
    const config = readDevInstanceConfig({
      MOSS_DEV_INSTANCE_PROVIDER_KIND: "anthropic",
      MOSS_DEV_INSTANCE_PROVIDER_AUTH: "api_key",
      MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "/tmp/ada-key"
    });
    expect(config.providerBaseUrl).toBeNull();
    expect(config.providerKeyFilePath).toBe("/tmp/ada-key");
  });

  it("treats empty values as unset", () => {
    const config = readDevInstanceConfig({
      MOSS_DEV_INSTANCE_PROVIDER_AUTH: "",
      MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "",
      MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: ""
    });
    expect(config.providerAuth).toBe("cli");
  });

  it("requires a key file for api_key", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: undefined })
    ).toThrow(/MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE is required/);
  });

  it("refuses api_key for a kind chat cannot drive", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_KIND: "google" })
    ).toThrow(/anthropic or openai-compatible/);
  });

  it("refuses an address or key file under cli auth", () => {
    expect(() =>
      readDevInstanceConfig({ MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "http://proxy.test" })
    ).toThrow(/apply only when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key/);
    expect(() =>
      readDevInstanceConfig({ MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "/tmp/ada-key" })
    ).toThrow(/apply only when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key/);
  });

  it("refuses an address that is not http or https", () => {
    expect(() =>
      readDevInstanceConfig({
        ...apiKeyEnv,
        MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "ftp://proxy.test"
      })
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it("refuses an unknown auth value", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_AUTH: "oauth" })
    ).toThrow(/providerAuth "oauth"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit tests/unit/dev-instance-config.test.ts`
Expected: FAIL. The two existing `toEqual` tests fail on the missing fields, and the new tests fail on `providerAuth` being undefined or no error thrown.

- [ ] **Step 3: Implement the config fields**

In `scripts/dev-instance/config.ts`, add the type and the three fields to the interface:

```ts
export type DevInstanceProviderAuth = "cli" | "api_key";

export interface DevInstanceConfig {
  readonly providerKind: AiProviderKind;
  // "api_key" registers an API-key provider row instead of the CLI login (#3410).
  readonly providerAuth: DevInstanceProviderAuth;
  readonly providerBaseUrl: string | null;
  readonly providerKeyFilePath: string | null;
  readonly credentialFilePath: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPasswordFilePath: string;
  readonly cliHomeBase: string;
  readonly cliRunnerSocketPath: string;
}
```

Below `expandHome`, add:

```ts
// Chat can drive API-key rows of these kinds only (#3410).
const API_KEY_PROVIDER_KINDS: readonly AiProviderKind[] = ["anthropic", "openai-compatible"];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readProviderAccess(
  env: NodeJS.ProcessEnv,
  providerKind: AiProviderKind
): Pick<DevInstanceConfig, "providerAuth" | "providerBaseUrl" | "providerKeyFilePath"> {
  const auth = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_AUTH") || "cli";
  const baseUrl = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_BASE_URL") || null;
  const keyFile = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE") || null;

  if (auth === "cli") {
    if (baseUrl !== null || keyFile !== null) {
      throw new Error(
        "MOSS_DEV_INSTANCE_PROVIDER_BASE_URL and MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE apply only " +
          "when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key"
      );
    }
    return { providerAuth: "cli", providerBaseUrl: null, providerKeyFilePath: null };
  }
  if (auth !== "api_key") {
    throw new Error(`Invalid dev-instance providerAuth "${auth}". Must be one of: cli, api_key`);
  }
  if (!API_KEY_PROVIDER_KINDS.includes(providerKind)) {
    throw new Error(
      `An api_key dev instance needs providerKind anthropic or openai-compatible, not "${providerKind}"`
    );
  }
  if (keyFile === null) {
    throw new Error(
      "MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE is required when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key"
    );
  }
  if (baseUrl !== null && !isHttpUrl(baseUrl)) {
    throw new Error("MOSS_DEV_INSTANCE_PROVIDER_BASE_URL must be an http:// or https:// address");
  }
  return {
    providerAuth: "api_key",
    providerBaseUrl: baseUrl,
    providerKeyFilePath: expandHome(keyFile)
  };
}
```

In `readDevInstanceConfig`, spread the result directly after `providerKind` in the returned object:

```ts
  return {
    providerKind: providerKind as AiProviderKind,
    ...readProviderAccess(env, providerKind as AiProviderKind),
    credentialFilePath: expandHome(
```

Leave the rest of the returned object unchanged.

- [ ] **Step 4: Update the other config builders**

Add these lines, after `providerKind`, to the object literals in `tests/unit/dev-instance-cli-runner.test.ts:88-97`, `tests/integration/dev-instance-doctor.test.ts:78-89` and `tests/integration/dev-instance-provision.test.ts:54-65` (the cli-runner one lists `providerKind` last, so add them after it there):

```ts
      providerAuth: "cli",
      providerBaseUrl: null,
      providerKeyFilePath: null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/dev-instance-config.test.ts`
Expected: PASS, 13 tests.

Run: `pnpm test:unit tests/unit/dev-instance-cli-runner.test.ts`
Expected: PASS, no change in count.

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors (the two integration files compile; they run only under verify-gate).

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-instance/config.ts tests/unit/dev-instance-config.test.ts \
  tests/unit/dev-instance-cli-runner.test.ts tests/integration/dev-instance-doctor.test.ts \
  tests/integration/dev-instance-provision.test.ts
git commit -m "feat(dev-instance): read API-key provider auth, address and key file (#3410)"
```

### Task 18: Provision registers the API-key provider as the default

**Files:**
- Create: `scripts/dev-instance/api-key-provider.ts`
- Modify: `scripts/dev-instance/provision.ts`
- Modify: `scripts/dev-instance.ts:15`, `:86-89`, `:110-124`
- Modify: `packages/ai/src/index.ts`
- Modify: `packages/ai/src/discover-and-persist-models.ts:8-11`, `:65-66`
- Test: `tests/unit/ai-discover-and-persist-models.test.ts` (one changed expectation, one new case)
- Test: `tests/unit/dev-instance-api-key-provider.test.ts` (create)
- Test: `tests/integration/dev-instance-provision.test.ts` (three new cases, database)

**Interfaces:**
- Consumes: Task 17's `providerAuth`, `providerBaseUrl`, `providerKeyFilePath`. From `@moss/ai`: `AiRepository`, `AiSecretCipher`, `discoverAndPersistModels(scopedDb, input, { repository, modelDiscovery })`, `DiscoverAndPersistModelsInput`, `DiscoverAndPersistModelsOutcome`, `ModelDiscoveryService`.
- Produces:
  - `DiscoverAndPersistModelsOutcome.discoveredModelIds?: readonly string[]`, the chat-capable ids the provider listed on this run. Set only when `reason` is absent.
  - `DEV_API_KEY_PROVIDER_NAME = "Dev instance API key"`
  - `ensureApiKeyProvider(scopedDb: DataContextDb, adminUserId: string, config: DevInstanceConfig, deps: EnsureApiKeyProviderDeps): Promise<ApiKeyProviderOutcome>`
  - `ApiKeyProviderOutcome { changed: boolean; providerId: string; chatModelId: string }`
  - `ProvisionDeps.ensureApiKeyProvider?: (scopedDb: DataContextDb, adminUserId: string) => Promise<ApiKeyProviderOutcome>`
  - cli-token step detail `"skipped: API-key provider"` for API-key configs.

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/ai-discover-and-persist-models.test.ts`, change the CLI ok case's `expect(outcome).toEqual({});` (line 68) to:

```ts
    expect(outcome).toEqual({
      discoveredModelIds: ["claude-fable-5-1", "claude-haiku-4-5-20251001"]
    });
```

and add, after "never deletes rows for an API-key provider":

```ts
  it("reports only the chat ids the provider listed on this run", async () => {
    const repository = fakeRepository();
    const modelDiscovery = new ModelDiscoveryService();
    modelDiscovery.discoverModels = async () => ({
      models: [
        {
          providerModelId: "org/model:tag@v2",
          displayName: "org/model:tag@v2",
          capabilities: ["chat", "tool-use"],
          tier: "interactive"
        },
        {
          providerModelId: "org/vision-only",
          displayName: "org/vision-only",
          capabilities: ["vision"],
          tier: "interactive"
        }
      ],
      fromCache: false,
      fromFallback: false,
      cacheExpiresAt: null
    });
    const outcome = await discoverAndPersistModels(
      scopedDb,
      { ...input, providerKind: "openai-compatible", acpAgentId: null, authMethod: "api_key" },
      { repository: repository as never, modelDiscovery }
    );
    expect(outcome).toEqual({ discoveredModelIds: ["org/model:tag@v2"] });
  });
```

Create `tests/unit/dev-instance-api-key-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type {
  AiConfiguredModelSafeRow,
  AiProviderConfigSafeRow,
  AiSecretCipher,
  CreateAiProviderInput,
  DiscoverAndPersistModelsInput,
  DiscoverAndPersistModelsOutcome,
  UpdateAiProviderInput
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import type { DevInstanceConfig } from "../../scripts/dev-instance/config.js";
import {
  DEV_API_KEY_PROVIDER_NAME,
  ensureApiKeyProvider,
  type EnsureApiKeyProviderDeps
} from "../../scripts/dev-instance/api-key-provider.js";

const KEY = "ada-dev-instance-key-0001";
const ADMIN = "00000000-0000-4000-8000-00000000ada1";
const scopedDb = {} as DataContextDb;
const SEALED = { sealed: "opaque" } as unknown as ReturnType<AiSecretCipher["encryptJson"]>;

function config(overrides: Partial<DevInstanceConfig> = {}): DevInstanceConfig {
  return {
    providerKind: "openai-compatible",
    providerAuth: "api_key",
    providerBaseUrl: "http://proxy.test",
    providerKeyFilePath: "/tmp/ada-key",
    credentialFilePath: "/tmp/unused.gpg",
    adminEmail: "ada@example.com",
    adminName: "Ada",
    adminPasswordFilePath: "/tmp/unused-password",
    cliHomeBase: "/tmp/unused-cli-home",
    cliRunnerSocketPath: "/tmp/unused.sock",
    ...overrides
  };
}

function providerRow(overrides: Partial<AiProviderConfigSafeRow> = {}): AiProviderConfigSafeRow {
  return {
    id: "provider-1",
    owner_user_id: ADMIN,
    provider_kind: "openai-compatible",
    display_name: DEV_API_KEY_PROVIDER_NAME,
    base_url: "http://proxy.test",
    status: "active",
    auth_method: "api_key",
    execution_mode: "non_interactive",
    acp_agent_id: null,
    has_credential: true,
    is_instance_default: false,
    purpose: "assistant",
    revoked_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides
  };
}

const LISTED_MODEL = "org/model:tag@v2";

function chatModel(providerConfigId: string): AiConfiguredModelSafeRow {
  return {
    id: "model-1",
    provider_config_id: providerConfigId,
    provider_model_id: LISTED_MODEL
  } as AiConfiguredModelSafeRow;
}

interface HarnessOptions {
  readonly existing?: readonly AiProviderConfigSafeRow[];
  readonly defaultId?: string | null;
  readonly discovery?: DiscoverAndPersistModelsOutcome;
  readonly selected?: AiConfiguredModelSafeRow | null;
  readonly keyFile?: string;
}

function harness(options: HarnessOptions = {}) {
  const created: CreateAiProviderInput[] = [];
  const updated: Array<{ id: string; input: UpdateAiProviderInput }> = [];
  const discovered: DiscoverAndPersistModelsInput[] = [];
  const promoted: string[] = [];
  const encrypted: Array<Record<string, unknown>> = [];

  const deps: EnsureApiKeyProviderDeps = {
    repository: {
      listProviders: async () => [...(options.existing ?? [])],
      createProvider: async (_db, input) => {
        created.push(input);
        return providerRow({ provider_kind: input.providerKind, base_url: input.baseUrl ?? null });
      },
      updateProvider: async (_db, id, input) => {
        updated.push({ id, input });
        return providerRow({ id, base_url: input.baseUrl ?? null });
      },
      resolveDefaultProviderId: async () => options.defaultId ?? null,
      setInstanceDefaultProvider: async (_db, id) => {
        promoted.push(id);
        return providerRow({ id, is_instance_default: true });
      },
      selectChatModelForUser: async () =>
        options.selected === undefined ? chatModel("provider-1") : options.selected
    },
    cipher: {
      encryptJson: (value) => {
        encrypted.push(value);
        return SEALED;
      }
    },
    discoverModels: async (_db, input) => {
      discovered.push(input);
      return options.discovery ?? { discoveredModelIds: [LISTED_MODEL] };
    },
    readKeyFile: async () => options.keyFile ?? `  ${KEY}\n`
  };

  return { deps, created, updated, discovered, promoted, encrypted };
}

describe("ensureApiKeyProvider (#3410)", () => {
  it("creates the row with the trimmed key sealed, discovers models and makes it default", async () => {
    const h = harness();

    const outcome = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(outcome).toEqual({ changed: true, providerId: "provider-1", chatModelId: "model-1" });
    expect(h.created).toEqual([
      {
        providerKind: "openai-compatible",
        displayName: DEV_API_KEY_PROVIDER_NAME,
        baseUrl: "http://proxy.test",
        authMethod: "api_key",
        encryptedCredential: SEALED
      }
    ]);
    expect(h.encrypted).toEqual([{ apiKey: KEY }]);
    expect(h.discovered).toEqual([
      {
        actorUserId: ADMIN,
        providerId: "provider-1",
        providerKind: "openai-compatible",
        acpAgentId: null,
        authMethod: "api_key",
        baseUrl: "http://proxy.test",
        credential: { apiKey: KEY }
      }
    ]);
    expect(h.promoted).toEqual(["provider-1"]);
  });

  it("updates the existing row on a re-run instead of adding a second one", async () => {
    const h = harness({ existing: [providerRow()], defaultId: "provider-1" });

    const outcome = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([
      {
        id: "provider-1",
        input: { baseUrl: "http://proxy.test", status: "active", encryptedCredential: SEALED }
      }
    ]);
    expect(outcome.changed).toBe(false);
  });

  it("ignores a same-named row that is revoked or of another kind", async () => {
    const h = harness({
      existing: [
        providerRow({ id: "old-revoked", revoked_at: new Date(0) }),
        providerRow({ id: "other-kind", provider_kind: "anthropic" })
      ]
    });

    await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(h.updated).toEqual([]);
    expect(h.created).toHaveLength(1);
  });

  it("refuses an empty key file before any write", async () => {
    const h = harness({ keyFile: " \n" });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /is empty/
    );
    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("names the discovery failure without echoing the provider's message", async () => {
    const h = harness({
      discovery: { reason: "rejected_key", message: `401 for key ${KEY}` }
    });

    const error = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected_key");
    expect((error as Error).message).not.toContain(KEY);
    expect(h.promoted).toEqual([]);
  });

  it("refuses when the chat model belongs to another provider", async () => {
    const h = harness({ selected: chatModel("some-other-provider") });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses when there is no chat model at all", async () => {
    const h = harness({ selected: null });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses a stale model the provider no longer lists", async () => {
    const h = harness({ discovery: { discoveredModelIds: ["org/other-model"] } });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses an empty model list before making the row default", async () => {
    const h = harness({ discovery: { discoveredModelIds: [] } });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
    expect(h.promoted).toEqual([]);
  });

  it("refuses a cli config", async () => {
    const h = harness();

    await expect(
      ensureApiKeyProvider(
        scopedDb,
        ADMIN,
        config({ providerAuth: "cli", providerBaseUrl: null, providerKeyFilePath: null }),
        h.deps
      )
    ).rejects.toThrow(/needs an api_key dev-instance config/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit tests/unit/ai-discover-and-persist-models.test.ts`
Expected: FAIL on "reconciles the provider's rows against an ok list (sentinel kept)" and "reports only the chat ids the provider listed on this run" (the outcome is `{}`).
Run: `pnpm test:unit tests/unit/dev-instance-api-key-provider.test.ts`
Expected: FAIL with "Cannot find module '../../scripts/dev-instance/api-key-provider.js'" (and a type error on the missing `@moss/ai` exports).

- [ ] **Step 3: Report the listed ids and export the discovery helper**

In `packages/ai/src/discover-and-persist-models.ts`, replace the outcome interface (lines 8-11) with:

```ts
/** #2208: what the refresh route reports back — why nothing changed, when that is the case. */
export interface DiscoverAndPersistModelsOutcome {
  readonly reason?: ModelDiscoveryReason;
  readonly message?: string;
  /** Chat-capable ids the provider listed on this run. Set only when `reason` is absent. */
  readonly discoveredModelIds?: readonly string[];
}
```

and replace the last two lines of `discoverAndPersistModels` (`await deps.repository.upsertDiscoveredModels(...)` and `return {};`) with:

```ts
  await deps.repository.upsertDiscoveredModels(scopedDb, input.providerId, models);
  // API-key rows are insert-only, so older rows outlive the list; callers check against this.
  return {
    discoveredModelIds: models
      .filter((model) => model.capabilities.includes("chat"))
      .map((model) => model.providerModelId)
  };
```

Run: `rg -n "toEqual\(\{\}\)" tests/unit | rg -i discover`
Expected: no matches. Any other test that pins the empty ok outcome gets the same change as line 68.

In `packages/ai/src/index.ts`, add after the line `export * from "./credentials.js";`:

```ts
export * from "./discover-and-persist-models.js";
```

- [ ] **Step 4: Write the implementation**

Create `scripts/dev-instance/api-key-provider.ts`:

```ts
import type {
  AiRepository,
  AiSecretCipher,
  DiscoverAndPersistModelsInput,
  DiscoverAndPersistModelsOutcome
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import type { DevInstanceConfig } from "./config.js";

/** Display name of the one API-key row the dev instance owns. Re-runs find it by this name. */
export const DEV_API_KEY_PROVIDER_NAME = "Dev instance API key";

const NO_CHAT_MODEL_MESSAGE =
  `"${DEV_API_KEY_PROVIDER_NAME}" listed no chat model Moss can use. Pick one for it in ` +
  "Admin > AI providers, or check the provider's model list.";

export interface EnsureApiKeyProviderDeps {
  readonly repository: Pick<
    AiRepository,
    | "listProviders"
    | "createProvider"
    | "updateProvider"
    | "resolveDefaultProviderId"
    | "setInstanceDefaultProvider"
    | "selectChatModelForUser"
  >;
  readonly cipher: Pick<AiSecretCipher, "encryptJson">;
  readonly discoverModels: (
    scopedDb: DataContextDb,
    input: DiscoverAndPersistModelsInput
  ) => Promise<DiscoverAndPersistModelsOutcome>;
  readonly readKeyFile: (path: string) => Promise<string>;
}

export interface ApiKeyProviderOutcome {
  readonly changed: boolean;
  readonly providerId: string;
  readonly chatModelId: string;
}

/**
 * Creates or updates the dev instance's API-key row, lists its models and makes it the instance
 * default. Errors carry the discovery reason only: the provider's own message can echo the key.
 */
export async function ensureApiKeyProvider(
  scopedDb: DataContextDb,
  adminUserId: string,
  config: DevInstanceConfig,
  deps: EnsureApiKeyProviderDeps
): Promise<ApiKeyProviderOutcome> {
  if (config.providerAuth !== "api_key" || config.providerKeyFilePath === null) {
    throw new Error("ensureApiKeyProvider needs an api_key dev-instance config");
  }

  const apiKey = (await deps.readKeyFile(config.providerKeyFilePath)).trim();
  if (apiKey.length === 0) {
    throw new Error(`The API key file ${config.providerKeyFilePath} is empty`);
  }
  const encryptedCredential = deps.cipher.encryptJson({ apiKey });

  const previousDefaultId = await deps.repository.resolveDefaultProviderId(scopedDb);
  const existing = (await deps.repository.listProviders(scopedDb)).find(
    (row) =>
      row.display_name === DEV_API_KEY_PROVIDER_NAME &&
      row.auth_method === "api_key" &&
      row.provider_kind === config.providerKind &&
      row.revoked_at === null
  );
  const provider = existing
    ? await deps.repository.updateProvider(scopedDb, existing.id, {
        baseUrl: config.providerBaseUrl,
        status: "active",
        encryptedCredential
      })
    : await deps.repository.createProvider(scopedDb, {
        providerKind: config.providerKind,
        displayName: DEV_API_KEY_PROVIDER_NAME,
        baseUrl: config.providerBaseUrl,
        authMethod: "api_key",
        encryptedCredential
      });
  if (!provider) {
    throw new Error(`Could not update the "${DEV_API_KEY_PROVIDER_NAME}" provider row`);
  }

  const discovery = await deps.discoverModels(scopedDb, {
    actorUserId: adminUserId,
    providerId: provider.id,
    providerKind: provider.provider_kind,
    acpAgentId: null,
    authMethod: "api_key",
    baseUrl: provider.base_url,
    credential: { apiKey }
  });
  if (discovery.reason !== undefined) {
    throw new Error(
      `Listing models for "${DEV_API_KEY_PROVIDER_NAME}" failed (${discovery.reason}). ` +
        "Check MOSS_DEV_INSTANCE_PROVIDER_BASE_URL and the key file."
    );
  }
  // Older model rows survive discovery, so only this run's list counts.
  const listed = discovery.discoveredModelIds ?? [];
  if (listed.length === 0) throw new Error(NO_CHAT_MODEL_MESSAGE);

  const promoted = await deps.repository.setInstanceDefaultProvider(scopedDb, provider.id);
  if (!promoted) {
    throw new Error(`Could not make "${DEV_API_KEY_PROVIDER_NAME}" the default provider`);
  }

  const model = await deps.repository.selectChatModelForUser(scopedDb);
  if (
    !model ||
    model.provider_config_id !== provider.id ||
    !listed.includes(model.provider_model_id)
  ) {
    throw new Error(NO_CHAT_MODEL_MESSAGE);
  }

  return {
    changed: existing === undefined || previousDefaultId !== provider.id,
    providerId: provider.id,
    chatModelId: model.id
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/ai-discover-and-persist-models.test.ts`
Run: `pnpm test:unit tests/unit/dev-instance-api-key-provider.test.ts`
Expected: PASS for both; the second reports 10 tests.

- [ ] **Step 6: Removal steps (provider message stays out of errors; only listed models count)**

Temporarily change the discovery error to append the provider's message:

```ts
      `Listing models for "${DEV_API_KEY_PROVIDER_NAME}" failed (${discovery.reason}). ` +
        `${discovery.message ?? ""} Check MOSS_DEV_INSTANCE_PROVIDER_BASE_URL and the key file.`
```

Run: `pnpm test:unit tests/unit/dev-instance-api-key-provider.test.ts`
Expected: FAIL on "names the discovery failure without echoing the provider's message". Record the failure in the PR body. Revert the change and rerun to PASS.

Then temporarily delete `|| !listed.includes(model.provider_model_id)` from the model check.
Run: `pnpm test:unit tests/unit/dev-instance-api-key-provider.test.ts`
Expected: FAIL on "refuses a stale model the provider no longer lists". Record it, revert, and rerun to PASS.

- [ ] **Step 7: Write the failing provision cases**

In `tests/integration/dev-instance-provision.test.ts`, add `import type { AiAutoRegisterPort } from "@moss/ai";`, `import { ModelDiscoveryService, discoverAndPersistModels } from "@moss/ai";` and `import { ensureApiKeyProvider, type EnsureApiKeyProviderDeps } from "../../scripts/dev-instance/api-key-provider.js";` to the imports, then add a new `describe` block inside the top-level `describe`, after the last existing block:

```ts
  describe("API-key provider (#3410)", () => {
    const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
    const refuseAutoRegister = {
      ensureDefaultChatModel: async () => {
        throw new Error("auto-register must not run for an API-key config");
      }
    } as unknown as AiAutoRegisterPort;

    it("registers through ensureApiKeyProvider and skips the CLI token", async () => {
      await insertActiveAdmin(ADMIN_ID, "ada@example.com");
      const seen: string[] = [];
      let tokenCalls = 0;

      const outcomes = await runProvision(
        deps({
          autoRegister: refuseAutoRegister,
          config: fakeConfig({
            providerKind: "openai-compatible",
            providerAuth: "api_key",
            providerBaseUrl: "http://proxy.test",
            providerKeyFilePath: "/tmp/dev-instance-provision-test-key"
          }),
          ensureApiKeyProvider: async (_scopedDb, adminUserId) => {
            seen.push(adminUserId);
            return { changed: true, providerId: "provider-1", chatModelId: "model-1" };
          },
          persistCliToken: async () => {
            tokenCalls += 1;
            return true;
          }
        })
      );

      expect(seen).toEqual([ADMIN_ID]);
      expect(tokenCalls).toBe(0);
      expect(outcomes.find((outcome) => outcome.id === "provider-rows")).toEqual({
        id: "provider-rows",
        changed: true,
        detail: "registered API-key provider provider-1 as default"
      });
      expect(outcomes.find((outcome) => outcome.id === "cli-token")).toEqual({
        id: "cli-token",
        changed: false,
        detail: "skipped: API-key provider"
      });
    });

    it("refuses an API-key config when the registration step is not wired", async () => {
      await insertActiveAdmin(ADMIN_ID, "ada@example.com");

      await expect(
        runProvision(
          deps({
            autoRegister: refuseAutoRegister,
            config: fakeConfig({
              providerAuth: "api_key",
              providerKeyFilePath: "/tmp/dev-instance-provision-test-key"
            })
          })
        )
      ).rejects.toThrow(/ensureApiKeyProvider is not wired/);
    });

    it("refuses a re-run whose list no longer has the model, though the old row remains", async () => {
      await insertActiveAdmin(ADMIN_ID, "ada@example.com");
      const repository = new AiRepository();
      const modelDiscovery = new ModelDiscoveryService();
      let listed: readonly string[] = ["org/model:tag@v2"];
      modelDiscovery.discoverModels = async () => ({
        models: listed.map((id) => ({
          providerModelId: id,
          displayName: id,
          capabilities: ["chat" as const],
          tier: "interactive" as const
        })),
        fromCache: false,
        fromFallback: false,
        cacheExpiresAt: null
      });
      const ensureDeps: EnsureApiKeyProviderDeps = {
        repository,
        cipher: createAiSecretCipher(),
        discoverModels: (scopedDb, input) =>
          discoverAndPersistModels(scopedDb, input, { repository, modelDiscovery }),
        readKeyFile: async () => "ada-dev-instance-key-0002\n"
      };
      const config = fakeConfig({
        providerKind: "openai-compatible",
        providerAuth: "api_key",
        providerBaseUrl: "http://proxy.test",
        providerKeyFilePath: "/tmp/dev-instance-provision-test-key"
      });
      const context = { actorUserId: ADMIN_ID, requestId: "request:dev-api-key" };
      const ensure = () =>
        runner.withDataContext(context, (scopedDb) =>
          ensureApiKeyProvider(scopedDb, ADMIN_ID, config, ensureDeps)
        );

      const first = await ensure();
      listed = [];
      await expect(ensure()).rejects.toThrow(/listed no chat model/);

      const models = await runner.withDataContext(context, (scopedDb) =>
        repository.listModels(scopedDb)
      );
      expect(
        models.some(
          (model) =>
            model.provider_config_id === first.providerId &&
            model.provider_model_id === "org/model:tag@v2"
        )
      ).toBe(true);
    });
  });
```

These are database tests. Do not run them directly; they run under verify-gate in Task 21. The removal step for the real-repository case runs one database gate now:

Temporarily delete `|| !listed.includes(model.provider_model_id)` again.
Run: `scripts/run-gate.sh start --gate test:integration`, then `scripts/run-gate.sh wait --follow`.
Expected: FAIL on "refuses a re-run whose list no longer has the model, though the old row remains". Record the failure in the PR body, revert, and leave the passing run to Task 21.

- [ ] **Step 8: Branch the provision steps**

In `scripts/dev-instance/provision.ts`, change the `@moss/db` type import and add the outcome import:

```ts
import type { AccessContext, DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";

import type { ApiKeyProviderOutcome } from "./api-key-provider.js";
```

Add the optional dependency at the end of `ProvisionDeps`:

```ts
  readonly log: (line: string) => void;
  /** Registers the API-key provider row. Required when `config.providerAuth` is "api_key". */
  readonly ensureApiKeyProvider?: (
    scopedDb: DataContextDb,
    adminUserId: string
  ) => Promise<ApiKeyProviderOutcome>;
}
```

Add this function above `ensureProviderRowsStep`:

```ts
async function ensureApiKeyProviderRowsStep(
  deps: ProvisionDeps,
  adminUserId: string
): Promise<ProvisionStepOutcome> {
  const ensure = deps.ensureApiKeyProvider;
  if (!ensure) {
    throw new Error("API-key provisioning failed: ensureApiKeyProvider is not wired");
  }
  const outcome = await deps.runner.withDataContext(
    provisionContext(adminUserId, "provider-rows"),
    (scopedDb) => ensure(scopedDb, adminUserId)
  );
  const detail = outcome.changed
    ? `registered API-key provider ${outcome.providerId} as default`
    : `API-key provider ${outcome.providerId} already default`;
  deps.log(detail);
  return { id: "provider-rows", changed: outcome.changed, detail };
}
```

At the top of `ensureProviderRowsStep`, before `const context = ...`:

```ts
  if (deps.config.providerAuth === "api_key") {
    return ensureApiKeyProviderRowsStep(deps, adminUserId);
  }
```

At the top of `ensureCliTokenStep`:

```ts
  if (deps.config.providerAuth === "api_key") {
    const detail = "skipped: API-key provider";
    deps.log(`cli-token: ${detail}`);
    return { id: "cli-token", changed: false, detail };
  }
```

- [ ] **Step 9: Wire the entry point**

In `scripts/dev-instance.ts`, change the `@moss/ai` import (line 15) and add the module import after the `./dev-instance/secrets.js` import:

```ts
import {
  AiAutoRegisterService,
  AiRepository,
  createAiSecretCipher,
  discoverAndPersistModels,
  ModelDiscoveryService
} from "@moss/ai";
```

```ts
import { ensureApiKeyProvider } from "./dev-instance/api-key-provider.js";
```

After `const autoRegister = new AiAutoRegisterService({ repository, cipher });` add:

```ts
  const modelDiscovery = new ModelDiscoveryService();
```

In the `provisionDeps` object, after `log: (line) => console.log(line)` add a comma and:

```ts
          ensureApiKeyProvider: (scopedDb, adminUserId) =>
            ensureApiKeyProvider(scopedDb, adminUserId, config, {
              repository,
              cipher,
              discoverModels: (db, input) =>
                discoverAndPersistModels(db, input, { repository, modelDiscovery }),
              readKeyFile: readSecretFile
            })
```

- [ ] **Step 10: Type-check and rerun the unit tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm test:unit tests/unit/dev-instance-api-key-provider.test.ts`
Expected: PASS, 8 tests.

Run: `pnpm test:unit tests/unit/dev-instance-config.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 11: Commit**

```bash
git add scripts/dev-instance/api-key-provider.ts scripts/dev-instance/provision.ts \
  scripts/dev-instance.ts packages/ai/src/index.ts packages/ai/src/discover-and-persist-models.ts \
  tests/unit/ai-discover-and-persist-models.test.ts \
  tests/unit/dev-instance-api-key-provider.test.ts tests/integration/dev-instance-provision.test.ts
git commit -m "feat(dev-instance): provision an API-key provider as the default, from this run's model list (#3410)"
```

---

## Phase 5: UAT through a host-side proxy

The UAT stack runs in containers on a bridge network, so `127.0.0.1` on the host is out of reach. These tasks add a host-gateway name and an opt-in seed. The relay that makes the host proxy answer on the bridge gateway lives in Ben's model-router repo and is out of scope here. Without it, the spec is simply not configured and skips.

Host variables (set by whoever runs the UAT):

| Variable | Meaning |
| --- | --- |
| `MOSS_UAT_CHAT_PROVIDER_KIND` | `anthropic` or `openai-compatible` |
| `MOSS_UAT_CHAT_PROVIDER_BASE_URL` | Address as the `jarv1s` container sees it, e.g. `http://host.docker.internal:<relay port>` |
| `MOSS_UAT_CHAT_PROVIDER_MODEL` | Model id to seed |
| `MOSS_UAT_CHAT_PROVIDER_KEY_FILE` | Path to a 0600 file holding the key |

### Task 19: Host-gateway name and key-safe seed plumbing

**Files:**
- Modify: `tests/uat/compose.override.yml`
- Create: `tests/uat/api-key-chat-env.ts`
- Test: `tests/uat/api-key-chat-env.test.ts` (create)
- Modify: `tests/uat/seed/types.ts` (append)
- Modify: `tests/uat/provisioner.ts:224-244`, `:259-312`, `:543-575`, `:608-668`, `:704`, `:893-900`
- Test: `tests/uat/provisioner.test.ts` (append)
- Modify: `tests/uat/run-uat.ts:44-128`
- Test: `tests/uat/run-uat.test.ts` (one new case; four exact objects gain a field)

**Interfaces:**
- Consumes: `readSecretFile(path)` from `scripts/dev-instance/secrets.ts`.
- Produces:
  - In `tests/uat/seed/types.ts`: `API_KEY_CHAT_SEED_ENV = { kind: "MOSS_UAT_API_KEY_CHAT_KIND", baseUrl: "MOSS_UAT_API_KEY_CHAT_BASE_URL", model: "MOSS_UAT_API_KEY_CHAT_MODEL", key: "MOSS_UAT_API_KEY_CHAT_KEY" }` and `ApiKeyChatSeed { providerKind: "anthropic" | "openai-compatible"; baseUrl: string; model: string; apiKey: string }`.
  - In `tests/uat/api-key-chat-env.ts`: `API_KEY_CHAT_UAT_ENV`, `apiKeyChatUatConfigured(env): boolean`, `readApiKeyChatUatProvider(env, readKeyFile?): Promise<ApiKeyChatSeed | undefined>`, `apiKeyChatSeedArgs(seed?): string[]`, `apiKeyChatSeedProcessEnv(seed?, base?): NodeJS.ProcessEnv`.
  - `UatProvisionOptions.withApiKeyChatProvider?: boolean`; seed hook ctx `apiKeyChat?: ApiKeyChatSeed`; `buildSeedHookInput(..., apiKeyChat?)` as its seventh parameter.
  - `uatLevel` key `withApiKeyChatProvider: true`, parsed as the last optional key.

- [ ] **Step 1: Add the host-gateway name**

In `tests/uat/compose.override.yml`, under `services.jarv1s`, after `pids_limit: 512`:

```yaml
    # Test-only: lets the opt-in API-key chat UAT reach a relay on the host's bridge gateway.
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The api and the cli-runner both run in the `jarv1s` container, so this one entry covers model discovery and the chat agents.

- [ ] **Step 2: Write the failing host-settings test**

Create `tests/uat/api-key-chat-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  API_KEY_CHAT_UAT_ENV,
  apiKeyChatSeedArgs,
  apiKeyChatSeedProcessEnv,
  apiKeyChatUatConfigured,
  readApiKeyChatUatProvider
} from "./api-key-chat-env.js";

const KEY = "ada-uat-key-0001";
const FULL = {
  [API_KEY_CHAT_UAT_ENV.kind]: "openai-compatible",
  [API_KEY_CHAT_UAT_ENV.baseUrl]: "http://proxy.test",
  [API_KEY_CHAT_UAT_ENV.model]: "ada-model",
  [API_KEY_CHAT_UAT_ENV.keyFile]: "/tmp/ada-uat-key"
};
const readKey = async () => `${KEY}\n`;

describe("API-key chat UAT settings (#3410)", () => {
  it("is off when none of the four variables is set", async () => {
    expect(apiKeyChatUatConfigured({})).toBe(false);
    await expect(readApiKeyChatUatProvider({}, readKey)).resolves.toBeUndefined();
  });

  it("reads all four and trims the key", async () => {
    expect(apiKeyChatUatConfigured(FULL)).toBe(true);
    await expect(readApiKeyChatUatProvider(FULL, readKey)).resolves.toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    });
  });

  it("names the missing variables, never the values, when only some are set", async () => {
    const partial = { ...FULL, [API_KEY_CHAT_UAT_ENV.model]: "" };
    expect(apiKeyChatUatConfigured(partial)).toBe(false);

    const error = await readApiKeyChatUatProvider(partial, readKey).catch((e: unknown) => e);

    expect((error as Error).message).toContain(API_KEY_CHAT_UAT_ENV.model);
    expect((error as Error).message).not.toContain("http://proxy.test");
    expect((error as Error).message).not.toContain("/tmp/ada-uat-key");
  });

  it("refuses a kind chat cannot drive", async () => {
    await expect(
      readApiKeyChatUatProvider({ ...FULL, [API_KEY_CHAT_UAT_ENV.kind]: "google" }, readKey)
    ).rejects.toThrow(/anthropic or openai-compatible/);
  });

  it("refuses an address that is not http or https", async () => {
    await expect(
      readApiKeyChatUatProvider({ ...FULL, [API_KEY_CHAT_UAT_ENV.baseUrl]: "proxy.test" }, readKey)
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("refuses an empty key file", async () => {
    await expect(readApiKeyChatUatProvider(FULL, async () => "\n")).rejects.toThrow(/is empty/);
  });

  it("builds seed args that carry the key by name only", () => {
    const seed = {
      providerKind: "anthropic",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    } as const;

    const args = apiKeyChatSeedArgs(seed);

    expect(args).toEqual([
      "-e",
      "MOSS_UAT_API_KEY_CHAT_KIND=anthropic",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_BASE_URL=http://proxy.test",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_MODEL=ada-model",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_KEY"
    ]);
    expect(apiKeyChatSeedProcessEnv(seed, {}).MOSS_UAT_API_KEY_CHAT_KEY).toBe(KEY);
  });

  it("blanks the seed key when not opted in, even if the base env has one", () => {
    expect(
      apiKeyChatSeedProcessEnv(undefined, { MOSS_UAT_API_KEY_CHAT_KEY: "stray" })
        .MOSS_UAT_API_KEY_CHAT_KEY
    ).toBe("");
    expect(apiKeyChatSeedArgs(undefined)).toContain("MOSS_UAT_API_KEY_CHAT_KIND=");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:unit tests/uat/api-key-chat-env.test.ts`
Expected: FAIL with "Cannot find module './api-key-chat-env.js'".

- [ ] **Step 4: Add the seed names to the shared types**

Append to `tests/uat/seed/types.ts`:

```ts
/**
 * #3410: seed-container variables for the opt-in API-key chat provider. The key travels as a
 * name-only `-e` flag with its value in the docker child env, so it never appears in argv.
 */
export const API_KEY_CHAT_SEED_ENV = {
  kind: "MOSS_UAT_API_KEY_CHAT_KIND",
  baseUrl: "MOSS_UAT_API_KEY_CHAT_BASE_URL",
  model: "MOSS_UAT_API_KEY_CHAT_MODEL",
  key: "MOSS_UAT_API_KEY_CHAT_KEY"
} as const;

export interface ApiKeyChatSeed {
  readonly providerKind: "anthropic" | "openai-compatible";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}
```

- [ ] **Step 5: Write the host-settings module**

Create `tests/uat/api-key-chat-env.ts`:

```ts
import { readSecretFile } from "../../scripts/dev-instance/secrets.js";
import { API_KEY_CHAT_SEED_ENV, type ApiKeyChatSeed } from "./seed/types.js";

/** #3410: host settings for the opt-in API-key chat UAT. All four, or none. */
export const API_KEY_CHAT_UAT_ENV = {
  kind: "MOSS_UAT_CHAT_PROVIDER_KIND",
  baseUrl: "MOSS_UAT_CHAT_PROVIDER_BASE_URL",
  model: "MOSS_UAT_CHAT_PROVIDER_MODEL",
  keyFile: "MOSS_UAT_CHAT_PROVIDER_KEY_FILE"
} as const;

const NAMES = Object.values(API_KEY_CHAT_UAT_ENV);

function value(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] ?? "";
}

export function apiKeyChatUatConfigured(env: NodeJS.ProcessEnv): boolean {
  return NAMES.every((name) => value(env, name) !== "");
}

/** Errors name variables only. Values can be private addresses or paths. */
export async function readApiKeyChatUatProvider(
  env: NodeJS.ProcessEnv,
  readKeyFile: (path: string) => Promise<string> = readSecretFile
): Promise<ApiKeyChatSeed | undefined> {
  const missing = NAMES.filter((name) => value(env, name) === "");
  if (missing.length === NAMES.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`API-key chat UAT needs ${NAMES.join(", ")}; missing ${missing.join(", ")}`);
  }

  const kind = value(env, API_KEY_CHAT_UAT_ENV.kind);
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new Error(`${API_KEY_CHAT_UAT_ENV.kind} must be anthropic or openai-compatible`);
  }
  const baseUrl = value(env, API_KEY_CHAT_UAT_ENV.baseUrl);
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(`${API_KEY_CHAT_UAT_ENV.baseUrl} must start with http:// or https://`);
  }
  const apiKey = (await readKeyFile(value(env, API_KEY_CHAT_UAT_ENV.keyFile))).trim();
  if (apiKey === "") {
    throw new Error(`The file named by ${API_KEY_CHAT_UAT_ENV.keyFile} is empty`);
  }

  return { providerKind: kind, baseUrl, model: value(env, API_KEY_CHAT_UAT_ENV.model), apiKey };
}

/** Always passed, empty means off. The key is a name-only flag. */
export function apiKeyChatSeedArgs(seed: ApiKeyChatSeed | undefined): string[] {
  return [
    "-e",
    `${API_KEY_CHAT_SEED_ENV.kind}=${seed?.providerKind ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.baseUrl}=${seed?.baseUrl ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.model}=${seed?.model ?? ""}`,
    "-e",
    API_KEY_CHAT_SEED_ENV.key
  ];
}

/** The docker child env. The key is set last, so a stray host value never leaks through. */
export function apiKeyChatSeedProcessEnv(
  seed: ApiKeyChatSeed | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...base, [API_KEY_CHAT_SEED_ENV.key]: seed?.apiKey ?? "" };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:unit tests/uat/api-key-chat-env.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Write the failing seed hook tests**

Append to `tests/uat/provisioner.test.ts`:

```ts
describe("#3410: API-key chat seed values", () => {
  const KEY = "ada-uat-key-0001";
  const seed = {
    providerKind: "openai-compatible",
    baseUrl: "http://proxy.test",
    model: "ada-model",
    apiKey: KEY
  } as const;

  function spawnExits(code: number): void {
    mocks.spawn.mockReturnValue({
      stderr: { on: vi.fn() },
      on: (event: string, listener: (exitCode: number) => void) => {
        if (event === "exit") listener(code);
      }
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MOSS_UAT_API_KEY_CHAT_KEY;
  });

  it("passes the key by name only and puts its value in the child env", async () => {
    spawnExits(0);

    await composeSeedHook({ projectName: "proj", level: "admin+data", apiKeyChat: seed });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const options = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(args.join(" ")).not.toContain(KEY);
    expect(args).toContain("MOSS_UAT_API_KEY_CHAT_KEY");
    expect(args).toContain("MOSS_UAT_API_KEY_CHAT_MODEL=ada-model");
    expect(options.env?.MOSS_UAT_API_KEY_CHAT_KEY).toBe(KEY);
  });

  it("keeps the key out of the failure message", async () => {
    spawnExits(1);

    const error = await composeSeedHook({
      projectName: "proj",
      level: "admin+data",
      apiKeyChat: seed
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("sends an empty key when the spec did not opt in", async () => {
    spawnExits(0);
    process.env.MOSS_UAT_API_KEY_CHAT_KEY = "stray-host-value";

    await composeSeedHook({ projectName: "proj", level: "admin+data" });

    const options = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.MOSS_UAT_API_KEY_CHAT_KEY).toBe("");
  });

  it("buildSeedHookInput threads the seed value", () => {
    expect(
      buildSeedHookInput("proj", "admin+data", {}, undefined, undefined, undefined, seed).apiKeyChat
    ).toBe(seed);
    expect(buildSeedHookInput("proj", "admin+data", {}).apiKeyChat).toBeUndefined();
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `pnpm test:unit tests/uat/provisioner.test.ts`
Expected: FAIL. The new cases fail (no child env, no `apiKeyChat` field); the existing cases still pass.

- [ ] **Step 9: Thread the seed value through the provisioner**

In `tests/uat/provisioner.ts`:

Add imports next to the other local imports:

```ts
import {
  apiKeyChatSeedArgs,
  apiKeyChatSeedProcessEnv,
  readApiKeyChatUatProvider
} from "./api-key-chat-env.js";
import type { ApiKeyChatSeed } from "./seed/types.js";
```

In the `SeedHook` ctx type, after `readonly chatScript?: string;`:

```ts
  /** #3410: opt-in API-key chat provider. The key reaches the seed container by env only. */
  readonly apiKeyChat?: ApiKeyChatSeed;
```

In `composeSeedHook`, add `apiKeyChat` to the destructured parameters after `chatScript`. Insert the seed args before the confirm flag, and pass the child env as the third `runCommand` argument:

```ts
      `JARVIS_UAT_SEED_CHAT_SCRIPT=${chatScript ?? ""}`,
      ...apiKeyChatSeedArgs(apiKeyChat),
      "-e",
      "JARVIS_UAT_SEED_CONFIRM=1",
      "seed"
    ]),
    apiKeyChatSeedProcessEnv(apiKeyChat)
  );
```

Give `runCommand` an optional env:

```ts
function runCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
```

and change its spawn call to:

```ts
    const child = spawn(command, args, {
      stdio: ["inherit", "inherit", "pipe"],
      ...(env ? { env } : {})
    });
```

In `UatProvisionOptions`, after `withClassifierMcpFixture`:

```ts
  /** #3410: seed the API-key chat provider from the MOSS_UAT_CHAT_PROVIDER_* host variables. */
  readonly withApiKeyChatProvider?: boolean;
```

In `buildSeedHookInput`, add a seventh parameter after `classifierFixtureAiProviderBaseUrl?: string`, add the field to the return type after `chatScript?: string;`, and to the returned object after `chatScript: opts?.chatScript`:

```ts
  apiKeyChat?: ApiKeyChatSeed
```

```ts
  apiKeyChat?: ApiKeyChatSeed;
```

```ts
    chatScript: opts?.chatScript,
    apiKeyChat
```

In `provisionForUat`, directly after `const overallStart = Date.now();`, read the host settings once, before any container starts:

```ts
  const apiKeyChatSeed = opts?.withApiKeyChatProvider
    ? await readApiKeyChatUatProvider(process.env)
    : undefined;
```

At the `composeSeedHook(buildSeedHookInput(...))` call, add `apiKeyChatSeed` as the last argument after the classifier argument:

```ts
          opts?.withClassifierFixture ? classifierFixtureBaseUrl : undefined,
          apiKeyChatSeed
```

- [ ] **Step 10: Run the tests and check the line count**

Run: `pnpm test:unit tests/uat/provisioner.test.ts`
Expected: PASS, all cases.

Run: `wc -l tests/uat/provisioner.ts`
Expected: under 1000 (about 985).

- [ ] **Step 11: Removal step (key by name only)**

Temporarily change the last entry of `apiKeyChatSeedArgs` to carry the value:

```ts
    `${API_KEY_CHAT_SEED_ENV.key}=${seed?.apiKey ?? ""}`
```

Run: `pnpm test:unit tests/uat/provisioner.test.ts`
Expected: FAIL on "passes the key by name only" and "keeps the key out of the failure message". Revert and rerun to PASS.

- [ ] **Step 12: Removal step (stray host key blanked)**

Temporarily swap the spread order in `apiKeyChatSeedProcessEnv` so the base env wins:

```ts
  return { [API_KEY_CHAT_SEED_ENV.key]: seed?.apiKey ?? "", ...base };
```

Run: `pnpm test:unit tests/uat/provisioner.test.ts`
Expected: FAIL on "sends an empty key when the spec did not opt in". Revert and rerun to PASS.

- [ ] **Step 13: Write the failing runner test**

In `tests/uat/run-uat.test.ts`, add `withApiKeyChatProvider: false,` after `withClassifierMcpFixture: false,` in the four exact `toHaveBeenCalledWith` objects (lines 65, 111, 164 and 195; leave the `expect.objectContaining` one at line 219 alone). Then add a case next to "threads the classifier fixture origin flag after the briefing-writer flag":

```ts
  it("#3410: threads the API-key chat provider flag as the last key", async () => {
    mocks.readFile.mockResolvedValue(
      `export const uatLevel = {
        level: "admin+data",
        without: [],
        withApiKeyChatProvider: true
      } as const;`
    );
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await import("./run-uat.js");

    expect(mocks.provisionForUat).toHaveBeenCalledWith(
      "admin+data",
      expect.objectContaining({ withApiKeyChatProvider: true, withClassifierMcpFixture: false })
    );
  });
```

Run: `pnpm test:unit tests/uat/run-uat.test.ts`
Expected: FAIL. The new case fails with "must export uatLevel" (the regex rejects the unknown key), and the four exact objects fail on the missing field.

- [ ] **Step 14: Parse the new key**

In `tests/uat/run-uat.ts`:

- In the `readUatLevel` return type, after `withClassifierMcpFixture: boolean;`, add `withApiKeyChatProvider: boolean;` with the comment `// #3410: same trailing-optional-key pattern; opts into the API-key chat provider seed.`
- In the regex on line 75, insert this group immediately before the final `\s*\}\s+as const`:

```
\s*(?:,\s*withApiKeyChatProvider:\s*(true|false))?
```

- After `const withClassifierMcpFixtureSource = match?.[13];` add `const withApiKeyChatProviderSource = match?.[14];`.
- In the returned object, after `withClassifierMcpFixture: ...`, add `withApiKeyChatProvider: withApiKeyChatProviderSource === "true"`.
- In `runSpec`'s `provisionForUat` options, after `withClassifierMcpFixture: uatLevel.withClassifierMcpFixture`, add `withApiKeyChatProvider: uatLevel.withApiKeyChatProvider`.

Run: `pnpm test:unit tests/uat/run-uat.test.ts`
Expected: PASS, all cases.

- [ ] **Step 15: Commit**

```bash
git add tests/uat/compose.override.yml tests/uat/api-key-chat-env.ts \
  tests/uat/api-key-chat-env.test.ts tests/uat/seed/types.ts tests/uat/provisioner.ts \
  tests/uat/provisioner.test.ts tests/uat/run-uat.ts tests/uat/run-uat.test.ts
git commit -m "test(uat): opt-in API-key chat seed plumbing with name-only key passing (#3410)"
```

### Task 20: Seed the API-key chat provider and the live UAT spec

**Files:**
- Create: `tests/uat/seed/chunks/api-key-chat.ts`
- Test: `tests/uat/seed/chunks/api-key-chat-parse.test.ts` (create, pure)
- Test: `tests/uat/seed/chunks/api-key-chat.test.ts` (create, database, verify-gate only)
- Modify: `tests/uat/seed/types.ts:80-124` (`SeedOptions`)
- Modify: `tests/uat/seed/cli.ts:48-87`
- Modify: `tests/uat/seed/levels.ts:1-19`, `:136-140`
- Create: `tests/uat/specs/3410-api-key-chat.uat.spec.ts`

**Interfaces:**
- Consumes: Task 19's `API_KEY_CHAT_SEED_ENV`, `ApiKeyChatSeed`, `apiKeyChatUatConfigured`, the `withApiKeyChatProvider` key. Main plan Task 12 (chat accepts API-key rows).
- Produces: `parseApiKeyChatSeed(env): ApiKeyChatSeed | undefined`, `seedApiKeyChatProviderChunk(runner, actorUserId, seed): Promise<void>`, `UAT_API_KEY_CHAT_PROVIDER_NAME = "UAT API-key chat provider"`, `SeedOptions.apiKeyChat?: ApiKeyChatSeed`.

- [ ] **Step 1: Write the failing parse test**

Create `tests/uat/seed/chunks/api-key-chat-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseApiKeyChatSeed } from "./api-key-chat.js";

const KEY = "ada-uat-key-0001";
const FULL = {
  MOSS_UAT_API_KEY_CHAT_KIND: "openai-compatible",
  MOSS_UAT_API_KEY_CHAT_BASE_URL: "http://proxy.test",
  MOSS_UAT_API_KEY_CHAT_MODEL: "ada-model",
  MOSS_UAT_API_KEY_CHAT_KEY: KEY
};

describe("parseApiKeyChatSeed (#3410)", () => {
  it("is off when every value is empty, as the seed hook sends them", () => {
    expect(
      parseApiKeyChatSeed({
        MOSS_UAT_API_KEY_CHAT_KIND: "",
        MOSS_UAT_API_KEY_CHAT_BASE_URL: "",
        MOSS_UAT_API_KEY_CHAT_MODEL: "",
        MOSS_UAT_API_KEY_CHAT_KEY: ""
      })
    ).toBeUndefined();
  });

  it("returns the seed when all four are set", () => {
    expect(parseApiKeyChatSeed(FULL)).toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    });
  });

  it("refuses a partial set without echoing any value", () => {
    let message = "";
    try {
      parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_MODEL: "" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/together/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("http://proxy.test");
  });

  it("refuses a kind chat cannot drive", () => {
    expect(() => parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_KIND: "google" })).toThrow(
      /anthropic or openai-compatible/
    );
  });
});
```

Run: `pnpm test:unit tests/uat/seed/chunks/api-key-chat-parse.test.ts`
Expected: FAIL with "Cannot find module './api-key-chat.js'".

- [ ] **Step 2: Write the seed chunk**

Create `tests/uat/seed/chunks/api-key-chat.ts`:

```ts
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";

import { API_KEY_CHAT_SEED_ENV, type ApiKeyChatSeed } from "../types.js";

export const UAT_API_KEY_CHAT_PROVIDER_NAME = "UAT API-key chat provider";

/** Reads the four seed variables. All empty means off. Errors never echo a value. */
export function parseApiKeyChatSeed(env: NodeJS.ProcessEnv): ApiKeyChatSeed | undefined {
  const kind = env[API_KEY_CHAT_SEED_ENV.kind] ?? "";
  const baseUrl = env[API_KEY_CHAT_SEED_ENV.baseUrl] ?? "";
  const model = env[API_KEY_CHAT_SEED_ENV.model] ?? "";
  const apiKey = env[API_KEY_CHAT_SEED_ENV.key] ?? "";
  const values = [kind, baseUrl, model, apiKey];

  if (values.every((entry) => entry === "")) return undefined;
  if (values.some((entry) => entry === "")) {
    throw new Error(
      `${Object.values(API_KEY_CHAT_SEED_ENV).join(", ")} must be set together or not at all`
    );
  }
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new Error(`${API_KEY_CHAT_SEED_ENV.kind} must be anthropic or openai-compatible`);
  }
  return { providerKind: kind, baseUrl, model, apiKey };
}

/**
 * #3410: one API-key provider, its chat model, and the instance default pointing at it. Opt-in
 * only (uatLevel `withApiKeyChatProvider`); never part of the default chunk ladder.
 */
export async function seedApiKeyChatProviderChunk(
  runner: DataContextRunner,
  actorUserId: string,
  seed: ApiKeyChatSeed
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: seed.providerKind,
      displayName: UAT_API_KEY_CHAT_PROVIDER_NAME,
      baseUrl: seed.baseUrl,
      authMethod: "api_key",
      encryptedCredential: cipher.encryptJson({ apiKey: seed.apiKey })
    });
    await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: seed.model,
      displayName: seed.model,
      capabilities: ["chat", "tool-use"],
      tier: "interactive"
    });
    await repo.setInstanceDefaultProvider(scopedDb, provider.id);
  });
}
```

Run: `pnpm test:unit tests/uat/seed/chunks/api-key-chat-parse.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Removal step (seed errors never echo values)**

Temporarily change the partial-set error to include the values:

```ts
    throw new Error(`API-key chat seed is partial: ${values.join(", ")}`);
```

Run: `pnpm test:unit tests/uat/seed/chunks/api-key-chat-parse.test.ts`
Expected: FAIL on "refuses a partial set without echoing any value". Revert and rerun to PASS.

- [ ] **Step 4: Write the database test for the chunk**

Create `tests/uat/seed/chunks/api-key-chat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AiRepository, createAiSecretCipher, parseAiApiKeyCredential } from "@moss/ai";

import { createAppRuntimeRunner, createMigrationOwnerDb } from "../connections.js";
import { seedSoloAdmin } from "../admin.js";
import { seedAiProviderChunk } from "./ai.js";
import { seedApiKeyChatProviderChunk, UAT_API_KEY_CHAT_PROVIDER_NAME } from "./api-key-chat.js";

describe("seedApiKeyChatProviderChunk (#3410)", () => {
  it("seeds an API-key provider whose model chat selects, after the default AI chunk", async () => {
    const migrationDb = createMigrationOwnerDb();
    const { userId } = await seedSoloAdmin(migrationDb);
    await migrationDb.destroy();

    const runner = createAppRuntimeRunner();
    try {
      await seedAiProviderChunk(runner, userId, { bindNews: true });
      await seedApiKeyChatProviderChunk(runner, userId, {
        providerKind: "openai-compatible",
        baseUrl: "http://proxy.test",
        model: "ada-model",
        apiKey: "ada-uat-key-0001"
      });

      const repo = new AiRepository();
      await runner.withDataContext({ actorUserId: userId }, async (scopedDb) => {
        const providers = await repo.listProviders(scopedDb);
        const seeded = providers.filter(
          (row) => row.display_name === UAT_API_KEY_CHAT_PROVIDER_NAME
        );
        expect(seeded).toHaveLength(1);
        expect(seeded[0]?.auth_method).toBe("api_key");
        expect(seeded[0]?.base_url).toBe("http://proxy.test");
        expect(seeded[0]?.is_instance_default).toBe(true);

        // listProviders never selects the credential column, so read the stored value itself.
        const sealed = await repo.selectProviderWithCredential(scopedDb, seeded[0]?.id ?? "");
        if (!sealed) throw new Error("seeded provider row has no stored credential");
        expect(JSON.stringify(sealed.encrypted_credential)).not.toContain("ada-uat-key-0001");
        const opened = parseAiApiKeyCredential(
          createAiSecretCipher().decryptJson(sealed.encrypted_credential)
        );
        expect(opened?.apiKey).toBe("ada-uat-key-0001");

        const chatModel = await repo.selectChatModelForUser(scopedDb);
        expect(chatModel?.provider_config_id).toBe(seeded[0]?.id);
        expect(chatModel?.provider_model_id).toBe("ada-model");
      });
    } finally {
      await runner.destroy();
    }
  });
});
```

This is a database test. It runs under verify-gate in Task 21 (`pnpm test:uat-seed`).

Removal step (the stored key is sealed): temporarily change the chunk's `encryptedCredential: cipher.encryptJson({ apiKey: seed.apiKey })` to `encryptedCredential: { apiKey: seed.apiKey } as unknown as ReturnType<typeof cipher.encryptJson>`.
Run: `scripts/run-gate.sh start --gate test:uat-seed`, then `scripts/run-gate.sh wait --follow`.
Expected: FAIL on "seeds an API-key provider whose model chat selects, after the default AI chunk", at the `not.toContain` line. Record the failure in the PR body, then revert. The passing run is part of Task 21.

- [ ] **Step 5: Add the seed option**

In `tests/uat/seed/types.ts`, inside `SeedOptions`, after the `chatScript` field:

```ts
  /**
   * #3410: absent by default. When set, seeds an API-key provider at this address with one chat
   * model and makes it the instance default. Applies at admin+data and multi-user only.
   */
  readonly apiKeyChat?: ApiKeyChatSeed;
```

`ApiKeyChatSeed` is declared later in the same file (Task 19); TypeScript hoists interface declarations, so no reordering is needed.

- [ ] **Step 6: Read it in the seed CLI**

In `tests/uat/seed/cli.ts`, add the import with the other local imports:

```ts
import { parseApiKeyChatSeed } from "./chunks/api-key-chat.js";
```

After the `chatScript` constant:

```ts
  // #3410: all four empty (composeSeedHook always passes them) reads as absent.
  const apiKeyChat = parseApiKeyChatSeed(process.env);
```

Add `apiKeyChat` to the `seedLevel({...})` call after `chatScript`.

- [ ] **Step 7: Apply it in the level ladder**

In `tests/uat/seed/levels.ts`, add the import after the `classifier-ai.js` import:

```ts
import { seedApiKeyChatProviderChunk } from "./chunks/api-key-chat.js";
```

Directly after the `await seedAiProviderChunk(runner, adminUserId, { ... });` call:

```ts
    // #3410: opt-in. Runs after the default AI chunk so its instance default wins.
    if (options.apiKeyChat) {
      await seedApiKeyChatProviderChunk(runner, adminUserId, options.apiKeyChat);
    }
```

- [ ] **Step 8: Write the UAT spec**

Create `tests/uat/specs/3410-api-key-chat.uat.spec.ts`:

```ts
// tests/uat/specs/3410-api-key-chat.uat.spec.ts
//
// #3410 live path: with an API-key provider as the instance default, the chat drawer answers,
// asks for confirmation before a write, and the approved task exists. Opt-in: runs only when the
// four MOSS_UAT_CHAT_PROVIDER_* host variables are set and a relay answers on the bridge gateway.
import { expect, test, type Locator } from "@playwright/test";

import { apiKeyChatUatConfigured } from "../api-key-chat-env.js";
import { readUatJson, requireUatBaseURL, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withApiKeyChatProvider: true
} as const;

const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const TASK_TITLE = "Ada's API-key chat task";

test("an API-key provider drives drawer chat through a confirmation card (#3410)", async ({
  page
}) => {
  test.skip(
    !apiKeyChatUatConfigured(process.env),
    "Set the four MOSS_UAT_CHAT_PROVIDER_* variables to run this proof"
  );
  test.setTimeout(420_000);

  const drawer: Locator = page.locator("aside.chatd");

  await test.step("sign in and open the drawer", async () => {
    await signInUatAdmin(page);
    await page.locator(".topbar-actions button").click();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
  });

  await test.step("ask for a task and approve the confirmation card", async () => {
    const composer = drawer.getByLabel("Message Moss");
    await composer.fill(`Add a task called "${TASK_TITLE}".`);
    const turnResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
        response.request().method() === "POST",
      { timeout: 300_000 }
    );
    await composer.press("Enter");

    const card = page.locator(ACTION_CARD).last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 180_000 });
    await card.getByRole("button", { name: "Approve" }).click();

    const response = await turnResponse;
    expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
  });

  await test.step("the approved task exists", async () => {
    await expect
      .poll(
        async () => {
          const body = (await readUatJson(
            await page.request.get(`${requireUatBaseURL()}/api/tasks`)
          )) as { tasks: Array<{ title: string }> };
          return body.tasks.some((task) => task.title === TASK_TITLE);
        },
        { timeout: 30_000, message: "the approved task never appeared" }
      )
      .toBe(true);
  });
});
```

- [ ] **Step 9: Type-check and rerun the pure tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm test:unit tests/uat/seed/chunks/api-key-chat-parse.test.ts`
Expected: PASS, 4 tests.

Run: `pnpm test:unit tests/uat/run-uat.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add tests/uat/seed/chunks/api-key-chat.ts tests/uat/seed/chunks/api-key-chat-parse.test.ts \
  tests/uat/seed/chunks/api-key-chat.test.ts tests/uat/seed/types.ts tests/uat/seed/cli.ts \
  tests/uat/seed/levels.ts tests/uat/specs/3410-api-key-chat.uat.spec.ts
git commit -m "test(uat): seed an API-key chat provider and prove drawer chat with approval (#3410)"
```

### Task 21: Gate and live proofs for seeding and UAT

**Files:** none changed unless the gate finds something. Results go in a PR comment.

- [ ] **Step 1: verify-gate**

Run the full gate through the verify-gate skill. It covers the three new provision cases in `tests/integration/dev-instance-provision.test.ts` and the chunk test through `pnpm test:uat-seed`.
Expected: green. Then:

```bash
wc -l tests/uat/provisioner.ts scripts/dev-instance/provision.ts scripts/dev-instance/config.ts
```

Expected: every file under 1000.

- [ ] **Step 2: Dev-instance seeding, live**

Claim a port with `devports claim <your-agent-name>` and start a dev instance on it the usual way, with these set in the shell (values from the proxy owner, never written to a file in the repo):

```bash
export MOSS_DEV_INSTANCE_PROVIDER_KIND=openai-compatible
export MOSS_DEV_INSTANCE_PROVIDER_AUTH=api_key
export MOSS_DEV_INSTANCE_PROVIDER_BASE_URL="$PROXY_URL"
export MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE="$PROXY_KEY_FILE"
pnpm dev:instance provision
```

Expected output lines: `provider-rows: changed` naming the API-key provider, and `cli-token: unchanged — skipped: API-key provider`. Run `pnpm dev:instance provision` a second time and expect `provider-rows: unchanged`. In the browser, Admin > AI providers shows "Dev instance API key" as the default with chat readiness "ready"; the chat drawer answers a plain question. Repeat once with `MOSS_DEV_INSTANCE_PROVIDER_KIND=anthropic` and the Anthropic-style address.

Then run the key scanner as in main plan Task 16 Step 7, with this instance's log and agent-home directories:

```bash
node /tmp/acp-proof/key-scan.mjs "$PROXY_KEY_FILE" --argv
node /tmp/acp-proof/key-scan.mjs "$PROXY_KEY_FILE" <dev-instance log directory> <dev-instance agent homes>
```

Expected: `ARGV_HITS 0` and `FILE_HITS 0`, then `FILE_HITS 0`. Report counts and file names only. Stop the instance and run `devports release <port>`.

- [ ] **Step 3: UAT spec skips cleanly when not configured**

With none of the `MOSS_UAT_CHAT_PROVIDER_*` variables set, run `3410-api-key-chat.uat.spec.ts` through the verify-gate skill's UAT mode.
Expected: the spec reports skipped and the run passes. This proves only that an unconfigured run stays out of the way. It does not close phase 5.

- [ ] **Step 4: UAT spec through the relay, if one is available**

Check whether a relay answers on the bridge gateway. This request carries no key, so any HTTP status, including 401, means it is reachable; `000` means it is not:

```bash
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl \
  -s -o /dev/null -w '%{http_code}\n' "$MOSS_UAT_CHAT_PROVIDER_BASE_URL/v1/models"
```

If it is reachable, set the four `MOSS_UAT_CHAT_PROVIDER_*` variables (the key file is `$PROXY_KEY_FILE`, the model `$PROXY_OPENAI_MODEL` or `$PROXY_ANTHROPIC_MODEL` to match the kind) and run the spec through verify-gate's UAT mode. Expected: pass, with the spec reported as run, not skipped. If it is not reachable, do not set the variables; record that the UAT proof waits on the relay.

Phase 5 closes only when this step passes through the relay. Until then, phase 4 (dev-instance seeding) can close on Step 2, and phase 5 stays open on #3410 with "waiting on the relay". The relay lives outside this repo, so it is not built here.

- [ ] **Step 5: Report on the PR**

Post one `gh pr comment` in plain English, with seeding and UAT as two separate results:

- Seeding (phase 4): the gate result, the dev-instance seeding result for each kind, whether provisioning twice left one row, and the key scanner result.
- UAT (phase 5): "passed through the relay", or "open: relay not available". A skipped run is never reported as a pass.

Say that the proof used a stand-in local proxy that speaks Chat Completions. Never paste the address, the key, the key file path or matching log lines. Post the same two results on #3410, and leave phase 5 unticked there until the relay run passes.

---

## Self-Review

### Spec coverage

| Spec requirement (sections 6 and 7) | Task |
| --- | --- |
| `MOSS_DEV_INSTANCE_PROVIDER_AUTH`, `_BASE_URL`, `_KEY_FILE`; `api_key` needs a key file | 17 |
| Dev instance registers the API-key provider as the default | 18 |
| CLI login step not needed for API-key dev instances | 18 |
| UAT `extra_hosts` host-gateway entry, test-only | 19 |
| UAT seed gets the address and the key; production compose never sees them | 19, 20 |
| UAT proof of chat with a confirmation card | 20, 21 |
| Seeding uses a model from this run's list; an empty or stale list refuses | 18 |
| Seeded key is stored sealed and opens to the same key | 20 |
| Leak searches read the key file themselves | 21 Step 2 |
| Phase 5 closes only on a relay-backed UAT pass; seeding reported separately | 21 Steps 3-5 |

### Deviations from the spec, found in the code

- The UAT key reaches the seed container through its environment, by variable name only, not through the generated env file. The env file feeds the long-running `jarv1s` service and the seed needs the key once (Task 19).
- The UAT seed is opt-in per spec through `withApiKeyChatProvider`. Otherwise a host shell with the variables set would replace the default provider for every spec (Task 19).
- The discovery helper was not exported from `@moss/ai`, so Task 18 exports it.
- API-key discovery never deletes older model rows, so the discovery outcome now reports this run's chat ids and seeding checks against them (Task 18).
- `listProviders` never selects the stored credential, so the seed test reads it through `selectProviderWithCredential` (Task 20).
- Three test helpers build a full dev config, so the new required fields touch two integration files (Task 17).

### Placeholder scan

No "TBD", "TODO" or "similar to Task N". `<your-agent-name>`, `<relay port>`, `<dev-instance log directory>` and `<dev-instance agent homes>` are filled on the day from the tools that print them.

### Type consistency

- `DevInstanceConfig.providerAuth`, `providerBaseUrl`, `providerKeyFilePath`: Tasks 17 and 18.
- `ApiKeyProviderOutcome { changed, providerId, chatModelId }`: Task 18 module, provision step and integration test.
- `DiscoverAndPersistModelsOutcome.discoveredModelIds`: produced in Task 18 Step 3, read by `ensureApiKeyProvider`, faked by the unit harness and real in the integration case.
- `ApiKeyChatSeed { providerKind, baseUrl, model, apiKey }` and `API_KEY_CHAT_SEED_ENV`: Tasks 19 and 20.
- `withApiKeyChatProvider`: run-uat regex, `UatProvisionOptions`, spec `uatLevel` (Tasks 19 and 20).
