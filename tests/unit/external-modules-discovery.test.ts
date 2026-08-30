import { expect, it } from "vitest";

import { createExternalActiveModulesResolver } from "../../apps/api/src/external-module-tools.js";

// #996/#860: the JARVIS_ENABLE_EXTERNAL_MODULES gate is removed — discoverExternalModules
// (server.ts) is now an unconditional disk walk with no "disabled" branch left to test here.

it("keeps external tools only when DB reconciliation says active", async () => {
  const builtIn = {
    id: "settings",
    name: "Settings",
    version: "1",
    publisher: "Jarv1s",
    lifecycle: "required" as const,
    compatibility: { jarv1s: ">=0" }
  };
  const external = { ...builtIn, id: "acme", name: "Acme", lifecycle: "optional" as const };
  const resolver = createExternalActiveModulesResolver(
    async () => [builtIn, external],
    () => new Set([external.id]),
    async () => [{ id: "acme" }]
  );
  await expect(resolver("actor")).resolves.toEqual([builtIn, external]);
  const disabled = createExternalActiveModulesResolver(
    async () => [builtIn, external],
    () => new Set([external.id]),
    async () => []
  );
  await expect(disabled("actor")).resolves.toEqual([builtIn]);
});
