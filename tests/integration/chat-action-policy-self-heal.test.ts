import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildChatGatewayDependencies } from "../../packages/chat/src/routes.js";
import { AiRepository } from "../../packages/ai/src/repository.js";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord,
  type SessionNotifier
} from "@moss/ai";
import type { MossModuleManifest, ModuleAssistantToolManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";
import {
  LEGACY_AGENCY_AUTO_EXECUTE_KEY,
  TASK_CHANGES_POLICY_KEY
} from "../../packages/tasks/src/action-policy.js";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

function tool(
  name: string,
  overrides: Partial<ModuleAssistantToolManifest> = {}
): ModuleAssistantToolManifest {
  return {
    name,
    description: name,
    permissionId: "test.permission",
    risk: "write",
    executionPolicy: "auto",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ data: {} }),
    ...overrides
  };
}

const testModule: MossModuleManifest = {
  id: "test-self-heal-mod",
  name: "Test Self Heal",
  version: "0.1.0",
  publisher: "test",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  assistantTools: [
    tool("test-self-heal-mod.installGranted", {
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "family-heal"
    }),
    tool("test-self-heal-mod.confirmAlways", {
      selfOperationGrant: "confirm_always",
      actionFamilyId: "family-confirm"
    })
  ]
};

/** Mirrors the real tasks module's single granted_at_install family (task_changes) — the
 * hardcoded `moduleId === "tasks"` compat branch in routes.ts only engages for this exact id. */
const tasksShapedModule: MossModuleManifest = {
  id: "tasks",
  name: "Tasks (test double)",
  version: "0.1.0",
  publisher: "test",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  assistantTools: [
    tool("tasks.create", {
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "task_changes"
    })
  ]
};

