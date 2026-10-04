import { describe, expect, it } from "vitest";

import {
  classifierPreparationView,
  effectiveClassifierTools,
  emptyPreparationMap,
  emptySortMap,
  preparationFailure,
  toolRiskInputs,
  toolSortFingerprint,
  withSortResult,
  type ClassifierSortMap,
  INTEGRATION_CLASSIFIER_MAX_ENTRIES,
  parsePreparationMap,
  parseReviewedEntry,
  toolDefinitionFingerprint,
  withPreparationEntry,
  type ClassifierPreparationEntry,
  type ClassifierPreparationMap
} from "@moss/integrations";
import type { IntegrationClassifierRisk, IntegrationToolDescriptor } from "@moss/shared";

function tool(overrides: Partial<IntegrationToolDescriptor> = {}): IntegrationToolDescriptor {
  return {
    name: "turn_on",
    description: "Turn a light on",
    group: "lights",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    ...overrides
  };
}

function entry(
  fingerprint: string,
  overrides: Partial<ClassifierPreparationEntry> = {}
): ClassifierPreparationEntry {
  return {
    optIn: true,
    reviewedRisk: "write",
    description: "Turn one light on",
    arguments: {},
    replyTemplate: "Turned {name} on.",
    definitionFingerprint: fingerprint,
    reviewedAt: "2026-10-01T00:00:00.000Z",
    preparationVersion: 1,
    ...overrides
  };
}

function mapWith(toolName: string, value: ClassifierPreparationEntry): ClassifierPreparationMap {
  return { version: 1, entries: { [toolName]: value } };
}

