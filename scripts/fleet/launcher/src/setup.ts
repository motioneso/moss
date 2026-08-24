import type { Settings, Tier } from "./types.js";

// The only place the launcher seeds model names. They are user-editable data after setup.
export const DEFAULT_SETTINGS: Settings = {
  judgeCmd: "claude -p",
  buildModels: {
    routine: { tool: "claude", model: "sonnet", effort: "medium" },
    sensitive: { tool: "claude", model: "sonnet", effort: "high" },
    security: { tool: "claude", model: "opus", effort: "high" }
  },
  laneCap: 5,
  spawnBudget: 30,
  deputyEnabled: false,
  deputyWaitSeconds: 1200,
  memoryFloorMb: 4096
};

export const SETUP_QUESTIONS = [
  "Which command makes judgment calls?",
  "Which programs and models build routine, sensitive, and security work? (run scripts/fleet/models.sh to see what is installed)",
  "How many lanes at once?",
  "How many agent starts tonight?",
  "Is the deputy on?",
  "How long should it wait for you before deciding?"
] as const;

export function cloneDefaults(): Settings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
}

// Each answer is "program/model/effort". Two parts are read as "model/effort"
// so an answer written before programs were configurable still means what it
// did, and the program already set for that kind of work is kept.
export function parseBuildAnswers(raw: string, defaults = cloneDefaults()): Settings {
  const values = raw.split(",").map((value) => value.trim());
  const tiers: Tier[] = ["routine", "sensitive", "security"];
  for (const [index, tier] of tiers.entries()) {
    const parts = (values[index] || "")
      .split(/[/:]/)
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const [tool, model, effort] = parts.length >= 3 ? parts : [undefined, ...parts];
    if (tool) defaults.buildModels[tier].tool = tool;
    if (model) defaults.buildModels[tier].model = model;
    if (effort) defaults.buildModels[tier].effort = effort;
  }
  return defaults;
}
