import { describe, expect, it } from "vitest";

import {
  REGISTRY_LIMITS,
  VisualTurnRegistry,
  type VisualSnapshotInput,
  type VisualTurnIdentity
} from "../packages/chat/src/visual/turn-registry.js";

const identity: VisualTurnIdentity = { actorUserId: "u1", threadId: "t1", turnId: "n1" };

function input(fields: Record<string, unknown> = { rows: [1, 2] }): VisualSnapshotInput {
  return {
    kind: "example.facts",
    origin: "example",
    source: { id: "user-supplied", label: "Your data" },
    retrievedAt: "2026-10-23T10:00:00.000Z",
    coverage: "All supplied rows",
    fields
  } as VisualSnapshotInput;
}

function proposal(refs: string[]) {
  return {
    catalogVersion: "moss.v1",
    blocks: [{ kind: "composition", snapshotRefs: refs, program: "root = A()" }],
    interactions: [
      { blockIndex: 0, kind: "follow_up", label: "More", descriptorId: "d", params: {} }
    ]
  };
}

function open() {
  const registry = new VisualTurnRegistry(identity);
  const ref = registry.register(identity, input());
  if (!ref.ok) throw new Error("register failed");
  return { registry, ref: ref.ref };
}

describe("VisualTurnRegistry", () => {
  it("finalizes a reply with host-minted ids and only referenced snapshots", () => {
    const { registry, ref } = open();
    registry.register(identity, input({ other: true }));
    const result = registry.finalize(identity, proposal([ref]), "Readable text");
    if (!result.ok) throw new Error(result.code);
    expect(result.reply.snapshots.map((s) => s.ref)).toEqual([ref]);
    expect(result.reply.blocks[0]!.blockId).toMatch(/^b_/);
    expect(result.reply.interactions[0]!.blockId).toBe(result.reply.blocks[0]!.blockId);
    expect(result.reply.fallbackText).toBe("Readable text");
  });

  it("rejects forged references and keeps the fallback text", () => {
    const { registry } = open();
    const result = registry.finalize(identity, proposal(["vs_forged"]), "Readable text");
    expect(result).toEqual({ ok: false, code: "unknown_reference", fallbackText: "Readable text" });
  });

  it("rejects a reference issued by another registry", () => {
    const { ref } = open();
    const other = new VisualTurnRegistry({ ...identity, turnId: "n2" });
    const otherIdentity = { ...identity, turnId: "n2" };
    const result = other.finalize(otherIdentity, proposal([ref]), "x");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("unknown_reference");
  });

  it.each([
    ["actor", { actorUserId: "u2" }],
    ["thread", { threadId: "t2" }],
    ["turn", { turnId: "n2" }]
  ])("rejects a mismatched %s on every method", (_label, change) => {
    const { registry, ref } = open();
    const wrong = { ...identity, ...change };
    expect(registry.register(wrong, input())).toEqual({ ok: false, code: "foreign_context" });
    const finalized = registry.finalize(wrong, proposal([ref]), "x");
    expect(!finalized.ok && finalized.code).toBe("foreign_context");
    registry.close(wrong);
    registry.discard(wrong);
    expect(registry.state).toBe("open");
    expect(registry.finalize(identity, proposal([ref]), "x").ok).toBe(true);
  });

  it("rejects all use after close", () => {
    const { registry, ref } = open();
    registry.close(identity);
    expect(registry.state).toBe("closed");
    expect(registry.register(identity, input())).toEqual({ ok: false, code: "closed" });
    const result = registry.finalize(identity, proposal([ref]), "x");
    expect(!result.ok && result.code).toBe("closed");
  });

  it("drops pending snapshots on discard", () => {
    const { registry, ref } = open();
    registry.discard(identity);
    expect(registry.state).toBe("discarded");
    const result = registry.finalize(identity, proposal([ref]), "x");
    expect(!result.ok && result.code).toBe("closed");
  });

  it("copies input so later caller mutation cannot change the snapshot", () => {
    const registry = new VisualTurnRegistry(identity);
    const fields = { rows: [1] };
    const ref = registry.register(identity, input(fields));
    if (!ref.ok) throw new Error("register failed");
    fields.rows.push(2);
    const result = registry.finalize(identity, proposal([ref.ref]), "x");
    if (!result.ok) throw new Error(result.code);
    expect(result.reply.snapshots[0]!.fields).toEqual({ rows: [1] });
  });

  it("freezes snapshots and replies", () => {
    const { registry, ref } = open();
    const result = registry.finalize(identity, proposal([ref]), "x");
    if (!result.ok) throw new Error(result.code);
    expect(Object.isFrozen(result.reply)).toBe(true);
    expect(Object.isFrozen(result.reply.snapshots[0]!.fields)).toBe(true);
    expect(() => {
      (result.reply.snapshots[0]!.fields as { rows: unknown[] }).rows.push(9);
    }).toThrow();
  });

  it("rejects extra snapshot properties instead of serializing them", () => {
    const registry = new VisualTurnRegistry(identity);
    const result = registry.register(identity, {
      ...input(),
      token: "secret"
    } as VisualSnapshotInput);
    expect(result).toEqual({ ok: false, code: "malformed" });
  });

  it("rejects malformed and oversized snapshots", () => {
    const registry = new VisualTurnRegistry(identity);
    expect(registry.register(identity, input({ n: Number.NaN }))).toEqual({
      ok: false,
      code: "not_serializable"
    });
    const wide = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`k${i}`, "x".repeat(500)])
    );
    expect(registry.register(identity, input(wide))).toEqual({ ok: false, code: "limit_exceeded" });
  });

  it("caps snapshot count and total bytes", () => {
    const registry = new VisualTurnRegistry(identity);
    for (let i = 0; i < REGISTRY_LIMITS.snapshots; i++) {
      expect(registry.register(identity, input({ i })).ok).toBe(true);
    }
    expect(registry.register(identity, input())).toEqual({ ok: false, code: "registry_full" });

    const heavy = new VisualTurnRegistry(identity);
    const chunk = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, "y".repeat(480)])
    );
    const results = Array.from({ length: 16 }, () => heavy.register(identity, input(chunk)));
    expect(results.filter((r) => r.ok).length).toBeLessThan(16);
    expect(results.some((r) => !r.ok && r.code === "registry_full")).toBe(true);
  });

  it("returns shape failures from the proposal with the fallback text", () => {
    const { registry } = open();
    const result = registry.finalize(identity, { catalogVersion: "moss.v1", blocks: [] }, "text");
    expect(result).toEqual({ ok: false, code: "malformed", fallbackText: "text" });
  });
});
