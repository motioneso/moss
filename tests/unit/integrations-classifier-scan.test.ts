import { describe, expect, it } from "vitest";

import {
  emptyPreparationMap,
  emptyScanMap,
  emptySortMap,
  parseScanMap,
  scanAction,
  scanActionMarkIsCurrent,
  scanMapFromLegacy,
  scanTargetList,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  withScanAction,
  withScanTargetList,
  withSendWithoutAsking,
  withSortResult,
  type ClassifierPreparationEntry,
  type ClassifierPreparationMap,
  type ClassifierScanAction,
  type ClassifierSortMap
} from "@moss/integrations";
import type { IntegrationClassifierRisk, IntegrationToolDescriptor } from "@moss/shared";

function tool(overrides: Partial<IntegrationToolDescriptor> = {}): IntegrationToolDescriptor {
  return {
    name: "notify_phone",
    description: "Send a notification to a phone",
    group: "notify",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    ...overrides
  };
}

function preparation(
  current: IntegrationToolDescriptor,
  overrides: Partial<ClassifierPreparationEntry> = {}
): ClassifierPreparationEntry {
  return {
    optIn: true,
    reviewedRisk: null,
    description: "Notify a phone",
    arguments: { message: { kind: "extract" } },
    replyTemplate: "Notified the phone.",
    definitionFingerprint: toolDefinitionFingerprint(current),
    reviewedAt: "2026-10-02T00:00:00.000Z",
    preparationVersion: 1,
    ...overrides
  };
}

function preparationMap(
  current: IntegrationToolDescriptor,
  overrides: Partial<ClassifierPreparationEntry> = {}
): ClassifierPreparationMap {
  return { version: 1, entries: { [current.name]: preparation(current, overrides) } };
}

function sorted(
  current: IntegrationToolDescriptor,
  risk: IntegrationClassifierRisk,
  send = false
): ClassifierSortMap {
  let map = withSortResult(emptySortMap(), current.name, {
    status: "current",
    risk,
    readableName: "Notify a phone",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(current)),
    sortedAt: "2026-10-03T00:00:00.000Z"
  })!;
  if (send) map = withSendWithoutAsking(map, current, true)!;
  return map;
}

function action(overrides: Partial<ClassifierScanAction> = {}): ClassifierScanAction {
  return {
    key: "tool",
    kind: "outbound",
    readableName: "Notify a phone",
    description: "Notify a phone",
    replyTemplate: "Notified the phone.",
    arguments: {},
    decidingValues: {},
    definitionFingerprint: "sha256:abc",
    scannedAt: "2026-10-02T00:00:00.000Z",
    mark: null,
    ...overrides
  };
}

