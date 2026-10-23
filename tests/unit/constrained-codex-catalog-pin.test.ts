import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { CONSTRAINED_CODEX_VERSION } from "../../packages/chat/src/live/constrained-codex-profile.js";

it("keeps constrained Codex aligned with the managed catalog and platform recipes", () => {
  const provider = PROVIDER_CATALOG["openai-compatible"];
  expect(provider.status).toBe("supported");
  if (provider.status !== "supported") throw new Error("Codex recipe must remain supported");
  expect(provider.recipe?.version).toBe(CONSTRAINED_CODEX_VERSION);
  const recipe = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/cli-runner/recipes/openai-compatible/npm-shrinkwrap.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  expect(recipe.packages["node_modules/@openai/codex"].version).toBe(CONSTRAINED_CODEX_VERSION);
  for (const arch of ["x64", "arm64"]) {
    expect(recipe.packages[`node_modules/@openai/codex-linux-${arch}`].version).toBe(
      `${CONSTRAINED_CODEX_VERSION}-linux-${arch}`
    );
  }
});
