import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  buildPreparationDefinitionPayload,
  buildPreparationPrompt,
  derivePreparationArguments,
  emptySortMap,
  INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  parsePreparationDraft,
  preparationJobTargets,
  registerIntegrationsRoutes,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  withSortResult,
  type ClassifierPreparationEntry,
  type ClassifierPreparationMap,
  type ClassifierSortMap,
  type ConnectionRow,
  type IntegrationsRepository,
  type PreparationJobTargetsInput
} from "@moss/integrations";
import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
  type IntegrationToolDescriptor
} from "@moss/shared";

const CURATION = { enabledGroups: [], enabledTools: [], mutedTools: [] };

function tool(overrides: Partial<IntegrationToolDescriptor> = {}): IntegrationToolDescriptor {
  return {
    name: "turn_on",
    description: "Turn a light on",
    group: "lights",
    inputSchema: {
      type: "object",
      properties: { light: { type: "string" } },
      required: ["light"]
    },
    ...overrides
  };
}

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    ownerUserId: "user-a",
    name: "Home",
    kind: "mcp",
    transport: "http",
    url: "http://user:pass@example.com/mcp?token=sekret",
    credentialPlacement: { kind: "header", name: "Authorization" },
    hasCredential: true,
    enabled: true,
    baseUrl: "https://internal.example.com",
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: true,
    classifierPreparation: { version: 1, entries: {} },
    classifierSort: { version: 1, entries: {} },
    classifierKeptOutTools: [],
    discoveredTools: [tool()],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

describe("preparation definition payload", () => {
  it("sends only the reviewed definition fields, never secrets or device inventories", () => {
    const poisoned = {
      ...tool(),
      invoke: { method: "POST", path: "/lights", headers: { Authorization: "Bearer sk-live-123" } },
      url: "http://user:pass@example.com/mcp?token=sekret",
      baseUrl: "https://internal.example.com",
      headers: { Authorization: "Bearer sk-live-123" },
      credential: "sk-live-123",
      devices: [{ id: "light.kitchen", name: "Kitchen" }],
      deviceInventory: ["light.kitchen"]
    } as unknown as IntegrationToolDescriptor;

    const payload = buildPreparationDefinitionPayload(poisoned);
    const serialized = JSON.stringify(payload);

    expect(Object.keys(payload).sort()).toEqual([
      "description",
      "destructive",
      "group",
      "idempotent",
      "inputSchema",
      "name",
      "readOnly"
    ]);
    for (const secret of [
      "sk-live-123",
      "Authorization",
      "user:pass",
      "sekret",
      "internal.example.com",
      "invoke",
      "device"
    ]) {
      expect(serialized, `payload must not contain "${secret}"`).not.toContain(secret);
    }
  });

  it("strips credential header parameters and default or example values from the schema", () => {
    const withHeaders = {
      ...tool(),
      inputSchema: {
        type: "object",
        properties: {
          "X-Api-Key": { type: "string", default: "sk-header-secret" },
          body: {
            type: "object",
            properties: {
              token: { type: "string", default: "sk-body-secret", example: "sk-example" }
            }
          }
        },
        required: ["X-Api-Key"]
      },
      invoke: {
        method: "POST",
        path: "/lights",
        params: [{ name: "X-Api-Key", in: "header" }]
      }
    } as unknown as IntegrationToolDescriptor;

    const payload = buildPreparationDefinitionPayload(withHeaders);
    const serialized = JSON.stringify(payload);

    for (const secret of [
      "X-Api-Key",
      "sk-header-secret",
      "sk-body-secret",
      "sk-example",
      "default",
      "example"
    ]) {
      expect(serialized, `payload must not contain "${secret}"`).not.toContain(secret);
    }
    const schema = payload.inputSchema as {
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(["body"]);
    expect(schema.required).toBeUndefined();
  });

  it("wraps the definition as untrusted data with a worked example and a short instruction", () => {
    const prompt = buildPreparationPrompt(
      JSON.stringify(buildPreparationDefinitionPayload(tool()))
    );
    expect(prompt).toContain("UNTRUSTED DATA:");
    expect(prompt).toContain("EXAMPLE");
    const instructions = prompt.split("\n\n")[0] ?? "";
    expect(instructions.split(/\s+/).filter(Boolean).length).toBeLessThan(150);
  });
});

describe("derivePreparationArguments", () => {
  it("takes fixed choices from the schema and extract for the rest, never from prose", () => {
    const args = derivePreparationArguments({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["on", "off"] },
        level: { type: "integer", enum: [1, 2] },
        name: { type: "string" },
        note: { type: "string" }
      },
      required: ["mode", "level", "name"]
    });
    expect(args).toEqual({
      mode: { kind: "enum", values: ["on", "off"] },
      level: { kind: "extract" },
      name: { kind: "extract" }
    });
    expect(args.note).toBeUndefined();
  });

  it("does not declare a credential header parameter as a classifier argument", () => {
    const args = derivePreparationArguments(
      {
        type: "object",
        properties: { "X-Api-Key": { type: "string" }, name: { type: "string" } },
        required: ["X-Api-Key", "name"]
      },
      new Set(["X-Api-Key"])
    );
    expect(args).toEqual({ name: { kind: "extract" } });
  });
});