describe("classifier scan conversion from the legacy maps (#3844 slice 1)", () => {
  it("reads a sort, a send choice and a preparation across into one action", () => {
    const current = tool();
    const map = scanMapFromLegacy(sorted(current, "outbound", true), preparationMap(current), [
      current
    ]);

    const converted = scanAction(map, current.name, "tool");
    expect(converted).toEqual({
      key: "tool",
      kind: "outbound",
      readableName: "Notify a phone",
      description: "Notify a phone",
      replyTemplate: "Notified the phone.",
      arguments: { message: { kind: "extract" } },
      decidingValues: {},
      definitionFingerprint: toolDefinitionFingerprint(current),
      scannedAt: "2026-10-02T00:00:00.000Z",
      mark: { choice: "run_without_asking", fingerprint: toolDefinitionFingerprint(current) }
    });
    expect(converted && scanActionMarkIsCurrent(converted)).toBe(true);
  });

  it("sets no mark when the send choice sits on a tool that is not Sends something out", () => {
    const current = tool();
    // A stored send choice only counts on an outbound sort (classifier-settings.ts), so a
    // write tool converted from the same maps carries no mark.
    const map = scanMapFromLegacy(sorted(current, "write"), preparationMap(current), [current]);
    expect(scanAction(map, current.name, "tool")?.mark).toBeNull();
    expect(scanAction(map, current.name, "tool")?.kind).toBe("write");
  });

  it("converts nothing for a stale, failed, never-tried or moved-on tool", () => {
    const current = tool();
    const prep = preparationMap(current);

    expect(scanMapFromLegacy(emptySortMap(), prep, [current])).toEqual(emptyScanMap());

    const failed = withSortResult(emptySortMap(), current.name, {
      status: "failed",
      failure: "error",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(current)),
      sortedAt: "2026-10-03T00:00:00.000Z"
    })!;
    expect(scanMapFromLegacy(failed, prep, [current])).toEqual(emptyScanMap());

    const staleTool = tool({ description: "Changed description" });
    expect(scanMapFromLegacy(sorted(current, "outbound"), prep, [staleTool])).toEqual(
      emptyScanMap()
    );

    const movedOn = preparationMap(current, { definitionFingerprint: "sha256:old" });
    expect(scanMapFromLegacy(sorted(current, "outbound"), movedOn, [current])).toEqual(
      emptyScanMap()
    );
  });

  it("converts nothing for a tool with a deciding argument", () => {
    const current = tool({
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string", enum: ["lock", "unlock"] } }
      }
    });
    const map = scanMapFromLegacy(sorted(current, "write"), preparationMap(current), [current]);
    expect(map).toEqual(emptyScanMap());
  });

  it("converts a connection with none of the legacy data to an empty map", () => {
    const current = tool();
    expect(scanMapFromLegacy(emptySortMap(), emptyPreparationMap(), [current])).toEqual(
      emptyScanMap()
    );
    expect(scanMapFromLegacy(emptySortMap(), emptyPreparationMap(), [])).toEqual(emptyScanMap());
  });

  it("reports a mark whose fingerprint no longer matches its action", () => {
    const stale = action({
      mark: { choice: "run_without_asking", fingerprint: "sha256:old" }
    });
    expect(scanActionMarkIsCurrent(stale)).toBe(false);
    expect(scanActionMarkIsCurrent(action())).toBe(false);
  });
});

describe("classifier scan map storage (#3844 slice 1)", () => {
  it("reads malformed stored data as empty and drops only the malformed action", () => {
    for (const raw of [null, "x", { version: 2, actions: {}, targets: {} }, { version: 1 }]) {
      expect(parseScanMap(raw)).toEqual(emptyScanMap());
    }
    const raw = JSON.parse(
      JSON.stringify({
        version: 1,
        actions: {
          good_tool: { tool: action() },
          bad_tool: { tool: { ...action(), kind: "sideways" } }
        },
        targets: {}
      })
    );
    const map = parseScanMap(raw);
    expect(scanAction(map, "good_tool", "tool")?.kind).toBe("outbound");
    expect(scanAction(map, "bad_tool", "tool")).toBeUndefined();
  });

  it("keeps a tool named __proto__ or toString as an own key", () => {
    let map = withScanAction(emptyScanMap(), "__proto__", action());
    map = withScanAction(map, "toString", action());
    expect(scanAction(map, "__proto__", "tool")?.kind).toBe("outbound");
    expect(scanAction(map, "toString", "tool")?.kind).toBe("outbound");
    const reread = parseScanMap(JSON.parse(JSON.stringify(map)));
    expect(scanAction(reread, "__proto__", "tool")?.kind).toBe("outbound");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("round-trips a target list holding only an id and a label per entry", () => {
    const map = withScanTargetList(emptyScanMap(), "list_lights", {
      sourceTool: "list_lights",
      definitionFingerprint: "sha256:abc",
      readAt: "2026-10-02T00:00:00.000Z",
      entries: [{ id: "light.kitchen", label: "Kitchen light" }]
    });
    const reread = parseScanMap(JSON.parse(JSON.stringify(map)));
    expect(scanTargetList(reread, "list_lights")?.entries).toEqual([
      { id: "light.kitchen", label: "Kitchen light" }
    ]);
    expect(scanTargetList(reread, "missing")).toBeUndefined();
  });
});