/** A current sort of `risk` for each tool, made against its present risk inputs. */
function sortedAs(
  tools: readonly IntegrationToolDescriptor[],
  risk: IntegrationClassifierRisk = "write"
): ClassifierSortMap {
  let map = emptySortMap();
  for (const t of tools) {
    map = withSortResult(map, t.name, {
      status: "current",
      risk,
      readableName: "Turn on",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
  }
  return map;
}

function state(
  overrides: {
    enabled?: boolean;
    classifierEnabled?: boolean;
    lastError?: string | null;
    discoveredTools?: readonly IntegrationToolDescriptor[];
    enabledGroups?: readonly string[];
    enabledTools?: readonly string[];
    mutedTools?: readonly string[];
    classifierPreparation?: ClassifierPreparationMap;
    classifierSort?: ClassifierSortMap;
    classifierKeptOutTools?: readonly string[];
  } = {}
) {
  const discoveredTools = overrides.discoveredTools ?? [tool()];
  return {
    enabled: overrides.enabled ?? true,
    classifierEnabled: overrides.classifierEnabled ?? true,
    lastError: overrides.lastError ?? null,
    discoveredTools,
    enabledGroups: overrides.enabledGroups ?? [],
    enabledTools: overrides.enabledTools ?? [],
    mutedTools: overrides.mutedTools ?? [],
    classifierPreparation: overrides.classifierPreparation ?? emptyPreparationMap(),
    classifierSort: overrides.classifierSort ?? sortedAs(discoveredTools),
    classifierKeptOutTools: overrides.classifierKeptOutTools ?? []
  };
}

describe("classifier tool definition fingerprint", () => {
  it("is stable when object keys are reordered but the definition is the same", () => {
    const a = tool({ inputSchema: { type: "object", properties: { name: { type: "string" } } } });
    const b = tool({ inputSchema: { properties: { name: { type: "string" } }, type: "object" } });
    expect(toolDefinitionFingerprint(a)).toBe(toolDefinitionFingerprint(b));
  });

  it("changes when a definition field or a relevant annotation changes", () => {
    const base = toolDefinitionFingerprint(tool());
    expect(toolDefinitionFingerprint(tool({ description: "Turn a lamp on" }))).not.toBe(base);
    expect(toolDefinitionFingerprint(tool({ group: "switches" }))).not.toBe(base);
    expect(toolDefinitionFingerprint(tool({ readOnly: true }))).not.toBe(base);
    expect(toolDefinitionFingerprint(tool({ idempotent: true }))).not.toBe(base);
    expect(toolDefinitionFingerprint(tool({ destructive: true }))).not.toBe(base);
  });

  it("keeps an absent hint distinct from an explicit false", () => {
    expect(toolDefinitionFingerprint(tool())).not.toBe(
      toolDefinitionFingerprint(tool({ readOnly: false }))
    );
  });
});

describe("reviewed entry validation", () => {
  const valid = {
    optIn: true,
    reviewedRisk: "write",
    description: "Turn one light on",
    arguments: { name: { kind: "candidates", candidateSource: "lights" } },
    replyTemplate: "Turned {name} on.",
    reviewedFingerprint: "sha256:abc"
  };

  it("accepts a clean entry and defaults a null risk", () => {
    const parsed = parseReviewedEntry(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.reviewedRisk).toBe("write");

    const unclassified = parseReviewedEntry({ ...valid, reviewedRisk: null });
    expect(unclassified.ok).toBe(true);
    if (unclassified.ok) expect(unclassified.value.reviewedRisk).toBeNull();
  });

  it("rejects an unknown risk, a bad kind, and a multiline description", () => {
    expect(parseReviewedEntry({ ...valid, reviewedRisk: "harmless" }).ok).toBe(false);
    expect(parseReviewedEntry({ ...valid, arguments: { name: { kind: "guess" } } }).ok).toBe(false);
    expect(parseReviewedEntry({ ...valid, description: "two\nlines" }).ok).toBe(false);
  });

  it("rejects a review whose arguments name more than one candidate source", () => {
    const twoSources = {
      ...valid,
      arguments: {
        light: { kind: "candidates", candidateSource: "list_lights" },
        lock: { kind: "candidates", candidateSource: "list_locks" }
      }
    };
    expect(parseReviewedEntry(twoSources).ok).toBe(false);
    // Two arguments sharing one source is fine; the gate offers that one list for both.
    const oneSource = {
      ...valid,
      arguments: {
        light: { kind: "candidates", candidateSource: "list_lights" },
        room: { kind: "candidates", candidateSource: "list_lights" }
      }
    };
    expect(parseReviewedEntry(oneSource).ok).toBe(true);
  });

  it("bounds enum values and argument count", () => {
    const tooManyValues = {
      ...valid,
      arguments: { name: { kind: "enum", values: Array.from({ length: 51 }, (_, i) => `v${i}`) } }
    };
    expect(parseReviewedEntry(tooManyValues).ok).toBe(false);
    expect(parseReviewedEntry({ ...valid, replyTemplate: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("stored map reading fails closed", () => {
  it("reads a malformed map as empty and drops malformed entries", () => {
    expect(parsePreparationMap(null).entries).toEqual({});
    expect(parsePreparationMap({ version: 2, entries: {} }).entries).toEqual({});
    expect(parsePreparationMap({ version: 1, entries: [] }).entries).toEqual({});
    expect(
      parsePreparationMap({
        version: 1,
        entries: { bad: { optIn: "yes" }, good: entry("sha256:abc") }
      }).entries
    ).toEqual({ good: entry("sha256:abc") });
  });

  it("keeps the stored map bounded", () => {
    let map = emptyPreparationMap();
    for (let i = 0; i < INTEGRATION_CLASSIFIER_MAX_ENTRIES; i += 1) {
      map = withPreparationEntry(map, `tool_${i}`, entry("sha256:abc"));
    }
    const overflow = withPreparationEntry(map, "one_more", entry("sha256:abc"));
    expect(Object.keys(overflow.entries)).toHaveLength(INTEGRATION_CLASSIFIER_MAX_ENTRIES);
    expect(overflow.entries["one_more"]).toBeUndefined();
  });
});

describe("effectiveClassifierTools eligibility (spec 8.5)", () => {
  const prepared = (t: IntegrationToolDescriptor) =>
    mapWith(t.name, entry(toolDefinitionFingerprint(t), { optIn: true, reviewedRisk: null }));

  it("returns a sorted, prepared tool with the sorted risk, ignoring the old opt-in fields", () => {
    const current = tool();
    const tools = effectiveClassifierTools(
      state({
        classifierPreparation: mapWith(
          "turn_on",
          entry(toolDefinitionFingerprint(current), { optIn: false, reviewedRisk: null })
        ),
        classifierSort: sortedAs([current], "read")
      })
    );
    expect(tools.map((t) => t.tool.name)).toEqual(["turn_on"]);
    expect(tools[0]?.risk).toBe("read");
  });

  it("is empty when the connection or the classifier switch is off", () => {
    const prep = prepared(tool());
    expect(
      effectiveClassifierTools(state({ enabled: false, classifierPreparation: prep }))
    ).toEqual([]);
    expect(
      effectiveClassifierTools(state({ classifierEnabled: false, classifierPreparation: prep }))
    ).toEqual([]);
  });

  it("drops a kept-out tool and returns it when it is let back in", () => {
    const prep = prepared(tool());
    expect(
      effectiveClassifierTools(
        state({ classifierPreparation: prep, classifierKeptOutTools: ["turn_on"] })
      )
    ).toEqual([]);
    expect(effectiveClassifierTools(state({ classifierPreparation: prep }))).toHaveLength(1);
  });

  it("drops an unsorted, failed or stale-sorted tool", () => {
    const current = tool();
    const prep = prepared(current);
    expect(
      effectiveClassifierTools(
        state({ classifierPreparation: prep, classifierSort: emptySortMap() })
      )
    ).toEqual([]);
    const failed = withSortResult(emptySortMap(), "turn_on", {
      status: "failed",
      failure: "error",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(current)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
    expect(
      effectiveClassifierTools(state({ classifierPreparation: prep, classifierSort: failed }))
    ).toEqual([]);
    // A sort made against other risk inputs (here, a different method) is stale.
    const sortedAsPost = sortedAs([{ ...current, invoke: { method: "POST" } } as never]);
    expect(
      effectiveClassifierTools(
        state({
          discoveredTools: [{ ...current, invoke: { method: "DELETE" } } as never],
          classifierPreparation: prep,
          classifierSort: sortedAsPost
        })
      )
    ).toEqual([]);
  });

  it("drops an unprepared, removed or changed tool and returns it after re-preparation", () => {
    // Newly discovered and sorted, but not prepared yet.
    expect(effectiveClassifierTools(state())).toEqual([]);
    // Entry saved for a tool that is no longer discovered.
    expect(
      effectiveClassifierTools(
        state({ discoveredTools: [], classifierPreparation: mapWith("gone", entry("sha256:abc")) })
      )
    ).toEqual([]);
    // The definition changed: re-sorted, but the preparation was made for the old definition.
    const changed = tool({ description: "Now a different action" });
    const old = prepared(tool());
    expect(
      effectiveClassifierTools(state({ discoveredTools: [changed], classifierPreparation: old }))
    ).toEqual([]);
    // Automatic re-preparation saves an entry for the new definition, and the tool is back.
    expect(
      effectiveClassifierTools(
        state({ discoveredTools: [changed], classifierPreparation: prepared(changed) })
      ).map((t) => t.tool.name)
    ).toEqual(["turn_on"]);
  });

  it("drops everything after a failed discovery even when ordinary chat keeps the tools", () => {
    const prep = prepared(tool());
    expect(
      effectiveClassifierTools(state({ lastError: "fetch failed", classifierPreparation: prep }))
    ).toEqual([]);
  });

  it("drops a tool the owner switched off for ordinary chat", () => {
    const prep = prepared(tool());
    // Under the group-opt-in threshold a muted tool is off for chat.
    expect(
      effectiveClassifierTools(state({ mutedTools: ["turn_on"], classifierPreparation: prep }))
    ).toEqual([]);
    // Over the threshold, a tool that is not explicitly enabled is likewise off.
    const many = Array.from({ length: 31 }, (_, i) => tool({ name: `tool_${i}` }));
    const bigState = state({
      discoveredTools: many,
      enabledGroups: [],
      enabledTools: [],
      classifierPreparation: prepared(many[0]!)
    });
    expect(effectiveClassifierTools(bigState)).toEqual([]);
  });
});

describe("stored preparation failures", () => {
  it("reads well-formed failures and drops malformed ones", () => {
    const parsed = parsePreparationMap({
      version: 1,
      entries: {},
      failures: {
        turn_on: { reason: "unsafe", definitionFingerprint: "sha256:a", failedAt: "t" },
        bad_reason: { reason: "nope", definitionFingerprint: "sha256:a", failedAt: "t" },
        no_print: { reason: "unsafe", failedAt: "t" }
      }
    });
    expect(Object.keys(parsed.failures ?? {})).toEqual(["turn_on"]);
    expect(preparationFailure(parsed, "turn_on")?.reason).toBe("unsafe");
    expect(preparationFailure(parsed, "toString")).toBeUndefined();
  });
});

describe("prototype-safe tool names", () => {
  it("does not invent a review row for a tool named after an Object.prototype member", () => {
    const names = ["toString", "constructor", "hasOwnProperty", "__defineGetter__"];
    const colliding = state({
      discoveredTools: names.map((name) => tool({ name })),
      classifierPreparation: emptyPreparationMap()
    });
    expect(classifierPreparationView(colliding)).toEqual([]);
    expect(effectiveClassifierTools(colliding)).toEqual([]);
  });

  it("stores a tool literally named __proto__ as an own entry without polluting prototypes", () => {
    const raw = JSON.parse(
      '{"version":1,"entries":{"__proto__":{"optIn":true,"reviewedRisk":"read","description":"d",' +
        '"arguments":{},"replyTemplate":"r","definitionFingerprint":"sha256:x",' +
        '"reviewedAt":"2026-10-01T00:00:00.000Z","preparationVersion":1}}}'
    ) as unknown;
    const parsed = parsePreparationMap(raw);
    expect(Object.prototype.hasOwnProperty.call(parsed.entries, "__proto__")).toBe(true);
    expect(parsed.entries["__proto__"]?.reviewedRisk).toBe("read");
    // No global prototype pollution: a fresh object has no spilled keys.
    expect(({} as Record<string, unknown>)["optIn"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["reviewedRisk"]).toBeUndefined();
  });
});

describe("classifierPreparationView", () => {
  it("reports current versus stale from the stored fingerprint alone", () => {
    const current = tool();
    const view = classifierPreparationView(
      state({
        discoveredTools: [current, tool({ name: "turn_off" })],
        classifierPreparation: {
          version: 1,
          entries: {
            turn_on: entry(toolDefinitionFingerprint(current)),
            turn_off: entry("sha256:stale")
          }
        }
      })
    );
    expect(view.map((v) => [v.toolName, v.state])).toEqual([
      ["turn_on", "current"],
      ["turn_off", "stale"]
    ]);
  });
});
