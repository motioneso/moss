/**
 * Unit tests for the #342 Phase-1.5 composition-root wiring (Lane A): the engine-factory boot-time
 * fork (`selectEngineFactory`) and its SECURITY FAIL-FAST.
 *
 *   - §3.5: when JARVIS_CLI_RUNNER_SOCKET is set → the RPC client (ChatEngineRpcClient); else the
 *     in-process engine.
 *   - §6.6 FAIL-FAST: when the socket is selected but JARVIS_CLI_RUNNER_RPC_SECRET is missing/empty,
 *     selection THROWS at boot — BEFORE any RpcConnection is constructed or any socket is opened —
 *     with a message that contains NO secret value. The in-process path is unaffected.
 *
 * These are pure selection tests; no socket is opened (the factory does not connect until first
 * engine use, and the fail-fast throws before construction), so they need no real cli-runner.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ChatEngineRpcClient,
  CliChatUnavailableError,
  createRealEngineFactory,
  createChatSessionRuntime,
  RpcConnection,
  selectEngineFactory
} from "../../packages/chat/src/live/runtime.js";
import { createStructuredChatEngineFactory } from "../../packages/module-registry/src/index.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";
import { CliChatEngineImpl } from "../../packages/chat/src/live/cli-chat-engine.js";
import type { Multiplexer, MuxHandle } from "@moss/ai";

const SOCKET = "/run/jarv1s/cli-runner.sock";

function fakeMux(): Multiplexer & { opened: string[]; killed: MuxHandle[] } {
  return {
    kind: "tmux",
    opened: [],
    killed: [],
    async open(opts) {
      this.opened.push(opts.launchLine);
      return `handle-${this.opened.length}`;
    },
    async submit() {},
    async clearComposer() {},
    async clearComposerHard() {},
    async capturePane() {
      return "";
    },
    async paste() {},
    async pressEnter() {},
    async isAlive() {
      return true;
    },
    async kill(handle) {
      this.killed.push(handle);
    },
    async interrupt() {},
    attachCommand() {
      return "tmux attach";
    }
  };
}

describe("selectEngineFactory — boot-time fork (§3.5)", () => {
  it("selects the RPC client when the socket + secret are configured", async () => {
    const { factory, connection } = selectEngineFactory({
      env: {
        JARVIS_CLI_RUNNER_SOCKET: SOCKET,
        JARVIS_CLI_RUNNER_RPC_SECRET: "boot-secret"
      } as NodeJS.ProcessEnv
    });
    try {
      const engine = await factory("anthropic", "user-a");
      expect(engine).toBeInstanceOf(ChatEngineRpcClient);
      expect(engine.provider).toBe("anthropic");
      expect(connection).toBeDefined();
    } finally {
      connection?.close();
    }
  });

  it("uses the adopted RPC connection for structured preview engines", async () => {
    const connection = {} as RpcConnection;
    const factory = createStructuredChatEngineFactory({
      socketConfigured: true,
      getRpcConnection: () => connection,
      fallback: () => {
        throw new Error("host fallback must not run on socket path");
      }
    });

    const engine = await factory("anthropic", "persona-preview", { executionMode: "non_interactive" });
    expect(engine).toBeInstanceOf(ChatEngineRpcClient);
    expect(engine.provider).toBe("anthropic");
  });

  it("falls back to the in-process engine when the socket env is absent", async () => {
    const { factory, connection } = selectEngineFactory({ env: {} as NodeJS.ProcessEnv });
    const engine = await factory("anthropic", "user-a");
    expect(engine).not.toBeInstanceOf(ChatEngineRpcClient);
    expect(connection).toBeUndefined();
  });
});

describe("createRealEngineFactory — provider execution mode", () => {
  it("routes Anthropic non_interactive to the Claude print engine", async () => {
    const engine = await createRealEngineFactory({ mux: fakeMux() })("anthropic", "user-a", {
      executionMode: "non_interactive"
    });

    expect(engine).toBeInstanceOf(ClaudePrintChatEngine);
  });

  it("keeps Anthropic interactive on the existing CLI engine", async () => {
    const engine = await createRealEngineFactory({ mux: fakeMux() })("anthropic", "user-a", {
      executionMode: "interactive"
    });

    expect(engine).toBeInstanceOf(CliChatEngineImpl);
  });
});

describe("selectEngineFactory — SECURITY FAIL-FAST on a missing RPC secret (§6.6)", () => {
  it("THROWS when the socket is set but the secret is missing", () => {
    expect(() =>
      selectEngineFactory({
        env: { JARVIS_CLI_RUNNER_SOCKET: SOCKET } as NodeJS.ProcessEnv
      })
    ).toThrow(CliChatUnavailableError);
  });

  it("THROWS when the socket is set but the secret is an empty string", () => {
    expect(() =>
      selectEngineFactory({
        env: {
          JARVIS_CLI_RUNNER_SOCKET: SOCKET,
          JARVIS_CLI_RUNNER_RPC_SECRET: ""
        } as NodeJS.ProcessEnv
      })
    ).toThrow(CliChatUnavailableError);
  });

  it("throws BEFORE constructing any connection (no socket opened) and names both env vars", () => {
    let thrown: unknown;
    try {
      selectEngineFactory({
        env: { JARVIS_CLI_RUNNER_SOCKET: SOCKET } as NodeJS.ProcessEnv
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliChatUnavailableError);
    const message = (thrown as Error).message;
    // The message names the two env vars so the operator can fix the deploy config…
    expect(message).toContain("JARVIS_CLI_RUNNER_SOCKET");
    expect(message).toContain("JARVIS_CLI_RUNNER_RPC_SECRET");
    // …and it is fail-CLOSED: a secret-less RPC path never starts (this is the whole point — the
    // previous `rpcSecret ?? ""` was fail-OPEN). There is no secret VALUE to leak (none was set).
  });

  it("does NOT throw on the in-process path even with no secret set", () => {
    expect(() => selectEngineFactory({ env: {} as NodeJS.ProcessEnv })).not.toThrow();
  });
});

describe("createChatSessionRuntime — boot reconciliation", () => {
  it("connects the RPC client on boot so reconciliation runs before first turn", async () => {
    const ensureConnected = vi
      .spyOn(RpcConnection.prototype, "ensureConnected")
      .mockResolvedValue(undefined);

    const runtime = await createChatSessionRuntime({
      dataContext: {
        withDataContext: async (
          _access: { readonly actorUserId: string; readonly requestId: string },
          fn: (db: never) => unknown
        ) => fn({} as never)
      } as never,
      engineSelection: {
        env: {
          JARVIS_CLI_RUNNER_SOCKET: SOCKET,
          JARVIS_CLI_RUNNER_RPC_SECRET: "boot-secret"
        } as NodeJS.ProcessEnv
      }
    });

    try {
      expect(ensureConnected).toHaveBeenCalledTimes(1);
      expect(runtime.connection).toBeDefined();
    } finally {
      runtime.shutdown();
      ensureConnected.mockRestore();
    }
  });
});
