import type { Settings, Tier } from "./types.js";

// The only place the launcher seeds model names. They are user-editable data after setup.
export const DEFAULT_SETTINGS: Settings = {
  judgeCmd: "claude -p",
  buildModels: {
    routine: { model: "sonnet", effort: "medium" },
    sensitive: { model: "sonnet", effort: "high" },
    security: { model: "gpt-5.6-sol", effort: "high" }
  },
  laneCap: 5,
  spawnBudget: 30,
  deputyEnabled: false,
  deputyWaitSeconds: 1200,
  memoryFloorMb: 4096
};

export const SETUP_QUESTIONS = [
  "Which command makes judgment calls?",
  "Which models build routine, sensitive, and security work?",
  "How many lanes at once?",
  "How many agent starts tonight?",
  "Is the deputy on?",
  "How long should it wait for you before deciding?"
] as const;

export function cloneDefaults(): Settings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
}

export function parseBuildAnswers(raw: string, defaults = cloneDefaults()): Settings {
  const values = raw.split(",").map((value) => value.trim());
  const tiers: Tier[] = ["routine", "sensitive", "security"];
  for (const [index, tier] of tiers.entries()) {
    const [model, effort] = (values[index] || "").split(/[/:]/).map((value) => value.trim());
    if (model) defaults.buildModels[tier].model = model;
    if (effort) defaults.buildModels[tier].effort = effort;
  }
  return defaults;
}
