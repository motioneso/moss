/**
 * Task 4.1 (#2901) — the REAL composition-root gate wiring, driven through `registerChatRoutes`.
 * QA round 2 blocker: an earlier cut rebuilt the mint/revoke by hand, so the setup code in
 * `routes.ts` had no test at all.
 *
 * This stands up the real routes (gateway wired, so the gate seam is built), captures the runner the
 * wiring closure produced through the `adoptClassifierGate` seam, and drives it against the REAL
 * `SessionTokenRegistry` that `registerChatRoutes` creates (observed via prototype spies, the same
 * approach as `chat-routes-mcp-token-revoke-adopt.test.ts`). It asserts:
 *   - one mint and one matching revoke on decline and on cancellation;
 *   - the minted token has an empty allowlist, a one-minute TTL and a FIXED expiry.
 *
 * Observed red when the `routes.ts` revoke call is removed (see commit message), then restored.
 * The thrown-evaluate revoke path is covered by the runner's own unit test.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { SessionTokenRegistry, InvalidSessionTokenError } from "@moss/ai";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";
import {
  GATE_TOKEN_TTL_MS,
  buildClassifierGateRunner,
  type ClassifierGateRunner
} from "../../packages/chat/src/live/classifier-gate-runner.js";
import type { GateMode } from "../../packages/chat/src/live/classifier-gate.js";

const ACTOR = "11111111-1111-1111-1111-111111111111";

/** Stand up the real chat routes with a gateway wired and capture the gate runner they build. */
function routedGate(): {
  runner: ClassifierGateRunner;
  mint: MockInstance;
  revoke: MockInstance;
} {
  const mint = vi.spyOn(SessionTokenRegistry.prototype, "mint");
  const revoke = vi.spyOn(SessionTokenRegistry.prototype, "revokeBySessionId");
  const captured: { runner?: ClassifierGateRunner } = {};

  const server = Fastify();
  registerChatRoutes(server, {
    rootDb: {} as never,
    dataContext: {} as never,
    resolveAccessContext: async () => ({ actorUserId: ACTOR, requestId: "req-1" }),
    chatEngineFactory: (() => {
      throw new Error("no engine may launch while the gate has no ports");
    }) as never,
    resolveActiveModules: async () => [],
    mcpServerUrl: "http://mcp.example.test/api/mcp",
    adoptClassifierGate: (runner) => {
      captured.runner = runner;
    }
  });

  if (!captured.runner)
    throw new Error("registerChatRoutes did not build a classifier gate runner");
  return { runner: captured.runner, mint, revoke };
}

const REQUEST = {
  actorUserId: ACTOR,
  message: "hi",
  hasAttachment: false,
  incognito: false,
  mode: "on" as GateMode
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifier gate wiring through registerChatRoutes (#2901)", () => {
  it("mints one token per attempt and revokes the matching session id on decline and cancel", async () => {
    const { runner, mint, revoke } = routedGate();

    const declined = await runner.evaluate(REQUEST);
    // The exact reason depends on the injected ports; this test is about the token lifecycle.
    expect(declined.kind).toBe("declined");

    const cancelled = new AbortController();
    cancelled.abort();
    await runner.evaluate({ ...REQUEST, signal: cancelled.signal });

    // Two attempts ⇒ two mints, two revokes, each revoke matching its own minted session id.
    expect(mint).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    const mintedSessionIds = mint.mock.calls.map((call) => call[0].chatSessionId);
    const revokedSessionIds = revoke.mock.calls.map((call) => call[0]);
    expect(revokedSessionIds).toEqual(mintedSessionIds);
    expect(mintedSessionIds.every((id) => id.startsWith("classifier-gate:"))).toBe(true);
  });

  it("applies the tool limit (empty allowlist), the short TTL and fixed expiry", async () => {
    const { runner, mint } = routedGate();

    await runner.evaluate(REQUEST);

    expect(mint).toHaveBeenCalledTimes(1);
    const [identity, options] = mint.mock.calls[0]!;
    expect(identity.allowedToolNames).not.toBeNull();
    expect(identity.allowedToolNames?.size).toBe(0);
    expect(options?.ttlMs).toBe(GATE_TOKEN_TTL_MS);
    expect(options?.fixedExpiry).toBe(true);
  });

  it("a used gate token still dies after one minute (fixed expiry, not sliding)", async () => {
    // The production builder mints through a wrapped registry so we can hold the real token it made
    // (its revoke is swallowed). Without `fixedExpiry`, the first `verify` slides the expiry out to
    // the registry's 60-minute default and the lifetime assertion below goes red.
    let now = 0;
    const registry = new SessionTokenRegistry({ clock: { now: () => now } });
    let mintedToken = "";
    let mintedOptions: unknown;

    const runner = buildClassifierGateRunner({
      readMode: async () => "on",
      tokens: {
        mint: (identity, options) => {
          mintedOptions = options;
          mintedToken = registry.mint(identity, options);
          return mintedToken;
        },
        // Swallow the revoke so the token's own expiry is what we observe.
        revokeBySessionId: () => undefined
      },
      now: () => now
    });

    await runner.evaluate(REQUEST);
    expect(mintedToken.startsWith("jst_")).toBe(true);
    expect(mintedOptions).toMatchObject({ ttlMs: GATE_TOKEN_TTL_MS, fixedExpiry: true });

    // Use the real minted token once at 30 seconds: verify() must NOT extend a fixed-expiry token.
    now = 30_000;
    expect(registry.verify(mintedToken).chatSessionId).toMatch(/^classifier-gate:/);

    // Past one minute, the token is dead even though it was used.
    now = 61_000;
    expect(() => registry.verify(mintedToken)).toThrow(InvalidSessionTokenError);
  });
});
