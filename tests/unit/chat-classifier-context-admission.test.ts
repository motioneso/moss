import { describe, expect, it, vi } from "vitest";

import type { AssistantToolGateway, ClassifierChoiceResult, ClassifierHandle } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { CLASSIFIER_LIMITS, type ModuleAssistantToolManifest } from "@moss/module-sdk";

import {
  ClassifierGate,
  type ClassifierGatePorts,
  type GateMode
} from "../../packages/chat/src/live/classifier-gate.js";
import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";
import { admissionModule, deferred } from "./helpers/gateway-admission-fixture.js";

const STORED_ID = "stored-resource-id";
const STORED_LABEL = "Stored candidate label";
const OUTSIDE_AREA = "Remote area label";
const OUTSIDE_DESCRIPTION = "Remote classifier description";
const TOKEN = "session-token";
const candidates = [{ id: STORED_ID, label: STORED_LABEL }];

function pick(choice: string): ClassifierChoiceResult {
  return {
    ok: true,
    choice,
    confidence: 0.99,
    lead: 0.98,
    probabilities: { [choice]: 0.99, none: 0.01 },
    runnerUp: { choice: "none", probability: 0.01 },
    usage: { inputTokens: 1, outputTokens: 1 }
  };
}

function harness(
  options: {
    raw?: unknown;
    isExternal?: boolean;
    unstamped?: boolean;
    extract?: boolean;
    tools?: (tool: ModuleAssistantToolManifest) => readonly ModuleAssistantToolManifest[];
  } = {}
) {
  let connectionHeld = false;
  const events: string[] = [];
  const candidateHook = vi.fn(async () => {
    events.push("hook");
    return options.raw === undefined ? candidates : options.raw;
  });
  const tool: ModuleAssistantToolManifest = {
    name: "example.change",
    description: "Remote tool description",
    permissionId: "example.use",
    risk: "write",
    ...(options.unstamped ? {} : { isExternal: options.isExternal ?? false }),
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Remote schema description" },
        ...(options.extract ? { title: { type: "string", maxLength: 100 } } : {})
      },
      required: options.extract ? ["device", "title"] : ["device"],
      additionalProperties: false
    },
    outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    classifier: {
      description: OUTSIDE_DESCRIPTION,
      arguments: {
        device: { kind: "candidates" },
        ...(options.extract ? { title: { kind: "extract" as const } } : {})
      },
      candidates: candidateHook as never,
      replyTemplate: "{summary}"
    },
    execute: vi.fn(async () => ({ data: {} }))
  };
  const dataContext = {
    withDataContext: async (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) => {
      if (connectionHeld) throw new Error("single connection is already held");
      connectionHeld = true;
      try {
        return await work({} as DataContextDb);
      } finally {
        connectionHeld = false;
        events.push("release");
      }
    }
  } as unknown as DataContextRunner;
  const recordContextForSession = vi.fn<AssistantToolGateway["recordContextForSession"]>(
    async (_token, path) => {
      expect(connectionHeld).toBe(false);
      events.push(`admit:${path}`);
    }
  );
  const callToolForGate = vi.fn<AssistantToolGateway["callToolForGate"]>(async () => ({
    kind: "would_run",
    approvalMode: "auto"
  }));
  const ports = createClassifierGatePortsFactory({
    dataContext,
    resolveActiveModules: async () => [
      { ...admissionModule(options.tools?.(tool) ?? [tool]), name: OUTSIDE_AREA }
    ],
    classifierDeps: {} as never,
    gateway: { recordContextForSession, callToolForGate }
  })("actor-a", TOKEN, "non-secret-correlation");
  const handle = { model: { id: "fixture" }, capability: "typed_extraction" } as ClassifierHandle;
  const choose = vi.fn<ClassifierGatePorts["classifier"]["choose"]>(async (_handle, input) => {
    const criteria = input.question.criteria;
    return pick("example" in criteria ? "example" : tool.name in criteria ? tool.name : STORED_ID);
  });
  const extract = vi.fn<ClassifierGatePorts["classifier"]["extract"]>(async () => ({
    ok: true,
    values: { device: STORED_ID, title: "Requested title" },
    usage: { inputTokens: 1, outputTokens: 1 }
  }));
  const gate = new ClassifierGate({
    ...ports,
    classifier: { resolve: async () => handle, choose, extract },
    now: () => 0
  });
  const evaluate = (mode: GateMode = "on") =>
    gate.evaluate({
      actorUserId: "actor-a",
      threadId: "thread-a",
      message: "Change the requested device",
      hasAttachment: false,
      incognito: false,
      mode
    });
  return {
    ports,
    tool,
    events,
    candidateHook,
    recordContextForSession,
    callToolForGate,
    choose,
    extract,
    evaluate
  };
}

