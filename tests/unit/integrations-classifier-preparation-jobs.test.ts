import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  CLASSIFIER_ATTEMPT_LIVE_MS,
  classifierSortView,
  effectiveClassifierTools,
  emptyPreparationMap,
  emptySortMap,
  enqueueClassifierPreparation,
  INTEGRATION_CLASSIFIER_MAX_ARGUMENTS,
  INTEGRATION_CLASSIFIER_MAX_ENTRIES,
  INTEGRATION_CLASSIFIER_MAX_FAILURES,
  INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  parsePreparationMap,
  runClassifierPreparationJob,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  withPreparationEntry,
  withPreparationFailure,
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

/** Read the stored map the way the database read does: through JSON and the defensive parser. */
function readBack(row: ConnectionRow): ConnectionRow {
  return {
    ...row,
    classifierPreparation: parsePreparationMap(
      JSON.parse(JSON.stringify(row.classifierPreparation))
    )
  };
}

/**
 * A repository that applies the job's writes to one in-memory row. Reads go through the stored
 * parser and saves keep the real entry and failure rules, so a write the database would refuse
 * is refused here.
 */
function fakeRepository(initial: ConnectionRow) {
  const state = { row: initial };
  const failures: { toolName: string; failure: ClassifierPreparationFailure }[] = [];
  /** Tools marked as a started call, in order. */
  const marks: string[] = [];
  const repository = {
    getConnection: vi.fn(async (_db: DataContextDb, id: string) =>
      id === state.row.id ? readBack(state.row) : null
    ),
    getConnectionForUpdate: vi.fn(async (_db: DataContextDb, id: string) =>
      id === state.row.id ? readBack(state.row) : null
    ),
    loadCredentialEnvelope: vi.fn(async () => "envelope"),
    saveClassifierToolReview: vi.fn(
      async (_db: DataContextDb, _id: string, toolName: string, input: ReviewedEntryInput) => {
        const entries = state.row.classifierPreparation.entries;
        if (
          !Object.prototype.hasOwnProperty.call(entries, toolName) &&
          Object.keys(entries).length >= INTEGRATION_CLASSIFIER_MAX_ENTRIES
        ) {
          return { status: "too_many" as const };
        }
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
        const next = withPreparationFailure(
          state.row.classifierPreparation,
          state.row.discoveredTools,
          toolName,
          failure
        );
        if (!next) return false;
        if (failure.reason === "interrupted") marks.push(toolName);
        else failures.push({ toolName, failure });
        state.row = {
          ...state.row,
          classifierPreparation: { ...state.row.classifierPreparation, failures: next }
        };
        return true;
      }
    )
  };
  return {
    state: {
      get row() {
        return readBack(state.row);
      }
    },
    failures,
    marks,
    repository: repository as unknown as IntegrationsRepository
  };
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

  it("resends only no-model failures once a model exists, and leaves them while none does", async () => {
    const lamp = discovered("lamp");
    const fan = discovered("fan");
    const failure = (tool: typeof lamp, reason: "no_model" | "provider_error") => ({
      reason,
      definitionFingerprint: toolDefinitionFingerprint(tool),
      failedAt: "2026-10-03T00:00:00.000Z"
    });
    const failedRow = row({
      discoveredTools: [lamp, fan],
      classifierPreparation: {
        ...emptyPreparationMap(),
        failures: { lamp: failure(lamp, "no_model"), fan: failure(fan, "provider_error") }
      }
    });

    const port = fakePort();
    vi.mocked(port.selectDefaultChatModel).mockResolvedValue(null);
    const waiting = await run(failedRow, "model_ready", port);
    expect(waiting.outcome).toEqual({ status: "no_model" });
    expect(waiting.failures).toEqual([]);

    const resumed = await run(failedRow, "model_ready");
    expect(resumed.outcome).toEqual({ status: "prepared", prepared: 1, failed: 0 });
    expect(sentPrompts(resumed.port).map((prompt) => prompt.includes("lamp"))).toEqual([true]);
  });

  it("stops after a provider failure and records the rest as failed with it", async () => {
    const port = fakePort();
    port.runStructuredDraft.mockResolvedValue({ ok: false, error: "provider_error" });
    const tools = [discovered("a_tool"), discovered("b_tool"), discovered("c_tool")];
    const first = await run(row({ discoveredTools: tools }), "prepare", port);
    expect(first.outcome).toEqual({ status: "stopped", prepared: 0, failed: 3 });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
    expect(first.failures.map((f) => `${f.toolName}:${f.failure.reason}`)).toEqual([
      "a_tool:provider_error",
      "b_tool:provider_error",
      "c_tool:provider_error"
    ]);

    // Nothing resends them automatically; Try again resends every one.
    const automatic = await run(first.state.row, "prepare", port);
    expect(automatic.outcome).toEqual({ status: "nothing_to_prepare" });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);

    const retried = await run(first.state.row, "retry");
    expect(retried.outcome).toEqual({ status: "prepared", prepared: 3, failed: 0 });
    expect(retried.port.runStructuredDraft).toHaveBeenCalledTimes(3);
  });

  it("records a tool whose entry could never be stored, before any model call", async () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index <= INTEGRATION_CLASSIFIER_MAX_ARGUMENTS; index += 1) {
      properties[`field_${index}`] = { type: "string" };
    }
    const wide = discovered("wide", {
      inputSchema: { type: "object", properties, required: Object.keys(properties) }
    });
    const first = await run(row({ discoveredTools: [wide] }));
    expect(first.outcome).toEqual({ status: "prepared", prepared: 0, failed: 1 });
    expect(first.port.runStructuredDraft).not.toHaveBeenCalled();
    expect(first.failures.map((f) => f.failure.reason)).toEqual(["unsupported_shape"]);

    const again = await run(first.state.row);
    expect(again.outcome).toEqual({ status: "nothing_to_prepare" });
    expect(again.port.runStructuredDraft).not.toHaveBeenCalled();
  });

  it("saves an entry that survives the stored read", async () => {
    const { state } = await run(row());
    const stored = parsePreparationMap(JSON.parse(JSON.stringify(state.row.classifierPreparation)));
    expect(stored.entries.turn_on).toMatchObject({
      description: "Turn one light on",
      replyTemplate: "{summary}",
      definitionFingerprint: toolDefinitionFingerprint(discovered("turn_on"))
    });
  });

  it("records every tool past the preparation limit without paying for a draft", async () => {
    const tools = Array.from({ length: INTEGRATION_CLASSIFIER_MAX_ENTRIES + 2 }, (_, index) =>
      discovered(`tool_${index}`)
    );
    let preparation = emptyPreparationMap();
    for (const tool of tools.slice(0, INTEGRATION_CLASSIFIER_MAX_ENTRIES)) {
      preparation = withPreparationEntry(preparation, tool.name, {
        optIn: true,
        reviewedRisk: null,
        description: "Prepared",
        arguments: {},
        replyTemplate: "{summary}",
        definitionFingerprint: toolDefinitionFingerprint(tool),
        reviewedAt: "2026-10-03T00:00:00.000Z",
        preparationVersion: 1
      });
    }
    const full = row({
      discoveredTools: tools,
      classifierPreparation: preparation,
      enabledGroups: ["lights"]
    });

    const first = await run(full);
    expect(first.port.runStructuredDraft).not.toHaveBeenCalled();
    expect(first.outcome).toEqual({ status: "prepared", prepared: 0, failed: 2 });
    expect(first.failures.map((f) => [f.toolName, f.failure.reason])).toEqual([
      ["tool_200", "too_many_tools"],
      ["tool_201", "too_many_tools"]
    ]);

    const again = await run(first.state.row);
    expect(again.outcome).toEqual({ status: "nothing_to_prepare" });
    expect(again.port.runStructuredDraft).not.toHaveBeenCalled();
  });

  it("drops failures that can no longer block a run to remember a new one", async () => {
    const removed = Array.from({ length: INTEGRATION_CLASSIFIER_MAX_FAILURES }, (_, index) =>
      discovered(`removed_${index}`)
    );
    const stale: Record<string, ClassifierPreparationFailure> = {};
    for (const tool of removed) {
      stale[tool.name] = {
        reason: "invalid_draft",
        definitionFingerprint: toolDefinitionFingerprint(tool),
        failedAt: "2026-10-03T00:00:00.000Z"
      };
    }
    const full = row({
      classifierPreparation: { ...emptyPreparationMap(), failures: stale }
    });
    const port = fakePort();
    port.runStructuredDraft.mockResolvedValue({ ok: false, error: "provider_error" });

    const first = await run(full, "prepare", port);
    expect(first.outcome).toEqual({ status: "stopped", prepared: 0, failed: 1 });
    expect(Object.keys(first.state.row.classifierPreparation.failures ?? {})).toEqual(["turn_on"]);

    const again = await run(first.state.row, "prepare", port);
    expect(again.outcome).toEqual({ status: "nothing_to_prepare" });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
  });

  it("makes no model call when a failure for the tool could not be remembered", async () => {
    const failedBefore = Array.from({ length: INTEGRATION_CLASSIFIER_MAX_FAILURES }, (_, index) =>
      discovered(`failed_${index}`)
    );
    const current: Record<string, ClassifierPreparationFailure> = {};
    for (const tool of failedBefore) {
      current[tool.name] = {
        reason: "invalid_draft",
        definitionFingerprint: toolDefinitionFingerprint(tool),
        failedAt: "2026-10-03T00:00:00.000Z"
      };
    }
    const full = row({
      discoveredTools: [...failedBefore, discovered("turn_on")],
      classifierPreparation: { ...emptyPreparationMap(), failures: current },
      classifierSort: sortedAs([discovered("turn_on")]),
      enabledGroups: ["lights"]
    });

    const { outcome, port } = await run(full);
    expect(outcome).toEqual({ status: "failure_history_full", prepared: 0, failed: 0 });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
  });

  it("records no_model on every target when no default chat model is set", async () => {
    const port = fakePort();
    vi.mocked(port.selectDefaultChatModel).mockResolvedValue(null);
    const tools = [discovered("a_tool"), discovered("b_tool")];
    const { outcome, failures } = await run(row({ discoveredTools: tools }), "prepare", port);
    expect(outcome).toEqual({ status: "no_model" });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
    expect(failures.map((f) => `${f.toolName}:${f.failure.reason}`)).toEqual([
      "a_tool:no_model",
      "b_tool:no_model"
    ]);
  });

  it("records no_model when the default chat model cannot draft", async () => {
    const port = fakePort();
    vi.mocked(port.selectDefaultChatModel).mockResolvedValue({
      model: { id: "m1", providerConfigId: "p1", providerKind: "kind", providerModelId: "model" },
      structured: false
    });
    const { outcome, failures } = await run(row(), "prepare", port);
    expect(outcome).toEqual({ status: "no_model" });
    expect(port.runStructuredDraft).not.toHaveBeenCalled();
    expect(failures.map((f) => f.failure.reason)).toEqual(["no_model"]);
  });
});

