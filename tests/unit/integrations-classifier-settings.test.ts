import { describe, expect, it } from "vitest";

import {
  classifierSortView,
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
  parseSortMap,
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
    expect(classifierSortView(colliding).some((t) => t.classifierState === "ready")).toBe(false);
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

describe("classifierSortView standing (#2984 R2.5b)", () => {
  const prepared = (
    t: IntegrationToolDescriptor,
    overrides: Partial<ClassifierPreparationEntry> = {}
  ) => mapWith(t.name, entry(toolDefinitionFingerprint(t), overrides));
  const standing = (overrides: Parameters<typeof state>[0]) =>
    classifierSortView(state(overrides))[0]!;
  const failedAgainst = (
    fingerprint: string,
    reason: "no_model" | "provider_error" = "no_model"
  ): ClassifierPreparationMap => ({
    ...emptyPreparationMap(),
    failures: { turn_on: { reason, definitionFingerprint: fingerprint, failedAt: "t" } }
  });

  it("reads off while the switch is off, before anything else", () => {
    const view = standing({ classifierEnabled: false, classifierKeptOutTools: ["turn_on"] });
    expect(view.classifierState).toBe("off");
    expect(view.keptOut).toBe(true);
  });

  it("reads kept_out for a kept-out tool even when it is prepared", () => {
    const view = standing({
      classifierKeptOutTools: ["turn_on"],
      classifierPreparation: prepared(tool())
    });
    expect(view.classifierState).toBe("kept_out");
  });

  it("reads not_used for a tool off for chat, a failed sort, or a root-combinator schema", () => {
    expect(standing({ mutedTools: ["turn_on"] }).classifierState).toBe("not_used");
    const failedSort = withSortResult(emptySortMap(), "turn_on", {
      status: "failed",
      failure: "error",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(tool())),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
    expect(standing({ classifierSort: failedSort }).classifierState).toBe("not_used");
    const combinator = tool({ inputSchema: { anyOf: [{ type: "object" }] } });
    expect(standing({ discoveredTools: [combinator] }).classifierState).toBe("not_used");
  });

  it("reads failed for want of a model when the sort failed for that reason", () => {
    const failedSort = (failure: "error" | "no_model") =>
      withSortResult(emptySortMap(), "turn_on", {
        status: "failed",
        failure,
        sortFingerprint: toolSortFingerprint(toolRiskInputs(tool())),
        sortedAt: "2026-10-03T00:00:00.000Z"
      })!;
    const missing = standing({ classifierSort: failedSort("no_model") });
    expect(missing).toMatchObject({
      status: "failed",
      failure: "no_model",
      classifierState: "failed",
      preparationFailure: "no_model",
      failedAt: "2026-10-03T00:00:00.000Z"
    });

    const errored = standing({ classifierSort: failedSort("error") });
    expect(errored).toMatchObject({
      classifierState: "not_used",
      preparationFailure: null,
      failedAt: "2026-10-03T00:00:00.000Z"
    });

    const off = standing({ classifierEnabled: false, classifierSort: failedSort("no_model") });
    expect(off).toMatchObject({ classifierState: "off", preparationFailure: null });
  });

  it("reads preparing while the sort is never tried or stale, and before first preparation", () => {
    expect(standing({ classifierSort: emptySortMap() }).classifierState).toBe("preparing");
    const stale = sortedAs([tool({ description: "Older text" })]);
    expect(standing({ classifierSort: stale }).classifierState).toBe("preparing");
    expect(standing({}).classifierState).toBe("preparing");
  });

  it("reads ready with the preparation time when the preparation matches", () => {
    const view = standing({ classifierPreparation: prepared(tool()) });
    expect(view.classifierState).toBe("ready");
    expect(view.preparedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(view.preparationFailure).toBeNull();
  });

  it("reads failed with its reason only for a failure against the current definition", () => {
    const fingerprint = toolDefinitionFingerprint(tool());
    const failed = standing({ classifierPreparation: failedAgainst(fingerprint) });
    expect(failed.classifierState).toBe("failed");
    expect(failed.preparationFailure).toBe("no_model");
    expect(failed.failedAt).toBe("t");
    expect(failed.preparedAt).toBeNull();
    const old = standing({ classifierPreparation: failedAgainst("sha256:older") });
    expect(old.classifierState).toBe("preparing");
    expect(old.preparationFailure).toBeNull();
  });

  it("reads preparing_again for a preparation made against an older definition", () => {
    const view = standing({
      classifierPreparation: mapWith("turn_on", entry("sha256:older"))
    });
    expect(view.classifierState).toBe("preparing_again");
    expect(view.preparedAt).toBeNull();
  });

  it("reads preparing_again for a prepared tool that changed and waits to be sorted again", () => {
    const changed = tool({ description: "Newer text" });
    const view = standing({
      discoveredTools: [changed],
      classifierSort: sortedAs([tool()]),
      classifierPreparation: prepared(tool())
    });
    expect(view.classifierState).toBe("preparing_again");
  });

  it("marks ready exactly the tools the gate would offer", () => {
    const tools = [
      tool(),
      tool({ name: "turn_off" }),
      tool({ name: "dim" }),
      tool({ name: "kept" })
    ];
    const shared = state({
      discoveredTools: tools,
      classifierSort: sortedAs(tools),
      classifierKeptOutTools: ["kept"],
      classifierPreparation: {
        version: 1,
        entries: {
          turn_on: entry(toolDefinitionFingerprint(tools[0]!)),
          turn_off: entry("sha256:older"),
          kept: entry(toolDefinitionFingerprint(tools[3]!))
        }
      }
    });
    const ready = classifierSortView(shared)
      .filter((t) => t.classifierState === "ready")
      .map((t) => t.toolName);
    expect(ready).toEqual(effectiveClassifierTools(shared).map((t) => t.tool.name));
    expect(ready).toEqual(["turn_on"]);
  });

  it("shows the model's name and sort details only while the sort is current", () => {
    const current = standing({});
    expect(current.readableName).toBe("Turn on");
    expect(current.sortedAt).toBe("2026-10-03T00:00:00.000Z");

    const unsorted = classifierSortView(
      state({
        discoveredTools: [tool({ name: "light_turn_on" }), tool({ name: "light_turn_off" })],
        classifierSort: emptySortMap()
      })
    );
    expect(unsorted.map((t) => t.readableName)).toEqual(["Turn on", "Turn off"]);
    expect(unsorted.every((t) => t.sortedAt === null && t.sortedBy === null)).toBe(true);
  });
});

describe("sortedBy on stored sorts (#2984 R2.5b)", () => {
  const current = tool();
  const fingerprint = toolSortFingerprint(toolRiskInputs(current));
  const viewWith = (classifierSort: ClassifierSortMap) =>
    classifierSortView(state({ classifierSort }))[0]!;
  const stored = (sortedBy: unknown) =>
    parseSortMap({
      version: 1,
      entries: {
        turn_on: {
          status: "current",
          risk: "write",
          readableName: "Turn on",
          sortFingerprint: fingerprint,
          sortedAt: "2026-10-03T00:00:00.000Z",
          failure: null,
          sendWithoutAsking: false,
          legacyRiskFloor: null,
          ...(sortedBy === undefined ? {} : { sortedBy })
        }
      }
    });

  it("stores and shows valid display names", () => {
    const map = withSortResult(emptySortMap(), "turn_on", {
      status: "current",
      risk: "write",
      readableName: "Turn on",
      sortFingerprint: fingerprint,
      sortedAt: "2026-10-03T00:00:00.000Z",
      sortedBy: { model: "House model", provider: "Home server" }
    })!;
    expect(viewWith(map).sortedBy).toEqual({ model: "House model", provider: "Home server" });
    expect(viewWith(parseSortMap(JSON.parse(JSON.stringify(map)))).sortedBy).toEqual({
      model: "House model",
      provider: "Home server"
    });
  });

  it("reads invalid names as unknown without dropping the sort", () => {
    for (const bad of [
      { model: "", provider: "Home server" },
      { model: "Line\nbreak", provider: "Home server" },
      { model: "x".repeat(81), provider: "Home server" },
      { model: "House model" },
      "House model"
    ]) {
      const view = viewWith(stored(bad));
      expect(view.status).toBe("current");
      expect(view.sortedBy).toBeNull();
    }
    const written = withSortResult(emptySortMap(), "turn_on", {
      status: "current",
      risk: "write",
      readableName: "Turn on",
      sortFingerprint: fingerprint,
      sortedAt: "2026-10-03T00:00:00.000Z",
      sortedBy: { model: "\u0000", provider: "Home server" }
    })!;
    expect(viewWith(written).status).toBe("current");
    expect(viewWith(written).sortedBy).toBeNull();
  });

  it("keeps an older stored sort that has no sortedBy", () => {
    const view = viewWith(stored(undefined));
    expect(view.status).toBe("current");
    expect(view.risk).toBe("write");
    expect(view.sortedBy).toBeNull();
  });

  it("records how a sort was made, and reads an older sort's method as unknown", () => {
    const sortedWith = (sortMethod: "model" | "local") =>
      withSortResult(emptySortMap(), "turn_on", {
        status: "current",
        risk: "write",
        readableName: "Turn on",
        sortFingerprint: fingerprint,
        sortedAt: "2026-10-03T00:00:00.000Z",
        sortedBy: { model: "House model", provider: "Home server" },
        sortMethod
      })!;
    const byModel = parseSortMap(JSON.parse(JSON.stringify(sortedWith("model"))));
    expect(viewWith(byModel)).toMatchObject({
      sortMethod: "model",
      sortedBy: { model: "House model", provider: "Home server" }
    });

    // A local sort read no model, whatever names came with it.
    expect(viewWith(sortedWith("local"))).toMatchObject({ sortMethod: "local", sortedBy: null });

    expect(viewWith(stored(undefined)).sortMethod).toBeNull();
    expect(viewWith(stored({ model: "House model", provider: "Home server" })).sortMethod).toBe(
      null
    );
  });
});