describe("classifier descriptor admission", () => {
  it.each([true, undefined])(
    "records external or unstamped tools before exposing the menu (%s)",
    async (stamp) => {
      const h = harness({ isExternal: stamp, unstamped: stamp === undefined });
      const admission = deferred();
      h.recordContextForSession.mockImplementation(async () => admission.promise);
      let exposed = false;
      const pending = h.ports.listTools().then((tools) => {
        exposed = true;
        return tools;
      });
      await vi.waitFor(() => expect(h.recordContextForSession).toHaveBeenCalledOnce());
      expect(exposed).toBe(false);
      expect(h.recordContextForSession).toHaveBeenCalledExactlyOnceWith(
        TOKEN,
        "tool_external_descriptors"
      );
      admission.resolve();
      const [listed] = await pending;
      expect(listed).toMatchObject({
        moduleDescription: OUTSIDE_AREA,
        classifier: { description: OUTSIDE_DESCRIPTION }
      });
      expect(listed?.inputSchema).toEqual(h.tool.inputSchema);
      expect(listed).not.toHaveProperty("isExternal");
    }
  );

  it("leaves built-in-only and non-classifier external menus clean", async () => {
    const h = harness({
      tools: (tool) => [
        tool,
        { ...tool, name: "external.noClassifier", isExternal: true, classifier: undefined },
        { ...tool, name: "external.noHandler", isExternal: true, execute: undefined }
      ]
    });
    expect(await h.ports.listTools()).toHaveLength(1);
    expect(h.recordContextForSession).not.toHaveBeenCalled();
    const empty = harness({ tools: () => [] });
    expect(await empty.ports.listTools()).toEqual([]);
    expect(empty.recordContextForSession).not.toHaveBeenCalled();
  });

  it.each(["on", "shadow"] as const)(
    "failed descriptor admission prevents every classifier call (%s)",
    async (mode) => {
      const h = harness({ isExternal: true });
      h.recordContextForSession.mockRejectedValue(new Error("private storage failure"));
      const result = await h.evaluate(mode);
      expect(result).toMatchObject({ kind: "declined", reason: "classifier_error" });
      expect(h.choose).not.toHaveBeenCalled();
      expect(h.extract).not.toHaveBeenCalled();
      expect(h.candidateHook).not.toHaveBeenCalled();
      expect(h.callToolForGate).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private storage failure");
    }
  );
});