describe("a preparation call that started", () => {
  const started = new Date("2026-10-04T00:00:00.000Z");

  /** One sorted tool whose preparation failed for want of a model. */
  function noModelFake() {
    const lamp = discovered("lamp");
    return fakeRepository(
      row({
        discoveredTools: [lamp],
        classifierPreparation: {
          ...emptyPreparationMap(),
          failures: {
            lamp: {
              reason: "no_model",
              definitionFingerprint: toolDefinitionFingerprint(lamp),
              failedAt: "2026-10-03T00:00:00.000Z"
            }
          }
        }
      })
    );
  }

  function runOn(
    fake: ReturnType<typeof fakeRepository>,
    op: ClassifierPreparationJobOp,
    port: ReturnType<typeof fakePort>,
    at = started
  ) {
    return runClassifierPreparationJob(
      { dataContext, port, cipherSources: { cipher }, repository: fake.repository, now: () => at },
      ACCESS,
      fake.state.row.id,
      op
    );
  }

  it("is not resent by a model being added after the provider call was cut off", async () => {
    const fake = noModelFake();
    const port = fakePort();
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    port.runStructuredDraft.mockRejectedValueOnce(aborted);
    await expect(runOn(fake, "model_ready", port)).rejects.toThrow("aborted");
    expect(await runOn(fake, "model_ready", port)).toEqual({ status: "nothing_to_prepare" });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
    expect(fake.marks).toEqual(["lamp"]);
  });

  it("is not resent when its result could not be saved", async () => {
    const fake = noModelFake();
    const port = fakePort();
    vi.mocked(fake.repository.saveClassifierToolReview).mockRejectedValueOnce(
      new Error("connection lost")
    );
    await expect(runOn(fake, "model_ready", port)).rejects.toThrow("connection lost");
    expect(await runOn(fake, "model_ready", port)).toEqual({ status: "nothing_to_prepare" });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps a run that starts meanwhile from sending the same tool", async () => {
    const fake = noModelFake();
    const port = fakePort();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    port.runStructuredDraft.mockImplementationOnce(async () => {
      await held;
      return {
        ok: true as const,
        object: { description: "Turn one light on", replyTemplate: "{summary}" },
        usage: { inputTokens: 1, outputTokens: 1 }
      };
    });
    const retry = runOn(fake, "retry", port);
    await vi.waitFor(() => expect(port.runStructuredDraft).toHaveBeenCalledTimes(1));
    expect(await runOn(fake, "model_ready", port)).toEqual({ status: "nothing_to_prepare" });
    expect(await runOn(fake, "retry", port)).toEqual({ status: "nothing_to_prepare" });
    release();
    expect(await retry).toEqual({ status: "prepared", prepared: 1, failed: 0 });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["was cut off", false],
    ["was prepared", true]
  ] as const)(
    "keeps an older run that found no model from undoing a call that %s",
    async (_label, prepared) => {
      const fake = noModelFake();
      const port = fakePort();
      if (!prepared) {
        const aborted = new Error("The operation was aborted");
        aborted.name = "AbortError";
        port.runStructuredDraft.mockRejectedValueOnce(aborted);
      }

      // The older run reads its targets and finds no model, but its no_model save waits on the
      // row while a newer run claims the tool and calls the provider.
      const save = vi.mocked(fake.repository.saveClassifierPreparationFailure);
      const apply = save.getMockImplementation()!;
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      save.mockImplementationOnce(async (...args) => {
        await held;
        return apply(...args);
      });
      const olderPort = fakePort();
      vi.mocked(olderPort.selectDefaultChatModel).mockResolvedValue(null);
      const older = runOn(fake, "retry", olderPort);
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      const newer = runOn(fake, "model_ready", port);
      if (!prepared) await expect(newer).rejects.toThrow("aborted");
      else expect(await newer).toEqual({ status: "prepared", prepared: 1, failed: 0 });
      expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);

      release();
      expect(await older).toEqual({ status: "no_model" });
      const stored = fake.state.row.classifierPreparation;
      expect(stored.failures?.lamp?.reason).toBe("interrupted");
      expect(Object.keys(stored.entries)).toEqual(prepared ? ["lamp"] : []);
      expect(await runOn(fake, "model_ready", port)).toEqual({ status: "nothing_to_prepare" });
      expect(port.runStructuredDraft).toHaveBeenCalledTimes(1);
    }
  );

  it("shows as preparing while it may run, then as a failure only Try again resends", async () => {
    const fake = noModelFake();
    const port = fakePort();
    port.runStructuredDraft.mockRejectedValueOnce(new Error("worker stopped"));
    await expect(runOn(fake, "model_ready", port)).rejects.toThrow("worker stopped");

    const running = new Date(started.getTime() + CLASSIFIER_ATTEMPT_LIVE_MS - 1);
    expect(classifierSortView(fake.state.row, { now: running })[0]).toMatchObject({
      classifierState: "preparing",
      preparationFailure: null
    });

    const over = new Date(started.getTime() + CLASSIFIER_ATTEMPT_LIVE_MS);
    expect(classifierSortView(fake.state.row, { now: over })[0]).toMatchObject({
      classifierState: "failed",
      preparationFailure: "provider_error"
    });
    expect(await runOn(fake, "model_ready", port, over)).toEqual({ status: "nothing_to_prepare" });
    expect(await runOn(fake, "prepare", port, over)).toEqual({ status: "nothing_to_prepare" });
    expect(await runOn(fake, "retry", port, over)).toEqual({
      status: "prepared",
      prepared: 1,
      failed: 0
    });
    expect(port.runStructuredDraft).toHaveBeenCalledTimes(2);
  });
});
