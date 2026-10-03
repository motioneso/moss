import { describe, expect, it, vi } from "vitest";

import type { ClassifierDeps } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import type { ClassifierToolReleaseRecord } from "@moss/shared";

import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";

/**
 * #2907 (plan 3.5) — the production ports factory. The classifier, the gateway and the module
 * resolver are fakes; no provider or model is named. The point is the mapping from manifests to the
 * gate menu, the candidate hook plumbing, the gateway mode forwarding and the release check.
 */

const fakeDb = {} as DataContextDb;
const dataContext = {
  withDataContext: (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) => work(fakeDb)
} as unknown as DataContextRunner;

const calendarTool = {
  name: "calendar.listVisibleEvents",
  description: "List events",
  permissionId: "calendar.view",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: { window: { type: "string", enum: ["today", "tomorrow"] } },
    required: ["window"]
  },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  classifier: {
    description: "Read the calendar",
    arguments: { window: { kind: "enum" } },
    replyTemplate: "{summary}"
  },
  execute: vi.fn()
};

const candidates = vi.fn(async () => [{ id: "kitchen", label: "Kitchen light" }]);
const switchTool = {
  name: "home.setSwitch",
  description: "Set a switch",
  permissionId: "home.control",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: { device: { type: "string" }, state: { type: "string", enum: ["on", "off"] } },
    required: ["device", "state"]
  },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  classifier: {
    description: "Turn a light on or off",
    arguments: { device: { kind: "candidates" }, state: { kind: "enum" } },
    candidates,
    replyTemplate: "{summary}"
  },
  execute: vi.fn()
};

/** A tool with no classifier opt-in must never reach the menu. */
const undeclaredTool = {
  name: "calendar.createEvent",
  description: "Create an event",
  permissionId: "calendar.write",
  risk: "write",
  execute: vi.fn()
};

const manifest = {
  id: "calendar",
  name: "Calendar",
  assistantTools: [calendarTool, switchTool, undeclaredTool]
} as unknown as MossModuleManifest;

function makeFactory(
  overrides: {
    releases?: ReadonlyArray<{ moduleId: string; toolName: string }>;
    onCall?: (tool: string, mode: string) => unknown;
  } = {}
) {
  const callToolForGate = vi.fn(
    async (token: string, tool: string, _input: unknown, mode: string) => {
      expect(token).toBe("jst_gate");
      return overrides.onCall?.(tool, mode) ?? { kind: "would_run", approvalMode: "auto" };
    }
  );
  const listEligibleReleases = vi.fn(async () =>
    (overrides.releases ?? []).map((release) => release as ClassifierToolReleaseRecord)
  );
  const factory = createClassifierGatePortsFactory({
    resolveActiveModules: async () => [manifest],
    dataContext,
    gateway: { callToolForGate } as never,
    classifierDeps: {
      repository: {
        resolveSortingModel: vi.fn(async () => null),
        resolveModelForService: vi.fn(),
        selectProviderWithCredential: vi.fn()
      },
      cipher: { decryptJson: vi.fn() }
    } as unknown as ClassifierDeps,
    releaseRepository: { hasEligibleRelease: vi.fn(), listEligibleReleases },
    now: () => 0
  });
  return { factory, callToolForGate, listEligibleReleases };
}

describe("createClassifierGatePortsFactory", () => {
  it("offers only tools with a handler and a classifier declaration, mapped to their module", async () => {
    const { factory } = makeFactory();
    const tools = await factory("actor-1", "jst_gate").listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "calendar.listVisibleEvents",
      "home.setSwitch"
    ]);
    expect(tools[0]).toMatchObject({
      moduleId: "calendar",
      moduleDescription: "Calendar",
      risk: "read"
    });
  });

  it("runs a tool's candidate hook with the caller's signal", async () => {
    const { factory } = makeFactory();
    const ports = factory("actor-1", "jst_gate");
    const tools = await ports.listTools();
    const switchGateTool = tools.find((tool) => tool.name === "home.setSwitch")!;
    const controller = new AbortController();
    const raw = await ports.loadCandidates(switchGateTool, controller.signal);
    expect(raw).toEqual([{ id: "kitchen", label: "Kitchen light" }]);
    expect(candidates).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ actorUserId: "actor-1" }),
      { signal: controller.signal }
    );
  });

  it("rejects a candidate read for a tool with no hook", async () => {
    const { factory } = makeFactory();
    const ports = factory("actor-1", "jst_gate");
    const tools = await ports.listTools();
    const calendar = tools.find((tool) => tool.name === "calendar.listVisibleEvents")!;
    await expect(ports.loadCandidates(calendar, new AbortController().signal)).rejects.toThrow();
  });

  it("forwards the gateway call with the requested mode and the attempt token", async () => {
    const { factory, callToolForGate } = makeFactory();
    const ports = factory("actor-1", "jst_gate");
    await ports.gateway.call("calendar.listVisibleEvents", { window: "today" }, "dry-run");
    expect(callToolForGate).toHaveBeenCalledWith(
      "jst_gate",
      "calendar.listVisibleEvents",
      { window: "today" },
      "dry-run"
    );
  });

  it("reports a tool as released only after `listTools` loads a matching release row", async () => {
    const { factory } = makeFactory({
      releases: [{ moduleId: "calendar", toolName: "calendar.listVisibleEvents" }]
    });
    const ports = factory("actor-1", "jst_gate");
    const tools = await ports.listTools();
    expect(ports.isReleased(tools[0]!)).toBe(true);
    expect(ports.isReleased(tools[1]!)).toBe(false);
  });

  it("returns no classifier when none is bound, without borrowing the chat default", async () => {
    const { factory } = makeFactory();
    const ports = factory("actor-1", "jst_gate");
    expect(await ports.classifier.resolve()).toBeNull();
  });
});