describe("chat action policy self-heal (getFamilyTier, real DB via buildChatGatewayDependencies)", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repository: AiRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    runner = new DataContextRunner(appDb);
    repository = new AiRepository();
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  function actionPolicyFor(
    actorUserId: string,
    overrides: {
      agencyPreferences?: PreferencesRepository;
      resolveModule?: MossModuleManifest;
    } = {}
  ) {
    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [overrides.resolveModule ?? testModule],
      repository,
      runner,
      tokens: {} as unknown as SessionTokenRegistry,
      confirmations: {} as unknown as ConfirmationRegistry,
      notifier: {} as unknown as SessionNotifier,
      agencyPreferences: overrides.agencyPreferences,
      collaborators: {}
    });
    const factory = deps.actionPolicy as unknown as (ctx: {
      actorUserId: string;
      requestId: string;
    }) => {
      getFamilyTier: (moduleId: string, familyId: string) => Promise<string | null>;
    };
    return factory({ actorUserId, requestId: `req-${actorUserId}` });
  }

  it("heals a granted_at_install family with no prior row, no explicit enable action having run", async () => {
    const policy = actionPolicyFor(ids.userA);
    const tier = await policy.getFamilyTier("test-self-heal-mod", "family-heal");
    expect(tier).toBe("trusted_auto");
  });

  it("never overrides an explicit always_confirm choice (revocation survival)", async () => {
    await runner.withDataContext({ actorUserId: ids.userB, requestId: "req-preset" }, (scopedDb) =>
      repository.setActionPolicy(scopedDb, "test-self-heal-mod", "family-heal", "always_confirm")
    );

    const policy = actionPolicyFor(ids.userB);
    const tier = await policy.getFamilyTier("test-self-heal-mod", "family-heal");
    expect(tier).toBe("always_confirm");
  });

  it("never heals a confirm_always family (no row created, tier stays null)", async () => {
    const policy = actionPolicyFor(ids.adminUser);
    const tier = await policy.getFamilyTier("test-self-heal-mod", "family-confirm");
    expect(tier).toBeNull();

    const policies = await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req-confirm-check" },
      (scopedDb) => repository.listActionPolicies(scopedDb)
    );
    const stored = policies.find(
      (p) => p.moduleId === "test-self-heal-mod" && p.actionFamilyId === "family-confirm"
    );
    expect(stored).toBeUndefined();
  });

  it("#1311 finding #2: task_changes never falls through to the generic self-heal when preferences is absent, even with a legacy revocation on file", async () => {
    const actorUserId = ids.userA;
    await runner.withDataContext({ actorUserId, requestId: "req-legacy-seed" }, (scopedDb) =>
      new PreferencesRepository().upsert(scopedDb, LEGACY_AGENCY_AUTO_EXECUTE_KEY, false)
    );

    // No agencyPreferences wired — the exact shape of a caller that omits the optional port.
    const policy = actionPolicyFor(actorUserId, { resolveModule: tasksShapedModule });
    const tier = await policy.getFamilyTier("tasks", "task_changes");
    expect(tier).toBeNull();

    // And critically: no row got written to the generic action_policies table either — the
    // guard skips the heal entirely rather than just masking its result.
    const policies = await runner.withDataContext(
      { actorUserId, requestId: "req-legacy-check" },
      (scopedDb) => repository.listActionPolicies(scopedDb)
    );
    const stored = policies.find(
      (p) => p.moduleId === "tasks" && p.actionFamilyId === "task_changes"
    );
    expect(stored).toBeUndefined();
  });

  it("task_changes still resolves through the compat helper (and honors the legacy revocation) once preferences is wired", async () => {
    const actorUserId = ids.userB;
    const agencyPreferences = new PreferencesRepository();
    await runner.withDataContext({ actorUserId, requestId: "req-legacy-seed-2" }, (scopedDb) =>
      agencyPreferences.upsert(scopedDb, LEGACY_AGENCY_AUTO_EXECUTE_KEY, false)
    );

    const policy = actionPolicyFor(actorUserId, {
      resolveModule: tasksShapedModule,
      agencyPreferences
    });
    const tier = await policy.getFamilyTier("tasks", "task_changes");
    expect(tier).toBe("ask_each_time");
  });

  it("composed path: a real chat tool call through the real gateway self-heals the real tasks module, and never touches a bystander actor", async () => {
    // ids.userC/userD are never referenced by the getFamilyTier-only tests above, so this
    // test's "absent before dispatch" assertion never depends on suite execution order.
    const dispatchedActorId = ids.userC;
    const bystanderActorId = ids.userD;

    async function readPreference(actorUserId: string, key: string): Promise<unknown> {
      return runner.withDataContext(
        { actorUserId, requestId: `req-read-${randomUUID()}` },
        (scopedDb) => new PreferencesRepository().get(scopedDb, key)
      );
    }

    // Read storage directly — no gateway, no getFamilyTier, no self-heal resolver in the path.
    expect(await readPreference(dispatchedActorId, TASK_CHANGES_POLICY_KEY)).toBeNull();
    expect(await readPreference(dispatchedActorId, LEGACY_AGENCY_AUTO_EXECUTE_KEY)).toBeNull();
    expect(await readPreference(bystanderActorId, TASK_CHANGES_POLICY_KEY)).toBeNull();
    expect(await readPreference(bystanderActorId, LEGACY_AGENCY_AUTO_EXECUTE_KEY)).toBeNull();

    const records: GatewaySessionRecord[] = [];
    const notifier: SessionNotifier = {
      emit(_chatSessionId, record) {
        records.push(record);
      }
    };
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();

    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [tasksModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier,
      agencyPreferences: new PreferencesRepository(),
      collaborators: {}
    });
    const gateway = new AssistantToolGateway(deps);

    const chatSessionId = randomUUID();
    const token = tokens.mint({
      actorUserId: dispatchedActorId,
      chatSessionId,
      allowedToolNames: null
    });

    const result = await gateway.callTool(token, "tasks.create", {
      title: "Composed self-heal proof"
    });
    expect(result.ok).toBe(true);

    // Exactly one action_result, never an action_request: this is an auto-run tool and the
    // actor was never asked for confirmation.
    expect(records.map((record) => record.kind)).toEqual(["action_result"]);

    // Read storage directly again — the dispatch healed the canonical key...
    expect(await readPreference(dispatchedActorId, TASK_CHANGES_POLICY_KEY)).toBe("trusted_auto");
    // ...without manufacturing the legacy key...
    expect(await readPreference(dispatchedActorId, LEGACY_AGENCY_AUTO_EXECUTE_KEY)).toBeNull();
    // ...and the generic action-policy reader (used by the settings UI) agrees with the direct
    // preference read above: one row, tasks/task_changes, trusted_auto.
    const dispatchedActorPolicies = await runner.withDataContext(
      { actorUserId: dispatchedActorId, requestId: `req-check-${randomUUID()}` },
      (scopedDb) => repository.listActionPolicies(scopedDb)
    );
    expect(
      dispatchedActorPolicies.find(
        (p) => p.moduleId === "tasks" && p.actionFamilyId === "task_changes"
      )
    ).toEqual({ moduleId: "tasks", actionFamilyId: "task_changes", tier: "trusted_auto" });

    // The bystander actor, who was never dispatched against, still has neither key.
    expect(await readPreference(bystanderActorId, TASK_CHANGES_POLICY_KEY)).toBeNull();
    expect(await readPreference(bystanderActorId, LEGACY_AGENCY_AUTO_EXECUTE_KEY)).toBeNull();
  });
});