describe("parsePreparationDraft", () => {
  it("accepts a clean one-line draft", () => {
    expect(
      parsePreparationDraft({ description: "Turn a light on.", replyTemplate: "Turned {summary}" })
    ).toEqual({
      ok: true,
      value: { description: "Turn a light on.", replyTemplate: "Turned {summary}" }
    });
  });

  it("rejects malformed, injected or over-shaped drafts", () => {
    expect(parsePreparationDraft(null).ok).toBe(false);
    expect(parsePreparationDraft({ description: "x", replyTemplate: "two\nlines" }).ok).toBe(false);
    expect(parsePreparationDraft({ description: "x", replyTemplate: "{detail}" }).ok).toBe(false);
    expect(parsePreparationDraft({ description: "x", replyTemplate: "bad } brace" }).ok).toBe(
      false
    );
    expect(
      parsePreparationDraft({
        description: "x",
        replyTemplate: "{summary}",
        arguments: { evil: { kind: "enum", values: ["x"] } }
      }).ok
    ).toBe(false);
    expect(parsePreparationDraft({ description: "", replyTemplate: "x" }).ok).toBe(false);
  });
});

function savedEntry(
  name: string,
  fingerprint: string,
  overrides: Partial<ClassifierPreparationEntry> = {}
): ClassifierPreparationMap {
  const entry: ClassifierPreparationEntry = {
    optIn: true,
    reviewedRisk: "write",
    description: "Turn one light on.",
    arguments: { light: { kind: "extract" } },
    replyTemplate: "Turned the light on.",
    definitionFingerprint: fingerprint,
    reviewedAt: "2026-10-01T00:00:00.000Z",
    preparationVersion: 1,
    ...overrides
  };
  return { version: 1, entries: { [name]: entry } };
}

function failedAt(name: string, fingerprint: string): ClassifierPreparationMap {
  return {
    version: 1,
    entries: {},
    failures: {
      [name]: {
        reason: "provider_error",
        definitionFingerprint: fingerprint,
        failedAt: "2026-10-03T00:00:00.000Z"
      }
    }
  };
}

