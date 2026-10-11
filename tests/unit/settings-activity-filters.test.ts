import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACTIVITY_FILTERS,
  NO_MODEL_FILTER_KEY,
  isDefaultActivityFilters,
  lineActivityModule,
  loadActivityFilters,
  modelsButtonLabel,
  saveActivityFilters,
  storageKeyForActivityFilters,
  toolRowHiddenByModelFilter,
  type ActivityFilters
} from "../../apps/web/src/settings/settings-activity-filters.js";

function memoryStorage(values: Record<string, string> = {}): {
  readonly store: Record<string, string>;
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
} {
  const store: Record<string, string> = { ...values };
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value;
    }
  };
}

describe("activity filter state (#2956 slice D)", () => {
  it("defaults to 30 days, all modules, all models", () => {
    expect(DEFAULT_ACTIVITY_FILTERS).toEqual({ range: "30d", module: "", untickedModels: [] });
    expect(isDefaultActivityFilters(DEFAULT_ACTIVITY_FILTERS)).toBe(true);
  });

  it("keys storage by user id so two accounts do not share filters", () => {
    expect(storageKeyForActivityFilters("u1")).toContain("u1");
    expect(storageKeyForActivityFilters("u1")).not.toBe(storageKeyForActivityFilters("u2"));
  });

  it("round-trips unticked models and restores them on load", () => {
    const storage = memoryStorage();
    const filters: ActivityFilters = {
      range: "7d",
      module: "news",
      untickedModels: ["nomic-embed-text"]
    };
    saveActivityFilters(storage, "u1", filters);
    expect(loadActivityFilters(storage, "u1", ["a-model", "nomic-embed-text"], ["news"])).toEqual(
      filters
    );
  });

  it("drops unknown unticked models, a bad range and an unknown module on load", () => {
    const storage = memoryStorage();
    saveActivityFilters(storage, "u1", {
      range: "7d",
      module: "news",
      untickedModels: ["nomic-embed-text"]
    });
    expect(loadActivityFilters(storage, "u1", ["a-model"], ["news"])).toEqual({
      range: "7d",
      module: "news",
      untickedModels: []
    });
    const raw = memoryStorage();
    raw.setItem(
      storageKeyForActivityFilters("u1"),
      JSON.stringify({ range: "forever", module: "gone", untickedModels: ["x"] })
    );
    expect(loadActivityFilters(raw, "u1", ["a-model"], ["news"])).toEqual(DEFAULT_ACTIVITY_FILTERS);
  });

  it("returns defaults when nothing was saved", () => {
    expect(loadActivityFilters(memoryStorage(), "u1", [], [])).toEqual(DEFAULT_ACTIVITY_FILTERS);
  });

  it("shows Reset filters whenever any filter differs from the default", () => {
    expect(isDefaultActivityFilters({ ...DEFAULT_ACTIVITY_FILTERS, range: "7d" })).toBe(false);
    expect(isDefaultActivityFilters({ ...DEFAULT_ACTIVITY_FILTERS, module: "news" })).toBe(false);
    expect(isDefaultActivityFilters({ ...DEFAULT_ACTIVITY_FILTERS, untickedModels: ["x"] })).toBe(
      false
    );
  });

  it("labels the Models button with the ticked count, including No model", () => {
    expect(modelsButtonLabel(2, 2)).toBe("Models: all");
    expect(modelsButtonLabel(1, 2)).toBe("Models: 1 of 2");
    expect(modelsButtonLabel(0, 3)).toBe("Models: 0 of 3");
  });

  it("maps action codes to their owning module, or null when no module owns the line", () => {
    expect(lineActivityModule("chat.answer")).toBe("ai");
    expect(lineActivityModule("chat.tool_check")).toBe("ai");
    expect(lineActivityModule("embed.memory-passages")).toBe("memory");
    expect(lineActivityModule("transcribe.voice_note")).toBe("ai");
    expect(lineActivityModule("transcribe.meeting")).toBe("meetings");
    expect(lineActivityModule("structured.briefings")).toBe("briefings");
    expect(lineActivityModule("structured.news")).toBe("news");
    expect(lineActivityModule("structured.sports")).toBe("sports");
    expect(lineActivityModule("structured.workshop")).toBe("workshop");
    expect(lineActivityModule("structured.web-research")).toBe("web");
    expect(lineActivityModule("structured.connectors.email-sort")).toBe("connectors");
    expect(lineActivityModule("structured.connectors.email-extract")).toBe("connectors");
    expect(lineActivityModule("structured.commitments.email-judgement")).toBe("jarvis.commitments");
    expect(lineActivityModule("structured.moss.workshop-build-plan")).toBe("ai");
    expect(lineActivityModule("task.commitment-extract")).toBe("jarvis.commitments");
    expect(lineActivityModule("task.memory-extract")).toBe("memory");
    expect(lineActivityModule("task.task-search")).toBe("tasks");
    expect(lineActivityModule("module.build")).toBe("workshop");
    expect(lineActivityModule("probe.reachable")).toBeNull();
    expect(lineActivityModule("structured.something-new")).toBeNull();
    expect(lineActivityModule(null)).toBeNull();
  });

  it("hides tool rows under the model filter only when No model is unticked", () => {
    expect(toolRowHiddenByModelFilter([])).toBe(false);
    expect(toolRowHiddenByModelFilter(["some-model"])).toBe(false);
    expect(toolRowHiddenByModelFilter([NO_MODEL_FILTER_KEY])).toBe(true);
  });
});
