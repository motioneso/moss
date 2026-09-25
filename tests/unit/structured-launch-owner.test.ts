/**
 * #2674 — a structured CLI call carries its owning user all the way to the runner's launch,
 * and a runner refusal reaches the worker log with its reason.
 */
import { describe, expect, it, vi } from "vitest";

import type * as MossDb from "@moss/db";
import type { DataContextDb } from "@moss/db";

vi.mock("@moss/db", async (importOriginal) => ({
  ...(await importOriginal<typeof MossDb>()),
  readScopedActorUserId: vi.fn(async () => ACTOR)
}));

import {
  generateStructured,
  type GenerateStructuredDeps,
  type StructuredProviderAdapter
} from "../../packages/ai/src/structured/generate-structured.js";
import type { GenerateStructuredProviderInput } from "../../packages/ai/src/adapters/http-api-structured.js";
import { CliStructuredAdapter } from "../../packages/chat/src/live/cli-structured-adapter.js";
import { ChatEngineRpcClient } from "../../packages/chat/src/live/chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import {
  selectEngineFactory,
  type ChatEngineFactory
} from "../../packages/chat/src/live/runtime.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";

const ACTOR = "33333333-3333-4333-8333-333333333333";
const scopedDb = {} as DataContextDb;
const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
const model = {
  id: "model-1",
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "claude-x"
} as never;

function cliDeps(
  adapter: StructuredProviderAdapter,
  warn = vi.fn()
): GenerateStructuredDeps & { warn: typeof warn } {
  return {
    warn,
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(
        async () =>
          ({
            id: "provider-1",
            auth_method: "cli",
            base_url: null,
            encrypted_credential: {}
          }) as never
      )
    } as GenerateStructuredDeps["repository"],
    cipher: { decryptJson: vi.fn() },
    logger: { info: vi.fn(), warn },
    createCliStructuredAdapter: () => adapter
  };
}

describe("#2674 generateStructured names the acting user for a CLI provider", () => {
  it("passes the scoped actor to the CLI adapter", async () => {
    const seen: GenerateStructuredProviderInput[] = [];
    const adapter: StructuredProviderAdapter = {
      generateStructured: async (input) => {
        seen.push(input);
        return { rawObject: { a: "b" }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    };

    const result = await generateStructured(
      scopedDb,
      { service: "module.demo-module", schema, prompt: "extract" },
      cliDeps(adapter)
    );

    expect(result.ok).toBe(true);
    expect(seen[0]?.actorUserId).toBe(ACTOR);
  });

  it("logs the runner's refusal reason for an operator-safe error", async () => {
    const adapter: StructuredProviderAdapter = {
      generateStructured: async () => {
        throw new CliChatUnavailableError(
          "[cli-runner] UID slot overflow: maximum user slots exhausted"
        );
      }
    };
    const deps = cliDeps(adapter);

    await generateStructured(
      scopedDb,
      { service: "module.demo-module", schema, prompt: "extract" },
      deps
    );

    expect(deps.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "CliChatUnavailableError",
        reason: "[cli-runner] UID slot overflow: maximum user slots exhausted"
      }),
      "ai.structured provider error"
    );
  });

  it("logs no text for an error that is not operator-safe", async () => {
    const adapter: StructuredProviderAdapter = {
      generateStructured: async () => {
        throw new Error("private response body");
      }
    };
    const deps = cliDeps(adapter);

    await generateStructured(
      scopedDb,
      { service: "module.demo-module", schema, prompt: "extract" },
      deps
    );

    const [fields] = deps.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).not.toHaveProperty("reason");
    expect(JSON.stringify(fields)).not.toContain("private response body");
  });
});

function replyingEngine(): CliChatEngine {
  return {
    provider: "anthropic",
    async launch() {
      return { offset: 0 };
    },
    async submit() {},
    async interrupt() {},
    async readNew() {
      return { records: [{ kind: "reply", text: "{}" }], offset: 1, complete: true };
    },
    async isAlive() {
      return true;
    },
    async kill() {},
    async purgeTranscripts() {}
  };
}

describe("#2674 the CLI structured adapter launches under its owner", () => {
  it("hands the actor to the engine factory for a one-shot call", async () => {
    const owners: (string | undefined)[] = [];
    const factory: ChatEngineFactory = (_provider, _key, opts) => {
      owners.push(opts?.userId);
      return replyingEngine();
    };
    const adapter = new CliStructuredAdapter("anthropic", factory, 5_000, 1);

    await adapter.generateStructured({
      service: "module.demo-module",
      model: { provider_kind: "anthropic", provider_model_id: "claude-x" },
      messages: [{ role: "user", content: "score this" }],
      schema: { type: "object", properties: {} },
      maxOutputTokens: 100,
      actorUserId: ACTOR
    });

    expect(owners).toEqual([ACTOR]);
  });
});

describe("#2674 the RPC launch carries the owner to the runner", () => {
  it("puts the user id in the launch params", async () => {
    const launches: Record<string, unknown>[] = [];
    const conn = {
      launch: vi.fn(async (_key: string, params: Record<string, unknown>) => {
        launches.push(params);
        return { offset: 0 };
      })
    };
    const client = new ChatEngineRpcClient(
      "anthropic",
      "structured-abc",
      conn as never,
      "non_interactive",
      undefined,
      true,
      ACTOR
    );

    await client.launch({ neutralDir: "/unused", personaPath: "/unused/persona.md" });

    expect(launches[0]).toMatchObject({ userId: ACTOR, needsStructuredOutput: true });
  });

  it("the RPC engine factory threads the user id into the client", () => {
    const { factory, connection } = selectEngineFactory({
      env: {
        JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
        JARVIS_CLI_RUNNER_RPC_SECRET: "test-secret"
      }
    });
    const engine = factory("anthropic", "structured-abc", {
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      userId: ACTOR
    }) as unknown as { userId?: string };

    expect(engine).toBeInstanceOf(ChatEngineRpcClient);
    expect(engine.userId).toBe(ACTOR);
    connection?.close();
  });
});
