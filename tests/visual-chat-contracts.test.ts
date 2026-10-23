import { describe, expect, it } from "vitest";

import {
  VISUAL_LIMITS,
  validateVisualProposal,
  validateVisualReply,
  type VisualReplyV1
} from "../packages/shared/src/visual-chat.js";

function snapshot(ref = "vs_one") {
  return {
    ref,
    kind: "example.facts",
    origin: "example" as const,
    source: { id: "user-supplied", label: "Your data" },
    retrievedAt: "2026-10-23T10:00:00.000Z",
    coverage: "All supplied rows",
    fields: { rows: [{ name: "A", hours: 2 }] }
  };
}

function reply(overrides: Record<string, unknown> = {}): VisualReplyV1 {
  return {
    version: 1,
    catalogVersion: "moss.v1",
    blocks: [
      { blockId: "b1", kind: "composition", snapshotRefs: ["vs_one"], program: "root = A()" }
    ],
    snapshots: [snapshot()],
    interactions: [],
    fallbackText: "A gets 2 hours.",
    ...overrides
  } as VisualReplyV1;
}

function failure(value: unknown) {
  const result = validateVisualReply(value);
  if (result.ok) throw new Error("expected failure");
  return result;
}

describe("validateVisualReply", () => {
  it("accepts a valid reply and survives a JSON round trip", () => {
    const result = validateVisualReply(JSON.parse(JSON.stringify(reply())));
    expect(result).toEqual({ ok: true, reply: reply() });
  });

  it("rejects duplicate interaction IDs while accepting distinct IDs", () => {
    const interaction = {
      interactionId: "i1",
      blockId: "b1",
      kind: "follow_up",
      label: "Explain",
      descriptorId: "explain",
      params: {}
    };
    const other = { ...interaction, descriptorId: "compare", params: { mode: "other" } };
    expect(
      validateVisualReply(reply({ interactions: [interaction, { ...other, interactionId: "i2" }] }))
        .ok
    ).toBe(true);
    expect(failure(reply({ interactions: [interaction, other] })).code).toBe("malformed");
  });

  it("returns unsupported_version but keeps the readable text", () => {
    const result = failure(reply({ version: 2 }));
    expect(result.code).toBe("unsupported_version");
    expect(result.fallbackText).toBe("A gets 2 hours.");
  });

  it("returns no fallback text when the text itself is unusable", () => {
    expect(failure(reply({ version: 2, fallbackText: "x".repeat(5000) })).fallbackText).toBeNull();
    expect(failure("nope").code).toBe("not_object");
  });

  it("rejects an oversized envelope", () => {
    const big = reply({ fallbackText: "x".repeat(VISUAL_LIMITS.envelopeBytes) });
    expect(failure(big).code).toBe("too_large");
  });

  it("rejects values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [cyclic, Number.NaN, undefined, new Date(), new Map()]) {
      const result = validateVisualReply(
        reply({ snapshots: [{ ...snapshot(), fields: { bad } }] })
      );
      expect(result.ok).toBe(false);
    }
    expect(failure(reply({ snapshots: [{ ...snapshot(), fields: { n: Infinity } }] })).code).toBe(
      "not_serializable"
    );
  });

  it.each([
    [
      "too many blocks",
      {
        blocks: Array.from({ length: 4 }, (_, i) => ({
          blockId: `b${i}`,
          kind: "t",
          snapshotRefs: ["vs_one"]
        }))
      }
    ],
    [
      "too many interactions",
      {
        interactions: Array.from({ length: 7 }, (_, i) => ({
          interactionId: `i${i}`,
          blockId: "b1",
          kind: "follow_up",
          label: "x",
          descriptorId: "d",
          params: {}
        }))
      }
    ],
    ["too many snapshots", { snapshots: Array.from({ length: 9 }, (_, i) => snapshot(`vs_${i}`)) }],
    ["array too long", { snapshots: [{ ...snapshot(), fields: { a: new Array(25).fill(1) } }] }],
    ["too deep", { snapshots: [{ ...snapshot(), fields: { a: { b: { c: { d: { e: 1 } } } } } }] }],
    ["string too long", { snapshots: [{ ...snapshot(), coverage: "x".repeat(501) }] }],
    [
      "program too long",
      {
        blocks: [
          {
            blockId: "b1",
            kind: "composition",
            snapshotRefs: ["vs_one"],
            program: "x".repeat(16 * 1024 + 1)
          }
        ]
      }
    ]
  ])("rejects %s", (_label, overrides) => {
    expect(failure(reply(overrides)).code).toBe("limit_exceeded");
  });

  it("accepts values at the limits", () => {
    const edge = { a: new Array(24).fill(1), b: { c: { d: "x".repeat(500) } } };
    expect(validateVisualReply(reply({ snapshots: [{ ...snapshot(), fields: edge }] })).ok).toBe(
      true
    );
  });

  it("rejects unknown keys at every level", () => {
    expect(failure({ ...reply(), extra: 1 }).code).toBe("malformed");
    expect(failure(reply({ snapshots: [{ ...snapshot(), token: "secret" }] })).code).toBe(
      "malformed"
    );
    expect(
      failure(reply({ blocks: [{ blockId: "b1", kind: "t", snapshotRefs: ["vs_one"], url: "x" }] }))
        .code
    ).toBe("malformed");
  });

  it("rejects dangling block and interaction references", () => {
    expect(
      failure(reply({ blocks: [{ blockId: "b1", kind: "t", snapshotRefs: ["vs_missing"] }] })).code
    ).toBe("dangling_reference");
    const interaction = {
      interactionId: "i1",
      blockId: "nope",
      kind: "follow_up",
      label: "x",
      descriptorId: "d",
      params: {}
    };
    expect(failure(reply({ interactions: [interaction] })).code).toBe("dangling_reference");
    expect(
      failure(
        reply({ interactions: [{ ...interaction, blockId: "b1", snapshotRef: "vs_missing" }] })
      ).code
    ).toBe("dangling_reference");
  });

  it("allows a program only on compositions and requires it there", () => {
    expect(
      failure(
        reply({
          blocks: [{ blockId: "b1", kind: "template", snapshotRefs: ["vs_one"], program: "x" }]
        })
      ).code
    ).toBe("malformed");
    expect(
      failure(reply({ blocks: [{ blockId: "b1", kind: "composition", snapshotRefs: ["vs_one"] }] }))
        .code
    ).toBe("malformed");
  });

  it("does not alias the caller's objects", () => {
    const input = reply();
    const result = validateVisualReply(input);
    if (!result.ok) throw new Error("expected ok");
    (input.snapshots[0]!.fields.rows as unknown[]).push("changed");
    expect(result.reply.snapshots[0]!.fields.rows).toHaveLength(1);
  });
});

