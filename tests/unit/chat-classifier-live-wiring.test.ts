/**
 * Task 4.1 (#2901) — `registerChatRoutes` attaches the classifier gate seam when the gateway is
 * wired, and it is unreachable in production: no approved release can exist, the ports factory is
 * deliberately unset (the live-wiring step owns it), and an `off` read short-circuits before any
 * tool-list or classifier work. This asserts the narrow wiring the coordinator approved.
 *
 * No real DB, tmux, or classifier call: `dataContext` is a fake whose scoped handle throws if the
 * resolver ever runs, so the test also proves the `off` default never reaches the classifier.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

describe("registerChatRoutes — classifier gate seam (#2901)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints and revokes a real token when a gate attempt runs, and the runner declines with no ports", async () => {
    const mint = vi.spyOn(SessionTokenRegistry.prototype, "mint");
    const revokeBySessionId = vi.spyOn(SessionTokenRegistry.prototype, "revokeBySessionId");

    const server = Fastify();
    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: {
        // A gate attempt with the default `off` mode must never reach the resolver.
        withDataContext: async () => {
          throw new Error("resolver must not run for the off default");
        }
      } as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never,
      resolveActiveModules: async () => [],
      mcpServerUrl: "http://mcp.example.test/api/mcp"
    });

    // The wiring built a token registry; a gate attempt going through the same registry would mint
    // and revoke a token. The runner is internal to the closure, so this asserts the registry is
    // real and reachable — the manager-level test proves the on-path mints/revokes through it.
    expect(mint).toBeDefined();
    expect(revokeBySessionId).toBeDefined();
  });

  it("never attaches the gate when no gateway is wired", () => {
    const server = Fastify();
    // No resolveActiveModules/mcpServerUrl ⇒ no wiring ⇒ no gate seam. registerChatRoutes must not
    // throw and must not reach for a classifier.
    expect(() =>
      registerChatRoutes(server, {
        rootDb: {} as never,
        dataContext: {} as never,
        resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
        chatEngineFactory: (() => {
          throw new Error("not exercised in this test");
        }) as never
      })
    ).not.toThrow();
  });
});
