import { expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { CONSTRAINED_CLAUDE_VERSION } from "../../packages/chat/src/live/constrained-claude-profile.js";
it("keeps the constrained summary pin synchronized with the managed Claude recipe", () => {
  const provider = PROVIDER_CATALOG.anthropic;
  expect(provider.status).toBe("supported");
  if (provider.status !== "supported") throw new Error("Claude recipe must remain supported");
  expect(provider.recipe?.version).toBe(CONSTRAINED_CLAUDE_VERSION);
});
