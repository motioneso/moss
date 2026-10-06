import { describe, expect, it, vi } from "vitest";

import type { ClassifierDeps } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";

import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";

/**
 * #2907 (plan 3.5) — the production ports factory. The classifier, the gateway and the module
 * resolver are fakes; no provider or model is named. The point is the mapping from manifests to the
 * gate menu, the candidate hook plumbing, the gateway mode forwarding and the release check.
 * A tool is released exactly when this attempt listed it (spec 8.5).
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
  isExternal: false,
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
  isExternal: false,
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
    manifests?: () => readonly MossModuleManifest[];
    onCall?: (tool: string, mode: string) => unknown;
  } = {}
) {
  const callToolForGate = vi.fn(
    async (token: string, tool: string, _input: unknown, mode: string) => {
      expect(token).toBe("jst_gate");
      return overrides.onCall?.(tool, mode) ?? { kind: "would_run", approvalMode: "auto" };
    }
  );
  const factory = createClassifierGatePortsFactory({
    resolveActiveModules: async () => overrides.manifests?.() ?? [manifest],
    dataContext,
    gateway: {
      callToolForGate,
      recordContextForSession: vi.fn(async () => {}),
      admitToolDescriptorsForSession: vi.fn(async () => {})
    } as never,
    classifierDeps: {
      repository: {
        resolveSortingModel: vi.fn(async () => null),
        resolveModelForService: vi.fn(),
        selectProviderWithCredential: vi.fn()
      },
      cipher: { decryptJson: vi.fn() }
    } as unknown as ClassifierDeps,
    now: () => 0
  });
  return { factory, callToolForGate };
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

  it("releases exactly the declared tools this attempt listed", async () => {
    let current: readonly MossModuleManifest[] = [manifest];
    const { factory } = makeFactory({ manifests: () => current });
    const ports = factory("actor-1", "jst_gate");

    const listed = await ports.listTools();
    const [calendarGateTool, switchGateTool] = listed;
    // Nothing is released before the attempt lists its tools.
    const fresh = factory("actor-1", "jst_gate");
    expect(fresh.isReleased(calendarGateTool!)).toBe(false);

    expect(ports.isReleased(calendarGateTool!)).toBe(true);
    expect(ports.isReleased(switchGateTool!)).toBe(true);
    // An undeclared tool, or a same-named tool from another module, is not released.
    expect(ports.isReleased({ ...calendarGateTool!, name: "calendar.createEvent" })).toBe(false);
    expect(ports.isReleased({ ...calendarGateTool!, moduleId: "other" })).toBe(false);

    // A tool that drops out of the menu (for example a connected tool that lost eligibility)
    // stops being released on the next listing.
    current = [{ ...manifest, assistantTools: [calendarTool] } as unknown as MossModuleManifest];
    await ports.listTools();
    expect(ports.isReleased(calendarGateTool!)).toBe(true);
    expect(ports.isReleased(switchGateTool!)).toBe(false);
  });

  it("returns no classifier when none is bound, without borrowing the chat default", async () => {
    const { factory } = makeFactory();
    const ports = factory("actor-1", "jst_gate");
    expect(await ports.classifier.resolve()).toBeNull();
  });
});
