import { describe, expect, it } from "vitest";

import {
  emptySortMap,
  parseSortMap,
  readableToolNames,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  toolSortState,
  withoutStaleSendChoices,
  withSendWithoutAsking,
  withSortResult,
  type ClassifierSortMap,
  type DiscoveredTool
} from "@moss/integrations";
import type { IntegrationClassifierRisk } from "@moss/shared";

function webTool(method: string, overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name: "updateMovie",
    description: "Change a movie",
    group: "Movies",
    inputSchema: { type: "object", properties: { id: { type: "integer" } } },
    idempotent: true,
    invoke: { method, path: "/api/v3/movie/{id}", params: [], hasBody: false },
    ...overrides
  };
}

const LIGHT: DiscoveredTool = {
  name: "HassBroadcast",
  description: "Broadcast a message through the home.",
  group: "",
  inputSchema: { type: "object", properties: { message: { type: "string" } } }
};

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

describe("classifier risk inputs (#2984 R2.1)", () => {
  it("changes the sort fingerprint when PUT becomes DELETE under the same name and schema", () => {
    const put = webTool("PUT");
    const del = webTool("DELETE");

    expect(toolRiskInputs(put).httpMethod).toBe("PUT");
    expect(toolSortFingerprint(toolRiskInputs(put))).not.toBe(
      toolSortFingerprint(toolRiskInputs(del))
    );
    // The definition fingerprint governs preparation and leaves the call recipe out.
    expect(toolDefinitionFingerprint(put)).toBe(toolDefinitionFingerprint(del));
  });

  it("covers every definition field, so a changed hint also makes the sort stale", () => {
    const base = toolSortFingerprint(toolRiskInputs(LIGHT));
    expect(toolSortFingerprint(toolRiskInputs({ ...LIGHT, destructive: true }))).not.toBe(base);
    expect(toolSortFingerprint(toolRiskInputs({ ...LIGHT, description: "Other" }))).not.toBe(base);
    expect(toolRiskInputs(LIGHT).httpMethod).toBeNull();
  });

  it("reads a sort as stale once the method changes, and clears the send choice", () => {
    const put = webTool("PUT");
    let map = sorted(put, "outbound");
    map = withSendWithoutAsking(map, put, true)!;
    expect(toolSortState(map, put)).toMatchObject({ status: "current", sendWithoutAsking: true });

    const del = webTool("DELETE");
    expect(toolSortState(map, del)).toEqual({ status: "stale" });

    // Discovery clears the choice, so changing the method back does not revive it.
    map = withoutStaleSendChoices(map, [del]);
    expect(toolSortState(map, put)).toMatchObject({ status: "current", sendWithoutAsking: false });
  });
});

describe("classifier sort storage (#2984 R2.1)", () => {
  it("reads a missing, malformed or wrong-version map as never tried", () => {
    for (const raw of [null, "x", { version: 2, entries: {} }, { version: 1, entries: [] }]) {
      expect(toolSortState(parseSortMap(raw), LIGHT)).toEqual({ status: "never_tried" });
    }
    const badEntry = parseSortMap({
      version: 1,
      entries: { HassBroadcast: { status: "current", risk: "read", readableName: "A" } }
    });
    expect(toolSortState(badEntry, LIGHT)).toEqual({ status: "never_tried" });
  });

  it("round-trips a stored map through JSON", () => {
    const map = withSendWithoutAsking(sorted(LIGHT, "outbound"), LIGHT, true)!;
    const reread = parseSortMap(JSON.parse(JSON.stringify(map)));
    expect(toolSortState(reread, LIGHT)).toEqual({
      status: "current",
      risk: "outbound",
      readableName: "Readable",
      sendWithoutAsking: true
    });
  });

  it("keeps an old reviewed risk only when it is higher than the sorted group", () => {
    const withFloor = (floor: IntegrationClassifierRisk) =>
      parseSortMap({
        version: 1,
        entries: { HassBroadcast: { status: "never_tried", legacyRiskFloor: floor } }
      });

    expect(toolSortState(withFloor("destructive"), LIGHT)).toEqual({ status: "never_tried" });
    expect(toolSortState(sorted(LIGHT, "write", withFloor("destructive")), LIGHT)).toMatchObject({
      risk: "destructive"
    });
    expect(toolSortState(sorted(LIGHT, "outbound", withFloor("read")), LIGHT)).toMatchObject({
      risk: "outbound"
    });
  });

  it("allows sending without asking only on a current Sends things out sort", () => {
    expect(withSendWithoutAsking(emptySortMap(), LIGHT, true)).toBeNull();
    expect(withSendWithoutAsking(sorted(LIGHT, "destructive"), LIGHT, true)).toBeNull();
    expect(withSendWithoutAsking(sorted(LIGHT, "write"), LIGHT, true)).toBeNull();
    const stale = sorted(LIGHT, "outbound");
    expect(withSendWithoutAsking(stale, { ...LIGHT, description: "Changed" }, true)).toBeNull();

    // A stored choice on a sort that is not Sends things out is ignored on read.
    const forged = parseSortMap({
      version: 1,
      entries: {
        HassBroadcast: {
          ...sorted(LIGHT, "destructive").entries["HassBroadcast"],
          sendWithoutAsking: true
        }
      }
    });
    expect(toolSortState(forged, LIGHT)).toMatchObject({ sendWithoutAsking: false });

    // A floor that raises the sort past Sends things out also turns the choice off.
    const raised = withSendWithoutAsking(
      sorted(
        LIGHT,
        "outbound",
        parseSortMap({
          version: 1,
          entries: { HassBroadcast: { status: "never_tried", legacyRiskFloor: "destructive" } }
        })
      ),
      LIGHT,
      true
    );
    expect(raised).toBeNull();
  });

  it("keeps the send choice through storage when an old reviewed floor raises the sort to outbound", () => {
    const converted = parseSortMap({
      version: 1,
      entries: { HassBroadcast: { status: "never_tried", legacyRiskFloor: "outbound" } }
    });
    let map = withSendWithoutAsking(sorted(LIGHT, "write", converted), LIGHT, true)!;
    expect(toolSortState(map, LIGHT)).toMatchObject({ risk: "outbound", sendWithoutAsking: true });

    map = parseSortMap(JSON.parse(JSON.stringify(map)));
    expect(toolSortState(map, LIGHT)).toMatchObject({ risk: "outbound", sendWithoutAsking: true });

    // A re-sort against the same inputs keeps the choice while the floor still makes it outbound.
    map = sorted(LIGHT, "read", map);
    expect(toolSortState(map, LIGHT)).toMatchObject({ risk: "outbound", sendWithoutAsking: true });
  });

  it("clears the send choice when a new sort result arrives for changed inputs", () => {
    let map = withSendWithoutAsking(sorted(LIGHT, "outbound"), LIGHT, true)!;
    const changed = { ...LIGHT, description: "Broadcast and record" };
    map = sorted(changed, "outbound", map);
    expect(toolSortState(map, changed)).toMatchObject({ sendWithoutAsking: false });
  });

  it("records a failed sort, which reads as stale once the tool changes", () => {
    const map = withSortResult(emptySortMap(), LIGHT.name, {
      status: "failed",
      failure: "unsafe",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(LIGHT)),
      sortedAt: "2026-10-04T00:00:00.000Z"
    })!;
    expect(toolSortState(map, LIGHT)).toEqual({ status: "failed", failure: "unsafe" });
    expect(toolSortState(map, { ...LIGHT, description: "New" })).toEqual({ status: "stale" });
  });

  it("refuses a readable name that is not one bounded line of plain text", () => {
    for (const readableName of ["", "two\nlines", "x".repeat(81), "bell\u0007"]) {
      expect(
        withSortResult(emptySortMap(), LIGHT.name, {
          status: "current",
          risk: "read",
          readableName,
          sortFingerprint: "sha256:x",
          sortedAt: "2026-10-04T00:00:00.000Z"
        })
      ).toBeNull();
    }
  });

  it("treats a tool literally named __proto__ as an ordinary key", () => {
    const proto = { ...LIGHT, name: "__proto__" };
    const map = sorted(proto, "read");
    expect(toolSortState(map, proto)).toMatchObject({ status: "current" });
    expect(toolSortState(parseSortMap(JSON.parse(JSON.stringify(map))), proto)).toMatchObject({
      status: "current"
    });
    expect(toolSortState(emptySortMap(), { ...LIGHT, name: "toString" })).toEqual({
      status: "never_tried"
    });
  });
});

