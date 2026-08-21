import { describe, expect, it } from "vitest";

import { createActiveExternalModulesResolverForApi } from "../../apps/api/src/external-module-tools.js";
import type { ExternalModuleDiscovery, ExternalModuleStateInput } from "@moss/module-registry";

// #1753 — a draft module is fanned out to its owner alone until it ships (Task 8).

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const discovery: ExternalModuleDiscovery = {
  id: "videos-draft",
  dir: "/modules/videos-draft",
  manifest: {
    id: "videos-draft",
    name: "Videos (draft)",
    version: "0.0.1",
    publisher: "test"
  } as ExternalModuleDiscovery["manifest"],
  manifestHash: "manifest-hash",
  packageHash: "package-hash"
};

const draftState = (ownerUserId: string): ExternalModuleStateInput => ({
  id: "videos-draft",
  status: "draft",
  packageHash: "package-hash",
  disabledReason: null,
  ownerUserId
});

const buildResolver = (actorUserId: string, states: readonly ExternalModuleStateInput[]) =>
  createActiveExternalModulesResolverForApi({
    discoveries: () => [discovery],
    appDataContext: {
      withDataContext: async (_accessContext: unknown, run: (db: never) => unknown) => run({} as never)
    } as never,
    settingsRepository: {
      listExternalModuleStates: async () => states,
      listModuleDenyRowsForActor: async () => []
    } as never
  });

describe("createActiveExternalModulesResolverForApi draft ownership (#1753)", () => {
  it("includes a caller's own draft in their active module list", async () => {
    const resolver = buildResolver(USER_A, [draftState(USER_A)]);
    const active = await resolver({ actorUserId: USER_A, requestId: "req-1" } as never);
    expect(active.map((module) => module.id)).toContain("videos-draft");
  });

  it("excludes another user's draft from the active module list", async () => {
    const resolver = buildResolver(USER_B, [draftState(USER_A)]);
    const active = await resolver({ actorUserId: USER_B, requestId: "req-2" } as never);
    expect(active.map((module) => module.id)).not.toContain("videos-draft");
  });
});
