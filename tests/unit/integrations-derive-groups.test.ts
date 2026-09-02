import { describe, expect, it } from "vitest";
import { deriveGroups } from "@moss/integrations";
import homeAssistantTools from "./fixtures/home-assistant-75-tools.json" with { type: "json" };

describe("deriveGroups", () => {
  it("splits names into segments at upper-case boundaries and separators", () => {
    const names = ["HassMediaPause", "todo_add_item"];
    const groups = deriveGroups(names);
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g).not.toBe("");
  });

  it("drops a leading segment shared by more than half the tools, repeating as needed", () => {
    const names = [
      "HassLightTurnOn",
      "HassLightTurnOff",
      "HassLightSetBrightness",
      "HassFanTurnOn",
      "HassFanTurnOff",
      "HassClimateSetTemp"
    ];
    const groups = deriveGroups(names);
    // "Hass" is shared by all 6 (>half), so it's dropped; the next segment
    // ("Light"/"Fan"/"Climate") becomes the group, not "Hass".
    expect(groups.every((g) => !g.startsWith("Hass"))).toBe(true);
  });

  it("groups on the next segment after dropping the shared prefix", () => {
    const names = [
      "HassLightTurnOn",
      "HassLightTurnOff",
      "HassLightSetBrightness",
      "HassFanTurnOn",
      "HassFanTurnOff",
      "HassFanSetSpeed",
      "HassClimateSetTemp"
    ];
    const groups = deriveGroups(names);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).toBe(groups[2]);
    expect(groups[3]).toBe(groups[4]);
    expect(groups[3]).toBe(groups[5]);
  });

  it("splits a group larger than 12 by regrouping one level deeper", () => {
    const rooms = ["Bedroom", "Kitchen", "Livingroom", "Office", "Garage"];
    const actions = ["TurnOn", "TurnOff", "SetBrightness"];
    const bigFamily = rooms.flatMap((room) => actions.map((action) => `HassLight${room}${action}`));
    const names = [...bigFamily, "HassFanTurnOn", "HassFanTurnOff", "HassFanSetSpeed"];
    const groups = deriveGroups(names);
    const lightGroups = new Set(groups.slice(0, bigFamily.length));
    // 12 lights must not collapse into a single group of 12+ (regrouping one level deeper kicks in).
    expect(lightGroups.size).toBeGreaterThan(1);
    for (const g of lightGroups) {
      const count = groups.filter((x) => x === g).length;
      expect(count).toBeLessThanOrEqual(12);
    }
  });

  it("sweeps any group smaller than 3 into Other", () => {
    const names = [
      "HassLightTurnOn",
      "HassLightTurnOff",
      "HassLightSetBrightness",
      "HassFanTurnOn" // only 1 fan tool -> below minimum of 3
    ];
    const groups = deriveGroups(names);
    expect(groups[3]).toBe("Other");
  });

  it("never returns an empty group name", () => {
    const names = ["a", "b", "c"];
    const groups = deriveGroups(names);
    for (const g of groups) expect(g).not.toBe("");
  });

  it("returns one group per input name, in the same order", () => {
    const names = ["one", "two", "three"];
    const groups = deriveGroups(names);
    expect(groups).toHaveLength(names.length);
  });

  // Fable's binding ruling (2026-09-02, issue #2175 comment 5513612338): Other is
  // display-only and never an opt-in unit on the real 75-tool fixture -- only
  // 22/75 names share the "Hass" prefix the spec assumed was near-universal, so
  // most of the rest are correctly one-off names swept into Other. This is now
  // the accepted, exact grouping for this fixture, not a gate.
  it("produces the exact grouping ruled acceptable on the real 75-tool fixture", () => {
    const names: string[] = homeAssistantTools;
    const groups = deriveGroups(names);
    expect(groups).toHaveLength(names.length);
    for (const g of groups) expect(g).not.toBe("");

    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);

    expect(counts.get("Other")).toBe(42);

    // Every non-Other group is between the minimum and maximum group size.
    for (const [group, count] of counts) {
      if (group !== "Other") {
        expect(count).toBeLessThanOrEqual(12);
        expect(count).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