describe("free readable-name rule (#2984 R2.1)", () => {
  const mcp = (name: string): DiscoveredTool => ({
    name,
    description: "",
    group: "",
    inputSchema: null
  });

  it("names Home Assistant tools by dropping the shared Hass prefix and keeping verbs", () => {
    const names = readableToolNames(
      [
        "HassTurnOff",
        "HassTurnOn",
        "HassClimateSetTemperature",
        "HassMediaSearchAndPlay",
        "HassLightSet",
        "GetLiveContext",
        "GetDateTime",
        "todo_get_items",
        "intent_script__AddTaskWork",
        "intent_script__AddShow"
      ].map(mcp)
    );
    expect(Object.fromEntries(names)).toEqual({
      HassTurnOff: "Turn off",
      HassTurnOn: "Turn on",
      HassClimateSetTemperature: "Climate set temperature",
      HassMediaSearchAndPlay: "Media search and play",
      HassLightSet: "Light set",
      GetLiveContext: "Get live context",
      GetDateTime: "Get date time",
      todo_get_items: "Todo get items",
      intent_script__AddTaskWork: "Add task work",
      intent_script__AddShow: "Add show"
    });
  });

  it("names web-service tools from their method and route, dropping the shared route prefix", () => {
    const route = (method: string, path: string): DiscoveredTool => ({
      name: `${method.toLowerCase()}${path}`
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, ""),
      description: "",
      group: "Movies",
      inputSchema: null,
      invoke: { method, path, params: [], hasBody: false }
    });
    const tools = [
      route("GET", "/api/v3/alttitle/{id}"),
      route("DELETE", "/api/v3/movie/{id}"),
      route("POST", "/api/v3/movie"),
      { ...route("GET", "/api/v3/pets"), name: "listPets" }
    ];
    const names = readableToolNames(tools);
    expect(names.get("get_api_v3_alttitle_id")).toBe("Look up alttitle");
    expect(names.get("delete_api_v3_movie_id")).toBe("Delete movie");
    expect(names.get("post_api_v3_movie")).toBe("Create movie");
    expect(names.get("listPets")).toBe("List pets");
  });

  it("keeps a shared action word when every tool in the connection starts with it", () => {
    const shared = Object.fromEntries(readableToolNames(["AddTask", "AddShow"].map(mcp)));
    expect(shared).toEqual({ AddTask: "Add task", AddShow: "Add show" });

    const hass = Object.fromEntries(readableToolNames(["HassTurnOn", "HassTurnOff"].map(mcp)));
    expect(hass).toEqual({ HassTurnOn: "Turn on", HassTurnOff: "Turn off" });
  });

  it("keeps a lone tool's full name and never returns an empty name", () => {
    expect(readableToolNames([mcp("turn_on")]).get("turn_on")).toBe("Turn on");
    expect(readableToolNames([mcp("__")]).get("__")).toBe("__");
  });
});
