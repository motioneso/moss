import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  effectiveClassifierTools,
  emptyPreparationMap,
  emptySortMap,
  enqueueClassifierPreparation,
  INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  runClassifierPreparationJob,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  withPreparationEntry,
  withSortResult,
  type ClassifierPreparationFailure,
  type ClassifierPreparationJobOp,
  type ClassifierPreparationPort,
  type ClassifierSortMap,
  type ConnectionRow,
  type DiscoveredTool,
  type IntegrationsRepository,
  type ReviewedEntryInput
} from "@moss/integrations";

/*
 * The background preparation job (#2984 R2.4), run against an in-memory connection row. The job's
 * database writes go through the repository, so a fake repository that applies them to the row is
 * enough to see what the job decides.
 */

const CREDENTIAL = "s3cr3t-token-value";
const ACCESS: AccessContext = { actorUserId: "owner-1", requestId: "req-1" };

function discovered(name: string, overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: `Run ${name}`,
    group: "lights",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    ...overrides
  } as DiscoveredTool;
}

function sortedAs(tools: readonly DiscoveredTool[]): ClassifierSortMap {
  let map = emptySortMap();
  for (const tool of tools) {
    map = withSortResult(map, tool.name, {
      status: "current",
      risk: "write",
      readableName: "Run it",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
  }
  return map;
}

function row(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  const tools = overrides.discoveredTools ?? [discovered("turn_on")];
  return {
    id: "conn-1",
    ownerUserId: "owner-1",
    name: "Home",
    kind: "mcp",
    transport: "http",
    url: "https://example.invalid/mcp",
    credentialPlacement: null,
    hasCredential: true,
    enabled: true,
    baseUrl: null,
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: true,
    classifierPreparation: emptyPreparationMap(),
    classifierSort: sortedAs(tools),
    classifierKeptOutTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
    discoveredTools: tools
  };
}

/** A repository that applies the job's writes to one in-memory row. */
function fakeRepository(initial: ConnectionRow) {
  const state = { row: initial };
  const failures: { toolName: string; failure: ClassifierPreparationFailure }[] = [];
  const repository = {
    getConnection: vi.fn(async (_db: DataContextDb, id: string) =>
      id === state.row.id ? state.row : null
    ),
    loadCredentialEnvelope: vi.fn(async () => "envelope"),
    saveClassifierToolReview: vi.fn(
      async (_db: DataContextDb, _id: string, toolName: string, input: ReviewedEntryInput) => {
        state.row = {
          ...state.row,
          classifierPreparation: withPreparationEntry(state.row.classifierPreparation, toolName, {
            optIn: input.optIn,
            reviewedRisk: input.reviewedRisk,
            description: input.description,
            arguments: input.arguments,
            replyTemplate: input.replyTemplate,
            definitionFingerprint: input.reviewedFingerprint,
            reviewedAt: "2026-10-04T00:00:00.000Z",
            preparationVersion: 1
          })
        };
        return { status: "saved" as const, connection: state.row };
      }
    ),
    saveClassifierPreparationFailure: vi.fn(
      async (
        _db: DataContextDb,
        _id: string,
        toolName: string,
        failure: ClassifierPreparationFailure
      ) => {
        failures.push({ toolName, failure });
        state.row = {
          ...state.row,
          classifierPreparation: {
            ...state.row.classifierPreparation,
            failures: { ...state.row.classifierPreparation.failures, [toolName]: failure }
          }
        };
        return true;
      }
    )
  };
  return { state, failures, repository: repository as unknown as IntegrationsRepository };
}

function fakePort(): ClassifierPreparationPort & {
  runStructuredDraft: ReturnType<typeof vi.fn>;
} {
  return {
    selectDefaultChatModel: vi.fn(async () => ({
      model: { id: "m1", providerConfigId: "p1", providerKind: "kind", providerModelId: "model" },
      structured: true
    })),
    runStructuredDraft: vi.fn(async () => ({
      ok: true as const,
      object: { description: "Turn one light on", replyTemplate: "{summary}" },
      usage: { inputTokens: 1, outputTokens: 1 }
    }))
  };
}

const dataContext = {
  withDataContext: async <T>(_ctx: AccessContext, fn: (db: DataContextDb) => Promise<T>) =>
    fn({} as DataContextDb)
} as unknown as DataContextRunner;

const cipher = {
  parseEnvelope: (value: unknown) => value,
  decryptJson: () => ({ secret: CREDENTIAL })
} as unknown as JsonSecretCipher;

async function run(
  initial: ConnectionRow,
  op: ClassifierPreparationJobOp = "prepare",
  port = fakePort()
) {
  const fake = fakeRepository(initial);
  const outcome = await runClassifierPreparationJob(
    {
      dataContext,
      port,
      cipherSources: { cipher },
      repository: fake.repository,
      now: () => new Date("2026-10-04T00:00:00.000Z")
    },
    ACCESS,
    initial.id,
    op
  );
  return { outcome, port, ...fake };
}

function sentPrompts(port: ReturnType<typeof fakePort>): string[] {
  return port.runStructuredDraft.mock.calls.map((call) => (call[1] as { prompt: string }).prompt);
}

describe("preparation job payloads", () => {
  it("carry the owner id, the connection id and the job kind only", async () => {
    const send = vi.fn(async () => "job-1");
    await enqueueClassifierPreparation({ send } as never, "owner-1", "conn-1", "retry");
    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = send.mock.calls[0] as unknown as [string, object, object];
    expect(queue).toBe(INTEGRATION_CLASSIFIER_PREPARE_QUEUE);
    expect(payload).toEqual({ actorUserId: "owner-1", resourceId: "conn-1", op: "retry" });
    expect(options).toEqual({ singletonKey: "classifier-retry:conn-1" });
  });
});

describe("runClassifierPreparationJob", () => {
  it("prepares every sorted tool that is on and saves it so the tool becomes eligible", async () => {
    const tools = [discovered("turn_on"), discovered("turn_off")];
    const { outcome, state } = await run(row({ discoveredTools: tools }));
    expect(outcome).toEqual({ status: "prepared", prepared: 2, failed: 0 });
    expect(effectiveClassifierTools(state.row).map((t) => t.tool.name)).toEqual([
      "turn_on",
      "turn_off"
    ]);
  });

  it("skips kept-out, switched-off and unsorted tools", async () => {
    const tools = [discovered("kept"), discovered("muted"), discovered("unsorted")];
    const { outcome, port } = await run(
      row({
        discoveredTools: tools,
        classifierKeptOutTools: ["kept"],
        mutedTools: ["muted"],
        classifierSort: sortedAs(tools.slice(0, 2))
      })
    );
    expect(outcome).toEqual({ status: "nothing_to_prepare" });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
  });

  it("does nothing while the classifier switch is off", async () => {
    const { outcome, port } = await run(row({ classifierEnabled: false }));
    expect(outcome).toEqual({ status: "switched_off" });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
  });

  it("re-prepares a changed tool by itself, and the tool is eligible again", async () => {
    const before = discovered("turn_on");
    const after = discovered("turn_on", { description: "Turn a light on, now with a fade" });
    const prepared = withPreparationEntry(emptyPreparationMap(), "turn_on", {
      optIn: true,
      reviewedRisk: null,
      description: "Turn one light on",
      arguments: {},
      replyTemplate: "{summary}",
      definitionFingerprint: toolDefinitionFingerprint(before),
      reviewedAt: "2026-10-03T00:00:00.000Z",
      preparationVersion: 1
    });
    const changed = row({ discoveredTools: [after], classifierPreparation: prepared });
    expect(effectiveClassifierTools(changed)).toEqual([]);

    const { outcome, state } = await run(changed);
    expect(outcome).toEqual({ status: "prepared", prepared: 1, failed: 0 });
    expect(state.row.classifierPreparation.entries.turn_on?.definitionFingerprint).toBe(
      toolDefinitionFingerprint(after)
    );
    expect(effectiveClassifierTools(state.row).map((t) => t.tool.name)).toEqual(["turn_on"]);
  });

  it("never sends a tool whose text holds the stored credential, in any encoded form", async () => {
    const base64 = Buffer.from(CREDENTIAL, "utf8").toString("base64");
    const tools = [
      discovered("plain", { description: `Use token ${CREDENTIAL}` }),
      discovered("encoded", {
        inputSchema: {
          type: "object",
          properties: { auth: { type: "string", description: `Bearer ${base64}` } }
        }
      }),
      discovered("clean")
    ];
    const { outcome, port, failures, state } = await run(row({ discoveredTools: tools }));

    expect(outcome).toEqual({ status: "prepared", prepared: 1, failed: 2 });
    for (const prompt of sentPrompts(port)) {
      expect(prompt).not.toContain(CREDENTIAL);
      expect(prompt).not.toContain(base64);
    }
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
    expect(failures.map((f) => [f.toolName, f.failure.reason])).toEqual([
      ["plain", "unsafe"],
      ["encoded", "unsafe"]
    ]);
    expect(effectiveClassifierTools(state.row).map((t) => t.tool.name)).toEqual(["clean"]);
  });

  it("leaves a failed tool for Try again instead of retrying it automatically", async () => {
    const tool = discovered("turn_on");
    const failedRow = row({
      discoveredTools: [tool],
      classifierPreparation: {
        ...emptyPreparationMap(),
        failures: {
          turn_on: {
            reason: "provider_error",
            definitionFingerprint: toolDefinitionFingerprint(tool),
            failedAt: "2026-10-03T00:00:00.000Z"
          }
        }
      }
    });
    const automatic = await run(failedRow, "prepare");
    expect(automatic.outcome).toEqual({ status: "nothing_to_prepare" });
    expect(automatic.port.runStructuredDraft).not.toHaveBeenCalled();

    const retried = await run(failedRow, "retry");
    expect(retried.outcome).toEqual({ status: "prepared", prepared: 1, failed: 0 });
  });

  it("stops after a provider failure so the rest are not charged for the same error", async () => {
    const port = fakePort();
    port.runStructuredDraft.mockResolvedValue({ ok: false, error: "provider_error" });
    const tools = [discovered("a_tool"), discovered("b_tool")];
    const { outcome, failures } = await run(row({ discoveredTools: tools }), "prepare", port);
    expect(outcome).toEqual({ status: "stopped", prepared: 0, failed: 1 });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
    expect(failures.map((f) => f.failure.reason)).toEqual(["provider_error"]);
  });

  it("makes no model call when no default chat model can draft", async () => {
    const port = fakePort();
    vi.mocked(port.selectDefaultChatModel).mockResolvedValue(null);
    const { outcome } = await run(row(), "prepare", port);
    expect(outcome).toEqual({ status: "no_model" });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
  });
});