/** A current sort as write for each tool, made against its present risk inputs. */
function sortedAs(tools: readonly IntegrationToolDescriptor[]): ClassifierSortMap {
  let map = emptySortMap();
  for (const t of tools) {
    map = withSortResult(map, t.name, {
      status: "current",
      risk: "write",
      readableName: "Turn on",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
  }
  return map;
}

/** One unprepared tool, on for chat, not kept out and sorted against its present definition. */
function targetsInput(overrides: Partial<PreparationJobTargetsInput> = {}) {
  const discoveredTools = overrides.discoveredTools ?? [tool()];
  return {
    discoveredTools,
    preparation: { version: 1, entries: {} } as ClassifierPreparationMap,
    sort: sortedAs(discoveredTools as IntegrationToolDescriptor[]),
    keptOut: [],
    curation: CURATION,
    retryFailed: false,
    ...overrides
  } satisfies PreparationJobTargetsInput;
}

function targetNames(overrides: Partial<PreparationJobTargetsInput> = {}): string[] {
  return preparationJobTargets(targetsInput(overrides)).map((t) => t.name);
}

describe("preparationJobTargets", () => {
  it("drafts a sorted tool that is on for chat, not kept out and not yet prepared", () => {
    expect(targetNames()).toEqual(["turn_on"]);
  });

  it("keeps discovered order and drops only the tools that fail a rule", () => {
    const tools = [tool({ name: "a" }), tool({ name: "b" }), tool({ name: "c" })];
    expect(targetNames({ discoveredTools: tools, keptOut: ["b"] })).toEqual(["a", "c"]);
  });

  it("skips tools switched off for ordinary chat", () => {
    expect(targetNames({ curation: { ...CURATION, mutedTools: ["turn_on"] } })).toEqual([]);
  });

  it("skips tools the owner kept out of the classifier", () => {
    expect(targetNames({ keptOut: ["turn_on"] })).toEqual([]);
  });

  it("skips a tool whose sort is missing, failed or made against an older definition", () => {
    const current = tool();
    expect(targetNames({ sort: emptySortMap() })).toEqual([]);

    const failed = withSortResult(emptySortMap(), current.name, {
      status: "failed",
      failure: "error",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(current)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
    expect(targetNames({ sort: failed })).toEqual([]);

    const stale = sortedAs([tool({ description: "An older description" })]);
    expect(targetNames({ sort: stale })).toEqual([]);
  });

  it("skips a tool whose input schema has a root combinator", () => {
    for (const key of ["anyOf", "oneOf", "allOf", "not"]) {
      const combined = tool({ inputSchema: { [key]: [{ type: "object" }] } });
      expect(targetNames({ discoveredTools: [combined] }), key).toEqual([]);
    }
  });

  it("skips a tool already prepared at its present definition and redrafts a changed one", () => {
    const current = tool();
    const fingerprint = toolDefinitionFingerprint(current);
    expect(targetNames({ preparation: savedEntry("turn_on", fingerprint) })).toEqual([]);
    expect(targetNames({ preparation: savedEntry("turn_on", "sha256:older") })).toEqual([
      "turn_on"
    ]);
  });

  it("ignores the old per-tool opt-in and reviewed risk", () => {
    const preparation = savedEntry("turn_on", "sha256:older", { optIn: false, reviewedRisk: null });
    expect(targetNames({ preparation })).toEqual(["turn_on"]);
  });

  it("waits for Try again on a failure at the present definition", () => {
    const fingerprint = toolDefinitionFingerprint(tool());
    const preparation = failedAt("turn_on", fingerprint);
    expect(targetNames({ preparation })).toEqual([]);
    expect(targetNames({ preparation, retryFailed: true })).toEqual(["turn_on"]);
  });

  it("retries on its own a failure made against an older definition", () => {
    const preparation = failedAt("turn_on", "sha256:older");
    expect(targetNames({ preparation })).toEqual(["turn_on"]);
  });
});

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

interface SentJob {
  readonly queue: string;
  readonly payload: unknown;
  readonly options: unknown;
}

function fakeBoss(sent: SentJob[]): PgBoss {
  return {
    send: async (queue: string, payload: unknown, options?: unknown) => {
      sent.push({ queue, payload, options });
      return "job-1";
    }
  } as unknown as PgBoss;
}

function buildServer(
  row: ConnectionRow | null,
  options: { sent?: SentJob[]; writes?: string[]; withBoss?: boolean } = {}
) {
  const server = Fastify();
  const writes = options.writes ?? [];
  const repository = {
    getConnection: async () => row,
    updateConnection: async (_db: unknown, _id: string, patch: Partial<ConnectionRow>) =>
      row === null ? null : { ...row, ...patch },
    saveClassifierToolReview: async () => {
      writes.push("save");
      return { status: "not_found" };
    }
  } as unknown as IntegrationsRepository;
  registerIntegrationsRoutes(server, {
    resolveAccessContext: async (): Promise<AccessContext> => ({
      actorUserId: "user-a",
      requestId: "req-1"
    }),
    dataContext: fakeDataContext(),
    repository,
    cipher: {} as JsonSecretCipher,
    ...(options.withBoss === false ? {} : { boss: fakeBoss(options.sent ?? []) })
  });
  return server;
}

describe("POST /api/integrations/:id/classifier/prepare", () => {
  it("queues one metadata-only preparation job, answers 202 and writes nothing", async () => {
    const sent: SentJob[] = [];
    const writes: string[] = [];
    const server = buildServer(connection(), { sent, writes });
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations/conn-1/classifier/prepare",
      payload: {}
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      disclosure: INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
      status: "ok",
      drafts: [],
      reused: [],
      failed: [],
      remaining: 0
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queue).toBe(INTEGRATION_CLASSIFIER_PREPARE_QUEUE);
    expect(sent[0]!.payload).toEqual({ actorUserId: "user-a", resourceId: "conn-1", op: "retry" });
    expect(writes).toEqual([]);
  });

  it("rejects a non-boolean force and requires the connection switch", async () => {
    const sent: SentJob[] = [];
    const server = buildServer(connection(), { sent });
    const badForce = await server.inject({
      method: "POST",
      url: "/api/integrations/conn-1/classifier/prepare",
      payload: { force: "yes" }
    });
    expect(badForce.statusCode).toBe(400);

    const off = buildServer(connection({ classifierEnabled: false }), { sent });
    const offResponse = await off.inject({
      method: "POST",
      url: "/api/integrations/conn-1/classifier/prepare",
      payload: {}
    });
    expect(offResponse.statusCode).toBe(409);
    expect(sent).toEqual([]);
  });

  it("returns 404 for an unknown or other-owner connection", async () => {
    const sent: SentJob[] = [];
    const server = buildServer(null, { sent });
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations/conn-1/classifier/prepare",
      payload: {}
    });
    expect(response.statusCode).toBe(404);
    expect(sent).toEqual([]);
  });

  it("answers 503 when no job queue is wired", async () => {
    const server = buildServer(connection(), { withBoss: false });
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations/conn-1/classifier/prepare",
      payload: {}
    });
    expect(response.statusCode).toBe(503);
  });
});

