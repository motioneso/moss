import { describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import {
  CLASSIFIER_REPLY,
  createCandidateCache,
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  createResolverCache,
  emptyPreparationMap,
  extractCandidatesFromListing,
  INTEGRATION_CLASSIFIER_OUTPUT_SCHEMA,
  loadCachedCandidates,
  renderIntegrationClassifierReply,
  resolveCandidateListingTool,
  refreshConnectionCandidates,
  toolDefinitionFingerprint,
  type CandidateCache,
  type CandidateListingPort,
  type ClassifierConnectionState,
  type ClassifierPreparationEntry,
  type ClassifierPreparationMap
} from "@moss/integrations";
import type { ConnectionRow } from "@moss/integrations";
import type { DiscoveredTool } from "@moss/integrations";
import { checkClassifierEligibility } from "@moss/module-sdk";
import type { IntegrationToolDescriptor } from "@moss/shared";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function listingTool(
  overrides: Partial<IntegrationToolDescriptor> = {}
): IntegrationToolDescriptor {
  return {
    name: "list_lights",
    description: "List the lights",
    group: "lights",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    ...overrides
  };
}

function entry(
  fingerprint: string,
  overrides: Partial<ClassifierPreparationEntry> = {}
): ClassifierPreparationEntry {
  return {
    optIn: true,
    reviewedRisk: "read",
    description: "List the lights",
    arguments: {},
    replyTemplate: "Read succeeded.",
    definitionFingerprint: fingerprint,
    reviewedAt: "2026-10-01T00:00:00.000Z",
    preparationVersion: 1,
    ...overrides
  };
}

function mapWith(toolName: string, value: ClassifierPreparationEntry): ClassifierPreparationMap {
  return { version: 1, entries: { [toolName]: value } };
}

function state(overrides: Partial<ClassifierConnectionState> = {}): ClassifierConnectionState {
  return {
    enabled: true,
    classifierEnabled: true,
    lastError: null,
    discoveredTools: [listingTool()],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    classifierPreparation: emptyPreparationMap(),
    ...overrides
  };
}

function port(
  callReadOnlyListingTool: CandidateListingPort["callReadOnlyListingTool"]
): CandidateListingPort {
  return { callReadOnlyListingTool };
}

const ok = (result: unknown) => ({ ok: true as const, result });

// ---------------------------------------------------------------------------
// Candidate source resolution
// ---------------------------------------------------------------------------

describe("candidate source resolution", () => {
  it("resolves only a reviewed read-only opted-in listing tool", () => {
    const tool = listingTool();
    const fingerprint = toolDefinitionFingerprint(tool);
    const reviewed = mapWith("list_lights", entry(fingerprint));

    expect(
      resolveCandidateListingTool(
        state({ discoveredTools: [tool], classifierPreparation: reviewed }),
        "list_lights"
      )?.tool.name
    ).toBe("list_lights");

    const cases: ClassifierConnectionState[] = [
      state({ discoveredTools: [tool] }), // no review at all
      state({
        discoveredTools: [tool],
        classifierPreparation: mapWith("list_lights", entry(fingerprint, { optIn: false }))
      }),
      state({
        discoveredTools: [tool],
        classifierPreparation: mapWith("list_lights", entry(fingerprint, { reviewedRisk: "write" }))
      }),
      state({
        discoveredTools: [tool],
        classifierPreparation: mapWith("list_lights", entry(fingerprint, { reviewedRisk: null }))
      }),
      state({
        discoveredTools: [tool],
        classifierPreparation: mapWith("list_lights", entry("sha256:changed"))
      }),
      state({
        discoveredTools: [tool],
        mutedTools: ["list_lights"],
        classifierPreparation: reviewed
      }),
      state({ classifierEnabled: false, discoveredTools: [tool], classifierPreparation: reviewed }),
      state({ lastError: "discovery failed", discoveredTools: [tool] })
    ];
    for (const candidateState of cases) {
      expect(resolveCandidateListingTool(candidateState, "list_lights")).toBeNull();
    }
    expect(resolveCandidateListingTool(state(), "")).toBeNull();
  });

  it("does not treat a server read-only hint as authority", () => {
    const tool = listingTool({ readOnly: true });
    const fingerprint = toolDefinitionFingerprint(tool);
    // The server says read-only, the owner reviewed it as a write: not a candidate source.
    expect(
      resolveCandidateListingTool(
        state({
          discoveredTools: [tool],
          classifierPreparation: mapWith(
            "list_lights",
            entry(fingerprint, { reviewedRisk: "write" })
          )
        }),
        "list_lights"
      )
    ).toBeNull();
    // A discovered read-only tool with no review is not a candidate source either.
    expect(
      resolveCandidateListingTool(state({ discoveredTools: [tool] }), "list_lights")
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extraction mapping
// ---------------------------------------------------------------------------

describe("candidate extraction mapping", () => {
  /** The exact outer shape `buildToolManifest` wraps every integration reply in. */
  const envelope = (detail: unknown) => ({
    status: "ok",
    action: "read",
    summary: "Read succeeded.",
    detail
  });

  it("reads a real MCP tool reply (flattened text into detail.result)", () => {
    // Shape produced by `callMcpTool` (mcp-client.ts:94): content text blocks joined into `result`.
    const payload = [
      { entity_id: "light.a", friendly_name: "Kitchen" },
      { entity_id: "light.b", friendly_name: "Desk" }
    ];
    expect(extractCandidatesFromListing(envelope({ result: JSON.stringify(payload) }))).toEqual([
      { id: "light.a", label: "Kitchen" },
      { id: "light.b", label: "Desk" }
    ]);
    // One text block per device, joined with newlines.
    expect(extractCandidatesFromListing(envelope({ result: "Kitchen\nDesk" }))).toEqual([
      { id: "Kitchen", label: "Kitchen" },
      { id: "Desk", label: "Desk" }
    ]);
  });

  it("reads a real MCP standard result envelope (content blocks and structured content)", () => {
    const structured = [{ id: "light.a", name: "Kitchen" }];
    expect(
      extractCandidatesFromListing({
        content: [{ type: "text", text: "text is ignored when structured content is present" }],
        structuredContent: structured
      })
    ).toEqual([{ id: "light.a", label: "Kitchen" }]);
    expect(
      extractCandidatesFromListing({
        content: [{ type: "text", text: JSON.stringify(structured) }]
      })
    ).toEqual([{ id: "light.a", label: "Kitchen" }]);
  });

  it("reads a real OpenAPI tool reply (detail { status, result })", () => {
    expect(
      extractCandidatesFromListing(
        envelope({ status: 200, result: [{ id: "d1", name: "Desk" }, "Floor lamp"] })
      )
    ).toEqual([
      { id: "d1", label: "Desk" },
      { id: "Floor lamp", label: "Floor lamp" }
    ]);
  });

  it("still accepts a bare array", () => {
    expect(extractCandidatesFromListing([{ id: "a", label: "A" }])).toEqual([
      { id: "a", label: "A" }
    ]);
  });

  it("rejects a malformed, failed, oversized or ambiguous listing whole", () => {
    expect(
      extractCandidatesFromListing({
        status: "error",
        action: "read",
        summary: "Call failed; see detail for the service's error.",
        detail: { result: JSON.stringify([{ id: "a", name: "A" }]) }
      })
    ).toBeNull();
    expect(extractCandidatesFromListing(envelope({ result: "[]" }))).toBeNull();
    expect(extractCandidatesFromListing(envelope({ result: "" }))).toBeNull();
    expect(
      extractCandidatesFromListing(envelope({ result: JSON.stringify([{ id: "a" }]) }))
    ).toBeNull();
    expect(extractCandidatesFromListing(envelope({ result: "x".repeat(81) }))).toBeNull();
    expect(
      extractCandidatesFromListing(
        envelope({
          result: JSON.stringify([
            { id: "a", name: "A" },
            { id: "a", name: "B" }
          ])
        })
      )
    ).toBeNull();
    expect(
      extractCandidatesFromListing(
        envelope({
          result: JSON.stringify([
            { id: "a", name: "A" },
            { id: "b", name: "A" }
          ])
        })
      )
    ).toBeNull();
    expect(
      extractCandidatesFromListing(
        envelope({
          result: JSON.stringify(
            Array.from({ length: 51 }, (_, i) => ({ id: `i${i}`, name: `n${i}` }))
          )
        })
      )
    ).toBeNull();
    expect(
      extractCandidatesFromListing(
        envelope({ result: JSON.stringify([{ id: "a", name: "x".repeat(81) }]) })
      )
    ).toBeNull();
  });

  it("skips prose and list markers in the one-name-per-line fallback", () => {
    expect(extractCandidatesFromListing(envelope({ result: "No devices found." }))).toBeNull();
    expect(
      extractCandidatesFromListing(envelope({ result: "Here are your lights:\n- Kitchen\n- Desk" }))
    ).toBeNull();
    expect(extractCandidatesFromListing(envelope({ result: "1. Kitchen\n2. Desk" }))).toBeNull();
    // A real one-name-per-line list still reads.
    expect(extractCandidatesFromListing(envelope({ result: "Kitchen\nDesk" }))).toEqual([
      { id: "Kitchen", label: "Kitchen" },
      { id: "Desk", label: "Desk" }
    ]);
  });

  it("rejects a listing explicitly marked truncated", () => {
    expect(
      extractCandidatesFromListing({
        ...envelope({ result: JSON.stringify([{ id: "a", name: "A" }]) }),
        truncated: true
      })
    ).toBeNull();
  });

  it("never copies a secret or a sample value into a candidate label", () => {
    const out = extractCandidatesFromListing(
      envelope({
        status: 200,
        result: [
          { entity_id: "light.a", friendly_name: "Kitchen", token: "SECRET", example: "SECRET2" }
        ]
      })
    );
    expect(out).toEqual([{ id: "light.a", label: "Kitchen" }]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Owner-scoped cache
// ---------------------------------------------------------------------------

describe("candidate cache", () => {
  function seededCache(now: () => number): CandidateCache {
    const cache = createCandidateCache({ now });
    cache.set(
      { ownerUserId: "u1", connectionId: "c1", sourceName: "list_lights" },
      { candidates: [{ id: "a", label: "A" }], sourceFingerprint: "fp", fetchedAt: now() }
    );
    return cache;
  }

  it("keeps lists owner-scoped, fingerprinted and expiring", () => {
    let now = 1_000;
    const cache = seededCache(() => now);
    const read = (actorUserId: string, sourceFingerprint: string) =>
      loadCachedCandidates({
        cache,
        actorUserId,
        connectionId: "c1",
        sourceName: "list_lights",
        sourceFingerprint
      });

    expect(read("u1", "fp")).toEqual([{ id: "a", label: "A" }]);
    expect(read("u2", "fp")).toBeNull(); // a different owner never sees it
    expect(read("u1", "other")).toBeNull(); // the listing definition changed
    now += 300_001;
    expect(read("u1", "fp")).toBeNull(); // expired
  });

  it("dropConnection clears only that owner and connection", () => {
    const cache = createCandidateCache({ now: () => 1 });
    const key = (ownerUserId: string, connectionId: string) => ({
      ownerUserId,
      connectionId,
      sourceName: "list_lights"
    });
    const value = { candidates: [{ id: "a", label: "A" }], sourceFingerprint: "fp", fetchedAt: 1 };
    cache.set(key("u1", "c1"), value);
    cache.set(key("u1", "c2"), value);
    cache.set(key("u2", "c1"), value);

    cache.dropConnection("u1", "c1");

    expect(cache.get(key("u1", "c1"))).toBeUndefined();
    expect(cache.get(key("u1", "c2"))).toBeDefined();
    expect(cache.get(key("u2", "c1"))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Explicit refresh
// ---------------------------------------------------------------------------

describe("explicit candidate refresh", () => {
  const tool = listingTool();
  const fingerprint = toolDefinitionFingerprint(tool);
  const reviewedState = state({
    discoveredTools: [tool],
    classifierPreparation: mapWith("list_lights", entry(fingerprint))
  });

  it("calls the reviewed listing tool once and caches a usable list", async () => {
    const cache = createCandidateCache({ now: () => 1_000 });
    let calls = 0;
    const result = await refreshConnectionCandidates({
      state: reviewedState,
      connectionId: "c1",
      actorUserId: "u1",
      sourceName: "list_lights",
      port: port(async () => {
        calls += 1;
        return ok({ status: "ok", detail: [{ id: "a", name: "A" }] });
      }),
      cache,
      now: () => 1_000
    });

    expect(result).toEqual({ refreshed: true });
    expect(calls).toBe(1);
    expect(
      loadCachedCandidates({
        cache,
        actorUserId: "u1",
        connectionId: "c1",
        sourceName: "list_lights",
        sourceFingerprint: fingerprint
      })
    ).toEqual([{ id: "a", label: "A" }]);
  });

  it("makes no call when no reviewed read-only listing tool resolves", async () => {
    const cache = createCandidateCache();
    let calls = 0;
    const result = await refreshConnectionCandidates({
      state: state({ discoveredTools: [tool] }),
      connectionId: "c1",
      actorUserId: "u1",
      sourceName: "list_lights",
      port: port(async () => {
        calls += 1;
        return ok([]);
      }),
      cache,
      now: () => 1_000
    });

    expect(result).toEqual({ refreshed: false, reason: "no_read_only_listing_tool" });
    expect(calls).toBe(0);
  });

  it("drops any previous list when the refresh is declined, failed or unusable", async () => {
    const cache = createCandidateCache({ now: () => 2_000 });
    const key = { ownerUserId: "u1", connectionId: "c1", sourceName: "list_lights" };
    const seed = () =>
      cache.set(key, {
        candidates: [{ id: "old", label: "Old" }],
        sourceFingerprint: fingerprint,
        fetchedAt: 1_000
      });
    const read = () =>
      loadCachedCandidates({
        cache,
        actorUserId: "u1",
        connectionId: "c1",
        sourceName: "list_lights",
        sourceFingerprint: fingerprint
      });
    const refresh = (
      listing: () => Promise<Awaited<ReturnType<CandidateListingPort["callReadOnlyListingTool"]>>>
    ) =>
      refreshConnectionCandidates({
        state: reviewedState,
        connectionId: "c1",
        actorUserId: "u1",
        sourceName: "list_lights",
        port: port(listing),
        cache,
        now: () => 2_000
      });

    seed();
    expect(await refresh(async () => ({ ok: false, reason: "declined" }))).toEqual({
      refreshed: false,
      reason: "declined"
    });
    expect(read()).toBeNull();

    seed();
    expect(await refresh(async () => ok({ status: "error", detail: [] }))).toEqual({
      refreshed: false,
      reason: "unusable_listing"
    });
    expect(read()).toBeNull();

    seed();
    expect(
      await refresh(async () => {
        throw new Error("listing exploded");
      })
    ).toEqual({ refreshed: false, reason: "listing_failed" });
    expect(read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reply contract
// ---------------------------------------------------------------------------

describe("integration reply contract", () => {
  const envelope = (fields: { status: unknown; action: unknown; summary: unknown }) => fields;

  it("prefers the reviewed template over the result fields", () => {
    expect(
      renderIntegrationClassifierReply({
        template: "Turned {summary}",
        result: { status: "ok", action: "performed", summary: "the kitchen light on." },
        envelope: envelope({ status: "ok", action: "performed", summary: "the kitchen light on." })
      })
    ).toBe("Turned the kitchen light on.");
  });

  it("falls back to the envelope summary when a template placeholder cannot be filled", () => {
    expect(
      renderIntegrationClassifierReply({
        template: "Turned {missing} on.",
        result: { status: "ok", action: "performed", summary: "ok" },
        envelope: envelope({ status: "ok", action: "performed", summary: "ok" })
      })
    ).toBe("ok");
  });

  it("returns null when nothing can produce a reply", () => {
    expect(
      renderIntegrationClassifierReply({
        template: "Turned {missing} on.",
        result: {},
        envelope: envelope({ status: "ok", action: "unknown", summary: "" })
      })
    ).toBeNull();
  });

  it("uses the fixed unconfirmed string for an error and never success text", () => {
    expect(
      renderIntegrationClassifierReply({
        template: "Turned the light on.",
        result: { status: "error", action: "performed", summary: "boom" },
        envelope: envelope({ status: "error", action: "performed", summary: "boom" })
      })
    ).toBe(CLASSIFIER_REPLY.unconfirmed);
  });

  it("preserves the suppression and truncation meanings", () => {
    const summaries = [
      "Unchanged result from earlier in this request.",
      "This was already done once in this request and was not done again.",
      "Result truncated at 8,000 characters; ask for a narrower query to see more.",
      "Call limit reached for this request; answer with what you have."
    ];
    for (const summary of summaries) {
      expect(
        renderIntegrationClassifierReply({
          template: "Turned the light on.",
          result: { status: "ok", action: "performed", summary },
          envelope: envelope({
            status: summary.includes("Call limit") ? "error" : "ok",
            action: "performed",
            summary
          })
        })
      ).toBe(summary);
    }
  });

  it("uses the exact empty-success fallback by action and emits no detail", () => {
    expect(
      renderIntegrationClassifierReply({
        template: "{summary}",
        result: { status: "ok", action: "performed", summary: "" },
        envelope: envelope({ status: "ok", action: "performed", summary: "" })
      })
    ).toBe(CLASSIFIER_REPLY.performedOk);
    expect(
      renderIntegrationClassifierReply({
        template: "{summary}",
        result: { status: "ok", action: "read", summary: "" },
        envelope: envelope({ status: "ok", action: "read", summary: "" })
      })
    ).toBe(CLASSIFIER_REPLY.readOk);

    const withDetail = renderIntegrationClassifierReply({
      template: "Read: {summary}",
      result: { status: "ok", action: "read", summary: "2 items", detail: { secret: "SECRET" } },
      envelope: envelope({ status: "ok", action: "read", summary: "2 items" })
    });
    expect(withDetail).toBe("Read: 2 items");
    expect(withDetail).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Runtime menu on the synthetic manifest
// ---------------------------------------------------------------------------

function discovered(
  name: string,
  inputSchema: Record<string, unknown> | null = {},
  overrides: Partial<DiscoveredTool> = {}
): DiscoveredTool {
  return { name, description: name, group: "", inputSchema, ...overrides };
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-home",
    ownerUserId: "actor-1",
    name: "Home",
    kind: "mcp",
    transport: "http",
    url: "http://example.com",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: null,
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: true,
    classifierPreparation: emptyPreparationMap(),
    classifierSort: { version: 1, entries: {} },
    classifierKeptOutTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

describe("runtime classifier menu on synthetic tools", () => {
  const listing = discovered("list_lights", { type: "object", properties: {} }, { readOnly: true });
  const switchTool = discovered("turn_on", {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"]
  });

  function reviewedConnection(replyTemplate = "Turned {summary}"): ConnectionRow {
    const listingFingerprint = toolDefinitionFingerprint(listing as IntegrationToolDescriptor);
    const switchFingerprint = toolDefinitionFingerprint(switchTool as IntegrationToolDescriptor);
    return connection({
      discoveredTools: [listing, switchTool],
      classifierPreparation: {
        version: 1,
        entries: {
          list_lights: entry(listingFingerprint),
          turn_on: entry(switchFingerprint, {
            description: "Turn one light on.",
            reviewedRisk: "write",
            arguments: { target: { kind: "candidates", candidateSource: "list_lights" } },
            replyTemplate
          })
        }
      }
    });
  }

  function build(connections: readonly ConnectionRow[], candidateCache: CandidateCache) {
    return createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger: { warn: () => undefined },
      resolverCache: createResolverCache(),
      candidateCache,
      repository: {
        listConnections: async () => connections
      } as never
    });
  }

  it("attaches the reviewed declaration and passes the SDK eligibility check", async () => {
    const modules = await build([reviewedConnection()], createCandidateCache())("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const turnOn = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.turn_on")!;

    expect(turnOn.classifier?.description).toBe("Turn one light on.");
    expect(turnOn.classifier?.replyTemplate).toBe("Turned {summary}");
    expect(turnOn.classifier?.arguments).toEqual({ target: { kind: "candidates" } });
    expect(typeof turnOn.classifier?.candidates).toBe("function");
    expect(turnOn.outputSchema).toEqual(INTEGRATION_CLASSIFIER_OUTPUT_SCHEMA);
    expect(checkClassifierEligibility(turnOn).eligible).toBe(true);

    // The device-listing tool itself is read-reviewed, so it stays off the menu and only serves
    // as a candidate source.
    const listingTool = (synthetic.assistantTools ?? []).find(
      (tool) => tool.name === "home.list_lights"
    )!;
    expect(listingTool.classifier).toBeUndefined();
    expect(listingTool.outputSchema).toBeUndefined();
  });

  it("keeps a read-reviewed tool off the menu even though it stays a candidate source", async () => {
    // The plan forbids handling an informational read on the fixed "Read succeeded." reply. The
    // listing tool is reviewed read and opted in, so it is a valid candidate source, but it must
    // never gain a classifier declaration. This assertion fails if a read tool returns to the menu.
    const modules = await build([reviewedConnection()], createCandidateCache())("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const listingTool = (synthetic.assistantTools ?? []).find(
      (tool) => tool.name === "home.list_lights"
    )!;
    expect(listingTool.classifier).toBeUndefined();
    expect(checkClassifierEligibility(listingTool).eligible).toBe(false);

    // A tool reviewed as read loses the declaration even with arguments and a template.
    const switchFingerprint = toolDefinitionFingerprint(switchTool as IntegrationToolDescriptor);
    const readSwitch = connection({
      discoveredTools: [listing, switchTool],
      classifierPreparation: {
        version: 1,
        entries: {
          list_lights: entry(toolDefinitionFingerprint(listing as IntegrationToolDescriptor)),
          turn_on: entry(switchFingerprint, { reviewedRisk: "read" })
        }
      }
    });
    const readModules = await build([readSwitch], createCandidateCache())("actor-1");
    const readSynthetic = readModules.find((module) => module.id === "integration-home")!;
    const readTurnOn = (readSynthetic.assistantTools ?? []).find(
      (tool) => tool.name === "home.turn_on"
    )!;
    expect(readTurnOn.classifier).toBeUndefined();
  });

  it("omits the declaration for a tool with no current review", async () => {
    const modules = await createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger: { warn: () => undefined },
      resolverCache: createResolverCache(),
      candidateCache: createCandidateCache(),
      repository: {
        listConnections: async () => [connection({ discoveredTools: [switchTool] })]
      } as never
    })("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const turnOn = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.turn_on")!;
    expect(turnOn.classifier).toBeUndefined();
    expect(turnOn.outputSchema).toBeUndefined();
  });

  it("marks a template that names detail ineligible", async () => {
    const modules = await createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger: { warn: () => undefined },
      resolverCache: createResolverCache(),
      candidateCache: createCandidateCache(),
      repository: {
        listConnections: async () => [reviewedConnection("Result: {detail}")]
      } as never
    })("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const turnOn = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.turn_on")!;
    const eligibility = checkClassifierEligibility(turnOn);
    expect(eligibility.eligible).toBe(false);
  });

  it("does not attach a candidates hook when the listing tool is not reviewed as read", async () => {
    const listingFingerprint = toolDefinitionFingerprint(listing as IntegrationToolDescriptor);
    const switchFingerprint = toolDefinitionFingerprint(switchTool as IntegrationToolDescriptor);
    const writeListing = connection({
      discoveredTools: [listing, switchTool],
      classifierPreparation: {
        version: 1,
        entries: {
          list_lights: entry(listingFingerprint, { reviewedRisk: "write" }),
          turn_on: entry(switchFingerprint, {
            description: "Turn one light on.",
            reviewedRisk: "write",
            arguments: { target: { kind: "candidates", candidateSource: "list_lights" } },
            replyTemplate: "Turned {summary}"
          })
        }
      }
    });

    const modules = await build([writeListing], createCandidateCache())("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const turnOn = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.turn_on")!;
    expect(turnOn.classifier?.candidates).toBeUndefined();
    expect(checkClassifierEligibility(turnOn).eligible).toBe(false);
  });

  it("stays off the menu when its arguments name more than one candidate source", async () => {
    const lights = discovered("list_lights", {}, { readOnly: true });
    const locks = discovered("list_locks", {}, { readOnly: true });
    const act = discovered("act", {
      type: "object",
      properties: { light: { type: "string" }, lock: { type: "string" } },
      required: ["light", "lock"]
    });
    const multiSource = connection({
      discoveredTools: [lights, locks, act],
      classifierPreparation: {
        version: 1,
        entries: {
          list_lights: entry(toolDefinitionFingerprint(lights as IntegrationToolDescriptor)),
          list_locks: entry(toolDefinitionFingerprint(locks as IntegrationToolDescriptor)),
          act: entry(toolDefinitionFingerprint(act as IntegrationToolDescriptor), {
            description: "Set a light and a lock.",
            reviewedRisk: "write",
            arguments: {
              light: { kind: "candidates", candidateSource: "list_lights" },
              lock: { kind: "candidates", candidateSource: "list_locks" }
            },
            replyTemplate: "Done."
          })
        }
      }
    });

    const modules = await build([multiSource], createCandidateCache())("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const actTool = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.act")!;
    expect(actTool.classifier?.candidates).toBeUndefined();
    expect(checkClassifierEligibility(actTool).eligible).toBe(false);
  });

  it("reads only the owner's cached candidates in the hook", async () => {
    const cache = createCandidateCache();
    const listingFingerprint = toolDefinitionFingerprint(listing as IntegrationToolDescriptor);
    cache.set(
      { ownerUserId: "actor-1", connectionId: "conn-home", sourceName: "list_lights" },
      {
        candidates: [{ id: "light.kitchen", label: "Kitchen" }],
        sourceFingerprint: listingFingerprint,
        fetchedAt: Date.now()
      }
    );

    const modules = await build([reviewedConnection()], cache)("actor-1");
    const synthetic = modules.find((module) => module.id === "integration-home")!;
    const turnOn = (synthetic.assistantTools ?? []).find((tool) => tool.name === "home.turn_on")!;
    const signal = new AbortController().signal;

    await expect(
      turnOn.classifier!.candidates!({}, { actorUserId: "actor-1" } as never, { signal })
    ).resolves.toEqual([{ id: "light.kitchen", label: "Kitchen" }]);
    await expect(
      turnOn.classifier!.candidates!({}, { actorUserId: "other-actor" } as never, { signal })
    ).rejects.toThrow("candidates_unavailable");
  });
});
