import { describe, expect, it } from "vitest";

import { MODULE_WORKER_SERVICE_KEY, isModuleServiceKey } from "@moss/shared";
import { parseModuleServiceBindingMap } from "../../packages/ai/src/service-binding-map.js";

describe("isModuleServiceKey", () => {
  it("accepts module.worker and module.<id> keys", () => {
    expect(isModuleServiceKey(MODULE_WORKER_SERVICE_KEY)).toBe(true);
    expect(isModuleServiceKey("module.demo-module")).toBe(true);
    expect(isModuleServiceKey("module.notes_2.beta")).toBe(true);
  });

  it("rejects capabilities, malformed ids, and near-misses", () => {
    expect(isModuleServiceKey("chat")).toBe(false);
    expect(isModuleServiceKey("json")).toBe(false);
    expect(isModuleServiceKey("module.")).toBe(false);
    expect(isModuleServiceKey("module.UPPER")).toBe(false);
    expect(isModuleServiceKey("module.-dash-first")).toBe(false);
    expect(isModuleServiceKey(`module.a${"b".repeat(64)}`)).toBe(false);
    expect(isModuleServiceKey("modules.worker")).toBe(false);
    expect(isModuleServiceKey("MODULE.worker")).toBe(false);
  });
});

describe("parseModuleServiceBindingMap", () => {
  it("migrates the legacy Workshop key in reads while preserving an explicit new choice", () => {
    const legacy = { kind: "mode", tier: "reasoning" };
    expect(parseModuleServiceBindingMap({ "module.moss.workshop-build-plan": legacy })).toEqual({
      "module.workshop.plan": legacy
    });
    const explicit = { kind: "mode", tier: "interactive" };
    expect(
      parseModuleServiceBindingMap({
        "module.moss.workshop-build-plan": legacy,
        "module.workshop.plan": explicit
      })
    ).toEqual({ "module.workshop.plan": explicit });
  });

  it("keeps validated module.* keys and drops capabilities, junk keys, and malformed bindings", () => {
    const parsed = parseModuleServiceBindingMap({
      chat: { kind: "mode", tier: "reasoning" },
      "module.worker": { kind: "mode", tier: "economy" },
      "module.demo-module": {
        kind: "model",
        modelId: "11111111-1111-4111-8111-111111111111"
      },
      "module.bad-tier": { kind: "mode", tier: "warp" },
      "module.bad-shape": "nope",
      "not-a-key": { kind: "mode", tier: "economy" }
    });

    expect(parsed).toEqual({
      "module.worker": { kind: "mode", tier: "economy" },
      "module.demo-module": {
        kind: "model",
        modelId: "11111111-1111-4111-8111-111111111111"
      }
    });
  });

  it("returns {} for non-object blobs", () => {
    expect(parseModuleServiceBindingMap(null)).toEqual({});
    expect(parseModuleServiceBindingMap(undefined)).toEqual({});
    expect(parseModuleServiceBindingMap([{ chat: {} }])).toEqual({});
    expect(parseModuleServiceBindingMap("garbage")).toEqual({});
  });
});