describe("PATCH /api/integrations/:id and preparation", () => {
  async function patch(row: ConnectionRow, payload: Record<string, unknown>) {
    const sent: SentJob[] = [];
    const server = buildServer(row, { sent });
    const response = await server.inject({
      method: "PATCH",
      url: "/api/integrations/conn-1",
      payload
    });
    expect(response.statusCode).toBe(200);
    return sent;
  }

  it("queues preparation when a skipped tool is switched on for chat with the switch on", async () => {
    const muted = connection({ mutedTools: ["turn_on"] });
    for (const payload of [
      { mutedTools: [] },
      { enabledTools: ["turn_on"] },
      { enabledGroups: ["lights"] },
      { unsuppressedTools: ["turn_on"] }
    ]) {
      const sent = await patch(muted, payload);
      expect(sent, JSON.stringify(payload)).toEqual([
        {
          queue: INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
          payload: { actorUserId: "user-a", resourceId: "conn-1", op: "prepare" },
          options: { singletonKey: "classifier-prepare:conn-1" }
        }
      ]);
    }
  });

  it("queues no preparation while the switch is off or when nothing about the tools changed", async () => {
    expect(await patch(connection({ classifierEnabled: false }), { mutedTools: [] })).toEqual([]);
    expect(await patch(connection(), { name: "Renamed" })).toEqual([]);
  });
});
