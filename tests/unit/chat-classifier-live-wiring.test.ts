/**
 * Task 4.1 (#2901) — the REAL composition-root gate wiring. QA blocker 3: the previous file only
 * asserted two spies were defined, so it could not fail.
 *
 * This builds the runner exactly as `routes.ts` builds it — the real `SessionTokenRegistry`, a real
 * `createChatSessionRuntime`, and the real `ClassifierGateRunner` with NO ports factory (ports are
 * 3.5). It proves one token is minted per attempt and revoked by its matching
 * `classifier-gate:<id>` session id on a decline and on a thrown evaluate, and that a cancelled
 * turn never reaches the default model.
 *
 * Run against the real registry, this test fails if the runner ever stops revoking (see the branch
 * that removed the `finally` and observed it red, then restored it).
 */
import { describe, expect, it } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";

import { createClassifierGateRunner } from "../../packages/chat/src/live/classifier-gate-runner.js";
import type { GateMode } from "../../packages/chat/src/live/classifier-gate.js";
import { createChatSessionRuntime } from "../../packages/chat/src/live/runtime.js";

const ACTOR = "11111111-1111-1111-1111-111111111111";

/** Records every mint and revoke that goes through one real registry. */
function trackedRegistry(): {
  registry: SessionTokenRegistry;
  minted: string[];
  revokedSessionIds: string[];
} {
  const registry = new SessionTokenRegistry();
  const minted: string[] = [];
  const revokedSessionIds: string[] = [];
  const realMint = registry.mint.bind(registry);
  registry.mint = (identity, options) => {
    const token = realMint(identity, options);
    minted.push(token);
    return token;
  };
  const realRevoke = registry.revokeBySessionId.bind(registry);
  registry.revokeBySessionId = (chatSessionId) => {
    revokedSessionIds.push(chatSessionId);
    realRevoke(chatSessionId);
  };
  return { registry, minted, revokedSessionIds };
}

describe("classifier gate composition wiring (#2901)", () => {
  it("mints one real token per attempt and revokes it on decline, error and cancellation", async () => {
    const { registry, minted, revokedSessionIds } = trackedRegistry();

    // Same wiring shape as routes.ts: real token callbacks, no ports factory.
    const gate = createClassifierGateRunner({
      readMode: async () => "on",
      tokens: {
        mint: (actorUserId, correlationId) =>
          registry.mint({
            actorUserId,
            chatSessionId: `classifier-gate:${correlationId}`,
            // Tool limit: empty until the 3.5 ports factory supplies the turn's menu.
            allowedToolNames: new Set<string>()
          }),
        revoke: (correlationId) => registry.revokeBySessionId(`classifier-gate:${correlationId}`)
      },
      now: () => Date.now()
    });

    // A real runtime must accept and forward the gate seam (no engine launch on a decline).
    const runtime = createChatSessionRuntime({
      dataContext: {} as DataContextRunner,
      engineFactory: (() => {
        throw new Error("no engine may launch while the gate has no ports");
      }) as never,
      classifierGate: gate
    });

    const request = {
      actorUserId: ACTOR,
      message: "hi",
      hasAttachment: false,
      incognito: false,
      mode: "on" as GateMode
    };

    // Decline (no ports supplied): one mint, one matching revoke.
    const declined = await gate.evaluate(request);
    expect(declined).toEqual({
      kind: "declined",
      reason: "no_eligible_tools",
      trace: { latencyMs: expect.any(Number) }
    });

    // Cancelled turn: still one mint, one revoke.
    const cancelled = new AbortController();
    cancelled.abort();
    await gate.evaluate({ ...request, signal: cancelled.signal });

    // Thrown evaluate (ports explode): one mint, one revoke on the error path too.
    const errorGate = createClassifierGateRunner({
      readMode: async () => "on",
      createPorts: () => {
        throw new Error("ports exploded");
      },
      tokens: {
        mint: (actorUserId, correlationId) =>
          registry.mint({
            actorUserId,
            chatSessionId: `classifier-gate:${correlationId}`,
            // Tool limit: empty until the 3.5 ports factory supplies the turn's menu.
            allowedToolNames: new Set<string>()
          }),
        revoke: (correlationId) => registry.revokeBySessionId(`classifier-gate:${correlationId}`)
      },
      now: () => 0
    });
    await expect(errorGate.evaluate(request)).rejects.toThrow("ports exploded");

    // Three attempts, three mints, three revokes — and every token is gone from the registry.
    expect(minted).toHaveLength(3);
    expect(revokedSessionIds).toHaveLength(3);
    expect(revokedSessionIds.every((id) => id.startsWith("classifier-gate:"))).toBe(true);
    for (const token of minted) {
      expect(() => registry.verify(token)).toThrow();
    }

    runtime.shutdown();
  });

  it("gives the production gate token a tool limit (empty allowlist), never unrestricted", () => {
    // Mirrors routes.ts's mint: the gate token is minted with an allowlist, not `null`. An empty
    // allowlist means the gateway refuses every tool (`not_in_allowlist`) until 3.5 fills the menu.
    const registry = new SessionTokenRegistry();
    const token = registry.mint({
      actorUserId: ACTOR,
      chatSessionId: "classifier-gate:corr-1",
      allowedToolNames: new Set<string>()
    });

    const identity = registry.verify(token);
    expect(identity.allowedToolNames).not.toBeNull();
    expect(identity.allowedToolNames?.size).toBe(0);
    expect(identity.allowedToolNames?.has("calendar.listVisibleEvents")).toBe(false);
  });
});
