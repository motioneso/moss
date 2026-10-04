// A new connection with no usable default chat model (#2984 R2.5b): the first sort fails for want
// of a model, and the classifier panel says so and offers the model settings. The path runs
// through the server's stored sort results and view into the page's panel state.
import { describe, expect, it } from "vitest";

import {
  classifierSortView,
  emptyPreparationMap,
  emptySortMap,
  failedSortResults,
  withSortResult
} from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";

import {
  classifierBlockState,
  failureLine,
  failureNeedsModel
} from "../../apps/web/src/settings/integration-classifier-state.js";

const TOOLS: IntegrationToolDescriptor[] = ["GetState", "SetLight"].map((name) => ({
  name,
  description: `${name} does a thing`,
  group: "",
  inputSchema: null
}));

describe("first setup without a default chat model", () => {
  it("shows the failed panel that explains the missing model", () => {
    let classifierSort = emptySortMap();
    for (const { toolName, result } of failedSortResults(
      TOOLS,
      "no_model",
      "2026-10-04T08:00:00.000Z"
    )) {
      classifierSort = withSortResult(classifierSort, toolName, result) ?? classifierSort;
    }
    const classifierTools = classifierSortView({
      classifierEnabled: true,
      discoveredTools: TOOLS,
      enabledGroups: [],
      enabledTools: [],
      mutedTools: [],
      classifierPreparation: emptyPreparationMap(),
      classifierSort,
      classifierKeptOutTools: []
    });

    const state = classifierBlockState({
      enabled: true,
      lastError: null,
      classifierEnabled: true,
      tools: TOOLS,
      groups: [],
      enabledGroups: [],
      enabledTools: [],
      mutedTools: [],
      groupOptIn: false,
      classifierTools
    });
    expect(state).toMatchObject({ kind: "failed", failure: "no_model", failed: 2 });
    expect(failureLine(state)).toBe(
      "You don't have a default chat model, so nothing was prepared."
    );
    expect(failureNeedsModel(state)).toBe(true);
  });
});
