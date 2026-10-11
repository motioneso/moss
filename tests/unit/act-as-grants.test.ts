import { describe, expect, it } from "vitest";

import { ACT_AS_GRANT_TTL_MS, createActAsGrantRegistry, type ActAsBinding } from "@moss/auth";

const binding: ActAsBinding = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  chatSessionId: "chat-session-a",
  turnId: "turn-1"
};

describe("act-as grant registry (#3065)", () => {
  it("is single use", () => {
    const grants = createActAsGrantRegistry();
    const value = grants.mint(binding);

    expect(grants.consume(value)).toEqual(binding);
    expect(grants.consume(value)).toBeNull();
  });

  it("expires 30 s after minting", () => {
    let now = 1_000_000;
    const grants = createActAsGrantRegistry(() => now);
    const early = grants.mint(binding);
    const late = grants.mint(binding);

    now += ACT_AS_GRANT_TTL_MS - 1;
    expect(grants.consume(early)).toEqual(binding);

    now += 1;
    expect(ACT_AS_GRANT_TTL_MS).toBe(30_000);
    expect(grants.peekActor(late)).toBeNull();
    expect(grants.consume(late)).toBeNull();
  });

  it("peekActor reads the actor without consuming the grant", () => {
    const grants = createActAsGrantRegistry();
    const value = grants.mint(binding);

    expect(grants.peekActor(value)).toBe(binding.actorUserId);
    expect(grants.peekActor(value)).toBe(binding.actorUserId);
    expect(grants.consume(value)).toEqual(binding);
    expect(grants.peekActor(value)).toBeNull();
  });

  it("mints a distinct 256-bit base64url value each time", () => {
    const grants = createActAsGrantRegistry();
    const values = new Set(Array.from({ length: 50 }, () => grants.mint(binding)));

    expect(values.size).toBe(50);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("refuses a value it never minted", () => {
    const grants = createActAsGrantRegistry();
    grants.mint(binding);

    expect(grants.peekActor("made-up")).toBeNull();
    expect(grants.consume("made-up")).toBeNull();
  });
});
