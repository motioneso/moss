import { describe, expect, it, vi } from "vitest";
import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import type { ModuleCredentialCipher } from "@moss/settings";
import type { Kysely } from "kysely";

import { createVerifiedExternalModuleInvoker } from "../../apps/worker/src/external-module-invoke.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER_ACTOR = "00000000-0000-4000-8000-000000000002";
const MANIFEST_HASH = "sha256:manifest";
const PACKAGE_HASH = "sha256:package";

type State = {
  status: "enabled" | "disabled" | "draft";
  manifest_hash: string;
  package_hash: string;
  owner_user_id: string | null;
};

function workerDb(state: State | undefined): Kysely<MossDatabase> {
  const builder = {
    selectFrom: () => builder,
    select: () => builder,
    where: () => builder,
    executeTakeFirst: async () => state
  };
  return builder as unknown as Kysely<MossDatabase>;
}

function moduleDiscovery(): ExternalModuleDiscovery {
  return {
    id: "workshop-word",
    dir: "/unused",
    manifest: {} as ExternalModuleDiscovery["manifest"],
    manifestHash: MANIFEST_HASH,
    packageHash: PACKAGE_HASH
  };
}

function args(actorUserId = OWNER) {
  return {
    moduleId: "workshop-word",
    handler: "word.read",
    actorUserId,
    requestId: "request-1",
    jobKind: "workshop",
    idempotencyKey: "workshop-1",
    params: {},
    lane: "queue:workshop-word.read" as const,
    toolRisk: "read" as const
  };
}

function build(options: {
  state?: State;
  activeUsers?: readonly string[];
  discovered?: ExternalModuleDiscovery;
  runtime?: (module: unknown, handler: string, input: unknown) => Promise<unknown>;
}) {
  const discovery = options.discovered ?? moduleDiscovery();
  const invoke = vi.fn(options.runtime ?? (async () => ({ value: "ok" })));
  const invoker = createVerifiedExternalModuleInvoker({
    workerDb: workerDb(options.state),
    getDiscoveryById: (id) => (id === discovery.id ? discovery : undefined),
    listDiscoveredModuleIds: () => [discovery.id],
    dataContext: {
      withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
        fn({} as DataContextDb)
    } as unknown as DataContextRunner,
    cipher: {} as ModuleCredentialCipher,
    runtime: { invoke },
    listActiveUserIds: async () => options.activeUsers ?? [OWNER]
  });
  return { invoker, invoke, discovery };
}

const noopDataContext = {
  withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
    fn({} as DataContextDb)
} as unknown as DataContextRunner;

const enabled = (): State => ({
  status: "enabled",
  manifest_hash: MANIFEST_HASH,
  package_hash: PACKAGE_HASH,
  owner_user_id: null
});

const draft = (ownerUserId = OWNER): State => ({
  status: "draft",
  manifest_hash: MANIFEST_HASH,
  package_hash: PACKAGE_HASH,
  owner_user_id: ownerUserId
});

describe("verified external module invocation draft gate", () => {
  it("runs the exact active owner’s draft when both hashes match", async () => {
    const { invoker, invoke } = build({ state: draft() });

    await expect(invoker(args())).resolves.toEqual({ ok: true, result: { value: "ok" } });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("keeps drafts owner-only for another active admin or user", async () => {
    const activeOther = build({ state: draft(OTHER_ACTOR), activeUsers: [OWNER] });
    await expect(activeOther.invoker(args())).resolves.toEqual({
      ok: false,
      reason: "not-enabled"
    });
    expect(activeOther.invoke).not.toHaveBeenCalled();

    const inactiveOther = build({ state: draft(), activeUsers: [OWNER] });
    await expect(inactiveOther.invoker(args(OTHER_ACTOR))).resolves.toEqual({
      ok: false,
      reason: "not-active"
    });
    expect(inactiveOther.invoke).not.toHaveBeenCalled();
  });

  it("rejects stale manifest or package hashes before runtime construction", async () => {
    for (const key of ["manifest_hash", "package_hash"] as const) {
      const state = draft();
      state[key] = "sha256:stale";
      const fixture = build({ state });
      await expect(fixture.invoker(args())).resolves.toEqual({
        ok: false,
        reason: "hash-mismatch"
      });
      expect(fixture.invoke).not.toHaveBeenCalled();
    }
  });

  it("preserves enabled behavior and rejects disabled, missing, and undiscovered modules", async () => {
    const enabledFixture = build({ state: enabled() });
    await expect(enabledFixture.invoker(args())).resolves.toMatchObject({ ok: true });
    expect(enabledFixture.invoke).toHaveBeenCalledOnce();

    const disabled = build({ state: { ...enabled(), status: "disabled" } });
    await expect(disabled.invoker(args())).resolves.toEqual({ ok: false, reason: "not-enabled" });
    expect(disabled.invoke).not.toHaveBeenCalled();

    const missing = build({ state: undefined });
    await expect(missing.invoker(args())).resolves.toEqual({ ok: false, reason: "not-enabled" });
    expect(missing.invoke).not.toHaveBeenCalled();

    // An absent discovery is represented by a resolver returning undefined, while the
    // diagnostic list remains empty; keep the fixture explicit so this tests that branch.
    const runtime = vi.fn(async () => ({ value: "should-not-run" }));
    const noDiscovery = createVerifiedExternalModuleInvoker({
      workerDb: workerDb(enabled()),
      getDiscoveryById: () => undefined,
      listDiscoveredModuleIds: () => [],
      dataContext: noopDataContext,
      cipher: {} as ModuleCredentialCipher,
      runtime: { invoke: runtime },
      listActiveUserIds: async () => [OWNER]
    });
    await expect(noDiscovery(args())).resolves.toEqual({ ok: false, reason: "not-discovered" });
    expect(runtime).not.toHaveBeenCalled();
  });
});