describe("classifier candidate admission", () => {
  it("releases the candidate hook connection before admission and returns only a normalized snapshot", async () => {
    const raw = [{ ...candidates[0]!, untrustedExtra: "Do not retain this field" }];
    const h = harness({ raw });
    const [tool] = await h.ports.listTools();
    const admission = deferred();
    const record = h.recordContextForSession.getMockImplementation()!;
    h.recordContextForSession.mockImplementation(async (token, path) => {
      await record(token, path);
      await admission.promise;
    });
    let exposed = false;
    const pending = h.ports.loadCandidates(tool!, new AbortController().signal).then((value) => {
      exposed = true;
      return value;
    });
    await vi.waitFor(() => expect(h.recordContextForSession).toHaveBeenCalledOnce());
    expect(h.events).toEqual(["hook", "release", "admit:classifier_candidates"]);
    expect(exposed).toBe(false);
    raw[0]!.label = "Mutation after normalization";
    admission.resolve();
    expect(await pending).toEqual(candidates);
    expect(h.recordContextForSession).toHaveBeenCalledExactlyOnceWith(
      TOKEN,
      "classifier_candidates"
    );
    expect(JSON.stringify(h.recordContextForSession.mock.calls)).not.toContain(STORED_ID);
    expect(JSON.stringify(h.recordContextForSession.mock.calls)).not.toContain(STORED_LABEL);
  });

  it.each([
    ["empty", []],
    ["not an array", { id: STORED_ID, label: STORED_LABEL }],
    ["malformed", [{ id: STORED_ID, label: null }]],
    ["duplicate", [candidates[0], candidates[0]]],
    [
      "oversize",
      Array.from({ length: CLASSIFIER_LIMITS.candidates + 1 }, (_, index) => ({
        id: `id-${index}`,
        label: STORED_LABEL
      }))
    ]
  ])(
    "%s candidates stay clean and never reach argument choice or extraction",
    async (_name, raw) => {
      for (const extraction of [false, true]) {
        const h = harness({ raw, extract: extraction });
        expect(await h.evaluate()).toMatchObject({
          kind: "declined",
          reason: "candidates_unavailable"
        });
        expect(h.recordContextForSession).not.toHaveBeenCalled();
        expect(h.choose).toHaveBeenCalledTimes(2);
        expect(h.extract).not.toHaveBeenCalled();
        expect(h.callToolForGate).not.toHaveBeenCalled();
        const classifierInput = JSON.stringify(h.choose.mock.calls);
        expect(classifierInput).not.toContain(STORED_ID);
        expect(classifierInput).not.toContain(STORED_LABEL);
      }
    }
  );

  it.each(["on", "shadow"] as const)(
    "waits for admission before candidate choice or extraction (%s)",
    async (mode) => {
      for (const extraction of [false, true]) {
        const h = harness({ extract: extraction });
        const admission = deferred();
        h.recordContextForSession.mockImplementation(async () => admission.promise);
        const pending = h.evaluate(mode);
        await vi.waitFor(() => expect(h.recordContextForSession).toHaveBeenCalledOnce());
        expect(h.choose).toHaveBeenCalledTimes(2);
        expect(h.extract).not.toHaveBeenCalled();
        expect(JSON.stringify(h.choose.mock.calls)).not.toContain(STORED_ID);
        admission.resolve();
        expect(await pending).toMatchObject({ kind: "would_handle" });
        expect(h.callToolForGate).toHaveBeenCalledWith(
          TOKEN,
          h.tool.name,
          expect.objectContaining({ device: STORED_ID }),
          mode === "on" ? "execute" : "dry-run"
        );
        expect(JSON.stringify(extraction ? h.extract.mock.calls : h.choose.mock.calls)).toContain(
          STORED_ID
        );
      }
    }
  );

  it.each(["on", "shadow"] as const)(
    "failed admission withholds candidates from choice and extraction (%s)",
    async (mode) => {
      for (const extraction of [false, true]) {
        const h = harness({ extract: extraction });
        h.recordContextForSession.mockRejectedValue(new Error("private storage failure"));
        expect(await h.evaluate(mode)).toMatchObject({
          kind: "declined",
          reason: "candidates_unavailable"
        });
        expect(h.choose).toHaveBeenCalledTimes(2);
        expect(h.extract).not.toHaveBeenCalled();
        expect(h.callToolForGate).not.toHaveBeenCalled();
        const classifierInput = JSON.stringify(h.choose.mock.calls);
        expect(classifierInput).not.toContain(STORED_ID);
        expect(classifierInput).not.toContain(STORED_LABEL);
      }
    }
  );
});
