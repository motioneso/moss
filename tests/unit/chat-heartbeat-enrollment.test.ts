import { describe, expect, it } from "vitest";

import { seedFromLegacyProactiveChoice } from "../../packages/chat/src/heartbeat/enrollment.js";
import { parseHeartbeatSources } from "../../packages/chat/src/heartbeat/settings-repository.js";

describe("seedFromLegacyProactiveChoice", () => {
  it("defaults to on with every source when nothing valid is saved", () => {
    for (const raw of [null, undefined, "x", { version: 2, enabled: false }, { version: 1 }]) {
      expect(seedFromLegacyProactiveChoice(raw)).toMatchObject({
        enabled: true,
        origin: "default"
      });
    }
  });

  it("starts off when the saved choice is an explicit master off", () => {
    expect(seedFromLegacyProactiveChoice({ version: 1, enabled: false })).toMatchObject({
      enabled: false,
      origin: "legacy_off"
    });
  });

  it("carries per-source opt-outs across to the matching check-in sources", () => {
    const seed = seedFromLegacyProactiveChoice({
      version: 1,
      enabled: true,
      sources: { tasks: { enabled: false }, notes: { enabled: false }, calendar: { enabled: true } }
    });
    expect(seed.sources).toEqual({
      calendar: true,
      tasks: false,
      memory: false,
      sports: true,
      news: true
    });
  });
});

describe("parseHeartbeatSources", () => {
  const all = { calendar: true, tasks: true, memory: true, sports: true, news: true };

  it("accepts all five boolean sources", () => {
    expect(parseHeartbeatSources(all)).toEqual(all);
  });

  it("rejects a missing, extra or non-boolean source", () => {
    expect(parseHeartbeatSources({ ...all, news: undefined })).toBeNull();
    expect(parseHeartbeatSources({ ...all, news: "yes" })).toBeNull();
    expect(parseHeartbeatSources(null)).toBeNull();
  });
});
