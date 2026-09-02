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

it("re-reads the external module id set on every call instead of once at construction (#1902)", async () => {
  const builtIn = {
    id: "settings",
    name: "Settings",
    version: "1",
    publisher: "Jarv1s",
    lifecycle: "required" as const,
    compatibility: { jarv1s: ">=0" }
  };
  const external = { ...builtIn, id: "acme", name: "Acme", lifecycle: "optional" as const };
  let externalModuleIds = new Set<string>();
  const resolver = createExternalActiveModulesResolver(
    async () => [builtIn, external],
    () => externalModuleIds,
    async () => []
  );

  // No external module ids yet: short-circuits to resolveEnabledModules, so the
  // not-yet-active external module still shows up.
  await expect(resolver("actor")).resolves.toEqual([builtIn, external]);

  // The same resolver, called again after the module is registered as external and
  // inactive, now filters it out - proving the getter is read fresh per call rather
  // than the size-0 short-circuit being decided once at construction.
  externalModuleIds = new Set([external.id]);
  await expect(resolver("actor")).resolves.toEqual([builtIn]);
});