describe("validateVisualProposal", () => {
  const proposal = {
    catalogVersion: "moss.v1",
    blocks: [{ kind: "composition", snapshotRefs: ["vs_one"], program: "root = A()" }],
    interactions: [
      { blockIndex: 0, kind: "follow_up", label: "More", descriptorId: "d", params: { n: 1 } }
    ]
  };

  it("accepts a well-formed proposal", () => {
    expect(validateVisualProposal(proposal).ok).toBe(true);
  });

  it("rejects model-supplied ids, snapshots and fallback text", () => {
    for (const extra of [{ snapshots: [] }, { fallbackText: "hi" }, { version: 1 }]) {
      expect(validateVisualProposal({ ...proposal, ...extra }).ok).toBe(false);
    }
    const withId = { ...proposal, blocks: [{ ...proposal.blocks[0], blockId: "mine" }] };
    expect(validateVisualProposal(withId).ok).toBe(false);
  });

  it("rejects an interaction pointing at a missing block or carrying a URL-like key", () => {
    const missing = { ...proposal, interactions: [{ ...proposal.interactions[0], blockIndex: 3 }] };
    expect(validateVisualProposal(missing)).toEqual({ ok: false, code: "dangling_reference" });
    const url = { ...proposal, interactions: [{ ...proposal.interactions[0], url: "https://x" }] };
    expect(validateVisualProposal(url).ok).toBe(false);
  });
});
