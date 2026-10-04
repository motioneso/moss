import { afterEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import {
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  createResolverCache,
  effectiveClassifierTools,
  parsePreparationMap,
  parseReviewedEntry,
  toolDefinitionFingerprint,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";
import {
  checkExtractedArguments,
  extractionSchema,
  planArguments,
  type GateTool
} from "../../packages/chat/src/live/classifier-gate-arguments.js";

// A connected server chooses its argument names, and JSON.parse makes `__proto__` an ordinary own
// key. Every copy along the review -> storage -> manifest -> gate path must keep it that way: a
// plain `target[name] = value` would instead call the prototype setter and drop the argument.

const PROTO = "__proto__";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function protoTool(): DiscoveredTool {
  return {
    name: "set_mode",
    description: "Set a mode",
    group: "",
    inputSchema: JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}'
    ) as Record<string, unknown>
  };
}

function savedBody(fingerprint: string): unknown {
  return JSON.parse(
    `{"optIn":true,"reviewedRisk":"write","description":"Set a mode","replyTemplate":"Done.",` +
      `"arguments":{"__proto__":{"kind":"extract"}},"reviewedFingerprint":"${fingerprint}"}`
  );
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-proto",
    ownerUserId: "owner",
    name: "Proto",
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
    classifierPreparation: { version: 1, entries: {} },
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

afterEach(() => {
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  expect(hasOwn(Object.prototype, "kind")).toBe(false);
});

describe("an argument named __proto__", () => {
  it("survives the save body, a JSON storage round trip and the effective-tool read", () => {
    const tool = protoTool();
    const parsed = parseReviewedEntry(savedBody(toolDefinitionFingerprint(tool)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(hasOwn(parsed.value.arguments, PROTO)).toBe(true);
    expect(parsed.value.arguments[PROTO]).toEqual({ kind: "extract" });

    const { reviewedFingerprint, ...rest } = parsed.value;
    const stored = JSON.parse(
      JSON.stringify({
        version: 1,
        entries: {
          set_mode: {
            ...rest,
            definitionFingerprint: reviewedFingerprint,
            reviewedAt: "2026-10-03T00:00:00.000Z",
            preparationVersion: 1
          }
        }
      })
    ) as unknown;
    const map = parsePreparationMap(stored);
    const entry = map.entries["set_mode"]!;
    expect(hasOwn(entry.arguments, PROTO)).toBe(true);

    const tools = effectiveClassifierTools({
      enabled: true,
      classifierEnabled: true,
      lastError: null,
      discoveredTools: [tool],
      enabledGroups: [],
      enabledTools: [],
      mutedTools: [],
      classifierPreparation: map
    });
    expect(tools).toHaveLength(1);
    const copied = { ...tools[0]!.arguments };
    expect(hasOwn(copied, PROTO)).toBe(true);
    expect(Object.keys(JSON.parse(JSON.stringify(tools[0]!.arguments)))).toEqual([PROTO]);
  });

  it("changes the definition fingerprint when only that schema property changes", () => {
    const a = protoTool();
    const b: DiscoveredTool = {
      ...a,
      inputSchema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"number"}},"required":["__proto__"]}'
      ) as Record<string, unknown>
    };
    expect(toolDefinitionFingerprint(a)).not.toBe(toolDefinitionFingerprint(b));
  });

  it("reaches the synthetic tool's classifier declaration and the gate's call input", async () => {
    const tool = protoTool();
    const parsed = parseReviewedEntry(savedBody(toolDefinitionFingerprint(tool)));
    if (!parsed.ok) throw new Error("body should parse");
    const { reviewedFingerprint, ...rest } = parsed.value;
    const classifierPreparation = parsePreparationMap(
      JSON.parse(
        JSON.stringify({
          version: 1,
          entries: {
            set_mode: {
              ...rest,
              definitionFingerprint: reviewedFingerprint,
              reviewedAt: "2026-10-03T00:00:00.000Z",
              preparationVersion: 1
            }
          }
        })
      )
    );

    const resolver = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: {
        withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
      } as unknown as DataContextRunner,
      cipher: createIntegrationsCipher(),
      logger: { warn: () => {} },
      resolverCache: createResolverCache(),
      repository: {
        listConnections: async () => [
          connection({ discoveredTools: [tool], classifierPreparation })
        ]
      } as never
    });
    const modules = await resolver("actor-1");
    const synthetic = modules[0]!.assistantTools!.find((t) => t.name === "proto.set_mode")!;
    const declared = synthetic.classifier!.arguments!;
    expect(hasOwn(declared, PROTO)).toBe(true);
    expect(declared[PROTO]).toEqual({ kind: "extract" });

    const gateTool: GateTool = {
      moduleId: "integration-proto",
      moduleDescription: "Proto",
      name: synthetic.name,
      risk: "write",
      inputSchema: tool.inputSchema as GateTool["inputSchema"],
      classifier: synthetic.classifier
    };
    const plan = planArguments(gateTool);
    expect(plan).toEqual([{ name: PROTO, kind: "extract", required: true }]);

    const schema = extractionSchema(gateTool, plan, new Map());
    const properties = schema.properties as Record<string, unknown>;
    expect(hasOwn(properties, PROTO)).toBe(true);
    expect(JSON.parse(JSON.stringify(schema)).properties).toEqual({ [PROTO]: { type: "string" } });

    const extracted = checkExtractedArguments(
      JSON.parse('{"__proto__":"eco"}') as unknown,
      plan,
      new Map()
    );
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(hasOwn(extracted.input, PROTO)).toBe(true);
    expect(JSON.stringify(extracted.input)).toBe('{"__proto__":"eco"}');
  });
});
