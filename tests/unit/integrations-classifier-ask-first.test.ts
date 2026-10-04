import { describe, expect, it } from "vitest";

import {
  classifierSortView,
  emptySortMap,
  parseSortMap,
  toolRiskInputs,
  toolRunsWithoutAsking,
  toolSortFingerprint,
  withSendWithoutAsking,
  withSortResult,
  type ClassifierSortEntry,
  type ClassifierSortMap,
  type DiscoveredTool
} from "@moss/integrations";
import type { IntegrationClassifierRisk } from "@moss/shared";

function webTool(method: string, name = "updateMovie"): DiscoveredTool {
  return {
    name,
    description: "Change a movie",
    group: "Movies",
    inputSchema: { type: "object", properties: { id: { type: "integer" } } },
    idempotent: true,
    invoke: { method, path: "/api/v3/movie/{id}", params: [], hasBody: false }
  };
}

function sorted(
  tool: DiscoveredTool,
  risk: IntegrationClassifierRisk,
  map: ClassifierSortMap = emptySortMap()
): ClassifierSortMap {
  const next = withSortResult(map, tool.name, {
    status: "current",
    risk,
    readableName: "Readable",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
    sortedAt: "2026-10-04T00:00:00.000Z"
  });
  if (!next) throw new Error("sort result was not storable");
  return next;
}

/** A hand-built stored entry, for shapes the write helpers refuse to produce. */
function withEntry(tool: DiscoveredTool, entry: Partial<ClassifierSortEntry>): ClassifierSortMap {
  const base = emptySortMap();
  return {
    version: base.version,
    entries: {
      [tool.name]: {
        status: "current",
        risk: "outbound",
        readableName: "Readable",
        sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
        sortedAt: "2026-10-04T00:00:00.000Z",
        failure: null,
        sendWithoutAsking: false,
        legacyRiskFloor: null,
        ...entry
      } as ClassifierSortEntry
    }
  };
}

describe("toolRunsWithoutAsking (#2984 R2.3, spec 8.3)", () => {
  const tool = webTool("PUT");

  it("runs a current Looks things up or Changes things sort", () => {
    expect(toolRunsWithoutAsking(sorted(tool, "read"), tool)).toBe(true);
    expect(toolRunsWithoutAsking(sorted(tool, "write"), tool)).toBe(true);
  });

  it("asks for Sends things out until the owner allows it, and again after undo", () => {
    const outbound = sorted(tool, "outbound");
    expect(toolRunsWithoutAsking(outbound, tool)).toBe(false);

    const allowed = withSendWithoutAsking(outbound, tool, true)!;
    expect(toolRunsWithoutAsking(allowed, tool)).toBe(true);

    const undone = withSendWithoutAsking(allowed, tool, false)!;
    expect(toolRunsWithoutAsking(undone, tool)).toBe(false);
  });

  it("asks for Sensitive even when a send flag is stored on it", () => {
    expect(toolRunsWithoutAsking(sorted(tool, "destructive"), tool)).toBe(false);
    const flagged = withEntry(tool, { risk: "destructive", sendWithoutAsking: true });
    expect(toolRunsWithoutAsking(flagged, tool)).toBe(false);
  });

  it("asks when an old reviewed floor raises the sort to Sensitive", () => {
    const floored = withEntry(tool, {
      risk: "read",
      legacyRiskFloor: "destructive",
      sendWithoutAsking: true
    });
    expect(toolRunsWithoutAsking(floored, tool)).toBe(false);
  });

  it("asks for a never sorted tool", () => {
    expect(toolRunsWithoutAsking(emptySortMap(), tool)).toBe(false);
  });

  it("asks for a tool whose last sort failed", () => {
    const failed = withSortResult(emptySortMap(), tool.name, {
      status: "failed",
      failure: "error",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
      sortedAt: "2026-10-04T00:00:00.000Z"
    })!;
    expect(toolRunsWithoutAsking(failed, tool)).toBe(false);
  });

  it("asks when the method changed from PUT to DELETE after a safe sort", () => {
    const safe = sorted(webTool("PUT"), "write");
    expect(toolRunsWithoutAsking(safe, webTool("PUT"))).toBe(true);
    expect(toolRunsWithoutAsking(safe, webTool("DELETE"))).toBe(false);
  });

  it("asks when the stored record is unreadable", () => {
    const fingerprint = toolSortFingerprint(toolRiskInputs(tool));
    const good = {
      status: "current",
      risk: "write",
      readableName: "Rename a movie",
      sortFingerprint: fingerprint,
      sortedAt: "2026-10-04T00:00:00.000Z",
      sendWithoutAsking: false,
      legacyRiskFloor: null
    };
    const version = emptySortMap().version;
    expect(
      toolRunsWithoutAsking(parseSortMap({ version, entries: { [tool.name]: good } }), tool)
    ).toBe(true);
    for (const raw of [
      null,
      "not a map",
      { version: version + 1, entries: { [tool.name]: good } },
      { version, entries: { [tool.name]: { ...good, risk: "harmless" } } },
      { version, entries: { [tool.name]: { ...good, readableName: "" } } },
      { version, entries: { [tool.name]: { ...good, status: "sorted" } } }
    ]) {
      expect(toolRunsWithoutAsking(parseSortMap(raw), tool)).toBe(false);
    }
  });

  it("never reads another tool's sort", () => {
    const other = webTool("GET", "listMovies");
    expect(toolRunsWithoutAsking(sorted(other, "read"), tool)).toBe(false);
  });
});

describe("classifierSortView (#2984 R2.3)", () => {
  it("shows each tool's group and whether it asks first", () => {
    const read = webTool("GET", "listMovies");
    const send = webTool("POST", "notify");
    const sensitive = webTool("DELETE", "deleteMovie");
    const unsorted = webTool("PUT", "renameMovie");
    let map = sorted(read, "read");
    map = sorted(send, "outbound", map);
    map = sorted(sensitive, "destructive", map);

    expect(classifierSortView(map, [read, send, sensitive, unsorted])).toEqual([
      {
        toolName: "listMovies",
        status: "current",
        risk: "read",
        failure: null,
        sendWithoutAsking: false,
        asksFirst: false
      },
      {
        toolName: "notify",
        status: "current",
        risk: "outbound",
        failure: null,
        sendWithoutAsking: false,
        asksFirst: true
      },
      {
        toolName: "deleteMovie",
        status: "current",
        risk: "destructive",
        failure: null,
        sendWithoutAsking: false,
        asksFirst: true
      },
      {
        toolName: "renameMovie",
        status: "never_tried",
        risk: null,
        failure: null,
        sendWithoutAsking: false,
        asksFirst: true
      }
    ]);
  });
});
