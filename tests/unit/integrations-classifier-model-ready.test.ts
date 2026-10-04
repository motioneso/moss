// A tool that failed for want of a model resumes on its own once the owner adds one, and the
// connection page stops saying the model is missing (#2984 R2.5b).
import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  emptySortMap,
  INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  INTEGRATION_CLASSIFIER_SORT_QUEUE,
  registerIntegrationsRoutes,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  withSortResult,
  type ClassifierPreparationFailureReason,
  type ClassifierPreparationPort,
  type ClassifierSortMap,
  type ConnectionRow,
  type DiscoveredTool,
  type IntegrationsRepository
} from "@moss/integrations";
import type { IntegrationDetail } from "@moss/shared";

const FAILED_AT = "2026-10-03T00:00:00.000Z";

function tool(name: string): DiscoveredTool {
  return {
    name,
    description: `Does ${name}`,
    group: "Home",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  };
}

const lamp = tool("lamp");
const fan = tool("fan");
const door = tool("door");

function sortFailed(map: ClassifierSortMap, t: DiscoveredTool, failure: "no_model" | "error") {
  return withSortResult(map, t.name, {
    status: "failed",
    failure,
    sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
    sortedAt: FAILED_AT
  })!;
}

function sortCurrent(map: ClassifierSortMap, t: DiscoveredTool) {
  return withSortResult(map, t.name, {
    status: "current",
    risk: "read",
    readableName: t.name,
    sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
    sortedAt: FAILED_AT
  })!;
}

function prepFailure(t: DiscoveredTool, reason: ClassifierPreparationFailureReason) {
  return { reason, definitionFingerprint: toolDefinitionFingerprint(t), failedAt: FAILED_AT };
}

/**
 * The lamp's sort failed for want of a model, the fan's preparation did, and the door's
 * preparation failed at the provider.
 */
function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    ownerUserId: "user-a",
    name: "Home",
    kind: "mcp",
    transport: "http",
    url: "https://home.example/mcp",
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
    classifierPreparation: {
      version: 1,
      entries: {},
      failures: { fan: prepFailure(fan, "no_model"), door: prepFailure(door, "provider_error") }
    },
    classifierSort: sortCurrent(
      sortCurrent(sortFailed(emptySortMap(), lamp, "no_model"), fan),
      door
    ),
    classifierKeptOutTools: [],
    discoveredTools: [lamp, fan, door],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function modelSelector(structured: boolean | null) {
  return {
    selectDefaultChatModel: vi.fn<ClassifierPreparationPort["selectDefaultChatModel"]>(async () =>
      structured === null
        ? null
        : {
            model: { id: "m1", providerConfigId: "p1", providerKind: "k", providerModelId: "m" },
            structured
          }
    )
  };
}

async function open(row: ConnectionRow, selector: ReturnType<typeof modelSelector>) {
  const sent: { queue: string; payload: unknown }[] = [];
  const server = Fastify();
  registerIntegrationsRoutes(server, {
    resolveAccessContext: async (): Promise<AccessContext> => ({
      actorUserId: "user-a",
      requestId: "req-1"
    }),
    dataContext: {
      withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
    } as unknown as DataContextRunner,
    repository: { getConnection: async () => row } as unknown as IntegrationsRepository,
    cipher: {} as JsonSecretCipher,
    boss: {
      send: async (queue: string, payload: unknown) => {
        sent.push({ queue, payload });
        return "job-1";
      }
    } as unknown as PgBoss,
    modelSelector: selector
  });
  const response = await server.inject({ method: "GET", url: "/api/integrations/conn-1" });
  expect(response.statusCode).toBe(200);
  const detail = response.json<IntegrationDetail>();
  const states = Object.fromEntries(
    detail.classifierTools.map((t) => [t.toolName, [t.classifierState, t.preparationFailure]])
  );
  return { sent, states };
}

describe("opening a connection after a model is added", () => {
  it("resumes only the no-model failures and shows them preparing", async () => {
    const { sent, states } = await open(connection(), modelSelector(true));
    expect(sent).toEqual([
      {
        queue: INTEGRATION_CLASSIFIER_SORT_QUEUE,
        payload: { actorUserId: "user-a", resourceId: "conn-1", op: "model_ready" }
      },
      {
        queue: INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
        payload: { actorUserId: "user-a", resourceId: "conn-1", op: "model_ready" }
      }
    ]);
    expect(states).toEqual({
      lamp: ["preparing", null],
      fan: ["preparing", null],
      // A provider failure cost money, so it still waits for Try again.
      door: ["failed", "provider_error"]
    });
  });

  it("keeps saying the model is missing while none can sort", async () => {
    for (const structured of [null, false]) {
      const { sent, states } = await open(connection(), modelSelector(structured));
      expect(sent).toEqual([]);
      expect(states.lamp).toEqual(["failed", "no_model"]);
      expect(states.fan).toEqual(["failed", "no_model"]);
    }
  });

  it("does not look up the model when no failure was for want of one", async () => {
    const selector = modelSelector(true);
    const row = connection({
      classifierSort: sortCurrent(
        sortCurrent(sortFailed(emptySortMap(), lamp, "error"), fan),
        door
      ),
      classifierPreparation: {
        version: 1,
        entries: {},
        failures: { door: prepFailure(door, "provider_error") }
      }
    });
    const { sent } = await open(row, selector);
    expect(sent).toEqual([]);
    expect(selector.selectDefaultChatModel).not.toHaveBeenCalled();
  });

  it("resumes a no-model sort failure while the classifier is off, but not preparation", async () => {
    const { sent, states } = await open(
      connection({ classifierEnabled: false }),
      modelSelector(true)
    );
    expect(sent.map((job) => job.queue)).toEqual([INTEGRATION_CLASSIFIER_SORT_QUEUE]);
    expect(states.lamp).toEqual(["off", null]);
  });
});
