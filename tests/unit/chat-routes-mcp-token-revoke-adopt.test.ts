/**
 * #1554 task #6 — `registerChatRoutes`'s `wiring` closure (built when `resolveActiveModules` +
 * `mcpServerUrl` are both supplied) must publish `SessionTokenRegistry.revokeBySessionId` back to
 * the composition root via the new `adoptMcpTokenRevoke` late-bound "adopt" seam — same pattern
 * as `adoptChatRpcConnection`/`adoptDropSessionsForProvider`. This is what lets
 * `module-registry/src/index.ts` thread a real revoke function into
 * `chat-multiplexer.ts`'s `resolveChatEngineFactory` as `onPersistentReap`, closing task #5's
 * documented gap: the persistent-runtime pool's idle-reap/LRU-evict sweep now also revokes the
 * reaped session's MCP token, not just the pool slot.
 *
 * No real DB, tmux, or gateway call is exercised — only that the adopt seam fires with a function
 * that forwards to the real `SessionTokenRegistry` instance built inside the wiring closure
 * (spied via `vi.spyOn`, matching `chat-session-manager-remote-reap.test.ts`'s approach for the
 * equivalent normal-session-end revoke path).
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

describe("registerChatRoutes — adoptMcpTokenRevoke seam (#1554 task #6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a revoke function that forwards to the wiring closure's SessionTokenRegistry when wiring is present", () => {
    const revokeBySessionId = vi.spyOn(SessionTokenRegistry.prototype, "revokeBySessionId");
    const server = Fastify();
    const adoptMcpTokenRevoke = vi.fn();

    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never,
      resolveActiveModules: async () => [],
      mcpServerUrl: "http://mcp.example.test/api/mcp",
      adoptMcpTokenRevoke
    });

    expect(adoptMcpTokenRevoke).toHaveBeenCalledTimes(1);
    const revoke = adoptMcpTokenRevoke.mock.calls[0]![0] as (chatSessionId: string) => void;

    revoke("chat-session-1");

    expect(revokeBySessionId).toHaveBeenCalledTimes(1);
    expect(revokeBySessionId).toHaveBeenCalledWith("chat-session-1");
  });

  it("never calls adoptMcpTokenRevoke when no gateway is wired (resolveActiveModules/mcpServerUrl absent)", () => {
    const server = Fastify();
    const adoptMcpTokenRevoke = vi.fn();

    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never,
      adoptMcpTokenRevoke
    });

    expect(adoptMcpTokenRevoke).not.toHaveBeenCalled();
  });
});
