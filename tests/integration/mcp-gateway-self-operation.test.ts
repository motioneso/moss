import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS,
  SessionTokenRegistry,
  grantSelfOperationForModule,
  type GatewaySessionRecord,
  type SelfOperationManifestInput
} from "@moss/ai";
import { calendarModuleManifest } from "@moss/calendar";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { SETTINGS_MODULE_ID, settingsModuleManifest } from "@moss/settings";
import {
  configureSportsChatTools,
  resetSportsChatToolsForTests,
  sportsModuleManifest,
  type SportsFollowsWriter
} from "@moss/sports";
import type { CreateSportsFollowRequest, SportsFollowDto } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { exampleToolCalls, exampleToolModule } from "./fixtures/example-tool-module.js";

describe("AssistantToolGateway self-operation", () => {
  let appDb: Kysely<MossDatabase>;
  let bootstrapDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repository: AiRepository;
  let tokens: SessionTokenRegistry;
  let confirmations: ConfirmationRegistry;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];

  function firstActionRequest(): { actionRequestId: string; toolName: string; summary: string } {
    const entry = emitted[0];
    if (!entry || entry.record.kind !== "action_request") {
      throw new Error("expected an action_request card to have been emitted");
    }
    return entry.record;
  }

  async function waitForActionRequest() {
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 5_000 });
    return firstActionRequest();
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    bootstrapDb = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    runner = new DataContextRunner(appDb);
    repository = new AiRepository();
  });

  afterAll(async () => {
    await bootstrapDb.destroy();
    await appDb.destroy();
  });

  beforeEach(() => {
    exampleToolCalls.length = 0;
    emitted = [];
    tokens = new SessionTokenRegistry();
    confirmations = new ConfirmationRegistry();
  });

  // ALSO-3: configureSportsChatTools sets a module-wide singleton; the sports install-grant test
  // below configures it with a fake writer and never restores it, which would otherwise leak a
  // stale fake into whatever test runs next in the same worker.
  afterEach(() => {
    resetSportsChatToolsForTests();
  });

  // #1263 Task 17: unlike gateway tests that stub getFamilyTier directly, these read the tier the
  // way production does — from the real AiRepository/DataContextRunner — so they actually prove the
  // install-grant write path and a stored user override are honored end to end.
  function dbBackedActionPolicy(ctx: { actorUserId: string; requestId: string }) {
    return {
      getFamilyTier: async (moduleId: string, familyId: string) =>
        runner.withDataContext(
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          async (scopedDb) => {
            const policies = await repository.listActionPolicies(scopedDb);
            return (
              policies.find((p) => p.moduleId === moduleId && p.actionFamilyId === familyId)
                ?.tier ?? null
            );
          }
        ),
      getFamilyManifest: async (moduleId: string, familyId: string) =>
        moduleId === exampleToolModule.id
          ? (exampleToolModule.assistantActionFamilies?.find((f) => f.id === familyId) ?? null)
          : null
    };
  }

  it("first use after install grant runs without an action card", async () => {
    const grantManifest: SelfOperationManifestInput = {
      id: exampleToolModule.id,
      assistantTools: exampleToolModule.assistantTools?.map((tool) =>
        tool.name === "example.autoWrite"
          ? { ...tool, selfOperationGrant: "granted_at_install" as const }
          : tool
      )
    };

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-install-grant-1" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );

    const installGrantGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => dbBackedActionPolicy(ctx)
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-install-grant",
      allowedToolNames: null
    });

    const res = await installGrantGateway.callTool(token, "example.autoWrite", { value: "quiet" });

    expect(res.ok).toBe(true);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);
  });

  // #1310: real tool, real gateway, real DB grant — proves affectsQueryKeys flows from the
  // manifest through to the emitted action_result end to end, not just in a synthetic unit test.
  it("real settings.themeMode.set run threads affectsQueryKeys into the emitted action_result (#1310)", async () => {
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-settings-affects-query-keys" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, settingsModuleManifest)
    );

    const settingsGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [settingsModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => ({
        getFamilyTier: async (moduleId: string, familyId: string) =>
          runner.withDataContext(
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            async (scopedDb) => {
              const policies = await repository.listActionPolicies(scopedDb);
              return (
                policies.find((p) => p.moduleId === moduleId && p.actionFamilyId === familyId)
                  ?.tier ?? null
              );
            }
          ),
        getFamilyManifest: async (moduleId: string, familyId: string) =>
          moduleId === SETTINGS_MODULE_ID
            ? (settingsModuleManifest.assistantActionFamilies?.find((f) => f.id === familyId) ??
              null)
            : null
      })
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-settings-affects-query-keys",
      allowedToolNames: null
    });

    const res = await settingsGateway.callTool(token, "settings.themeMode.set", { mode: "dark" });

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const entry = emitted[0];
    if (!entry || entry.record.kind !== "action_result") {
      throw new Error("expected an action_result record to have been emitted");
    }
    expect(entry.record.outcome).toBe("executed");
    expect(entry.record.affectsQueryKeys).toEqual(["settings.themes"]);
  });

  it("stored always_confirm override still produces an action card", async () => {
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-always-confirm-override" },
      (scopedDb) =>
        repository.setActionPolicy(scopedDb, exampleToolModule.id, "dummy", "always_confirm")
    );

    const overrideGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => dbBackedActionPolicy(ctx)
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-always-confirm-override",
      allowedToolNames: null
    });

    const call = overrideGateway.callTool(token, "example.autoWrite", { value: "quiet" });
    const request = await waitForActionRequest();

    expect(request.toolName).toBe("example.autoWrite");
    expect(exampleToolCalls).toHaveLength(0);

    await overrideGateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
    await call;
  });

  it("install grants for the calendar module still leave calendar.deleteEvent asking (user_promotable is not promoted by install)", async () => {
    const grantManifest: SelfOperationManifestInput = {
      id: calendarModuleManifest.id,
      assistantTools: calendarModuleManifest.assistantTools,
      assistantActionFamilies: calendarModuleManifest.assistantActionFamilies
    };

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-calendar-install-grant" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );

    const fakeCalendarWrite = {
      async createEvent() {
        throw new Error("should not be called — deleteEvent must confirm first");
      },
      async deleteEvent() {
        throw new Error("should not be called — deleteEvent must confirm first");
      }
    };

    function dbBackedCalendarActionPolicy(ctx: { actorUserId: string; requestId: string }) {
      return {
        getFamilyTier: async (moduleId: string, familyId: string) =>
          runner.withDataContext(
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            async (scopedDb) => {
              const policies = await repository.listActionPolicies(scopedDb);
              return (
                policies.find((p) => p.moduleId === moduleId && p.actionFamilyId === familyId)
                  ?.tier ?? null
              );
            }
          ),
        getFamilyManifest: async (_moduleId: string, familyId: string) =>
          calendarModuleManifest.assistantActionFamilies?.find((f) => f.id === familyId) ?? null
      };
    }

    const calendarGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => dbBackedCalendarActionPolicy(ctx),
      toolServices: { calendarWrite: fakeCalendarWrite }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-calendar-install-grant",
      allowedToolNames: null
    });

    const call = calendarGateway.callTool(token, "calendar.deleteEvent", {
      eventId: "some-uuid",
      displayTitle: "Board sync"
    });
    const request = await waitForActionRequest();

    expect(request.toolName).toBe("calendar.deleteEvent");

    await calendarGateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
    await call;
  });

  it("install grants for the sports module let sports.followTeam run without an action card", async () => {
    const grantManifest: SelfOperationManifestInput = {
      id: sportsModuleManifest.id,
      assistantTools: sportsModuleManifest.assistantTools,
      assistantActionFamilies: sportsModuleManifest.assistantActionFamilies
    };

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-sports-install-grant" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );

    const rows: SportsFollowDto[] = [];
    const fakeWriter: SportsFollowsWriter = {
      async list() {
        return rows;
      },
      async create(_db, input: CreateSportsFollowRequest) {
        const teamKey = input.teamKey ?? null;
        const created: SportsFollowDto = {
          id: "f-1",
          competitionKey: input.competitionKey,
          teamKey,
          createdAt: "2026-07-27T00:00:00.000Z"
        };
        rows.push(created);
        return created;
      },
      async remove(_db, id) {
        const index = rows.findIndex((r) => r.id === id);
        if (index === -1) return false;
        rows.splice(index, 1);
        return true;
      }
    };
    // This call follows a whole competition (no teamKey), which needs only catalogEntry() + the
    // repository — the league-roster lookup `followTeam` performs for a *team* follow (#1265 QA
    // BLOCKING-1a) is not reached, so an unused dataset-client stub is still fine here.
    configureSportsChatTools({} as never, fakeWriter);

    function dbBackedSportsActionPolicy(ctx: { actorUserId: string; requestId: string }) {
      return {
        getFamilyTier: async (moduleId: string, familyId: string) =>
          runner.withDataContext(
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            async (scopedDb) => {
              const policies = await repository.listActionPolicies(scopedDb);
              return (
                policies.find((p) => p.moduleId === moduleId && p.actionFamilyId === familyId)
                  ?.tier ?? null
              );
            }
          ),
        getFamilyManifest: async (_moduleId: string, familyId: string) =>
          sportsModuleManifest.assistantActionFamilies?.find((f) => f.id === familyId) ?? null
      };
    }

    const sportsGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [sportsModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => dbBackedSportsActionPolicy(ctx)
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-sports-install-grant",
      allowedToolNames: null
    });

    const res = await sportsGateway.callTool(token, "sports.followTeam", {
      competitionKey: "nfl"
    });

    expect(res.ok).toBe(true);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);
  });

  it("sports.followTeam/unfollowTeam through the gateway are RLS-isolated across actors (#1265 Task 5)", async () => {
    // Unlike the install-grant test above (fake in-memory writer), this uses the REAL
    // SportsFollowsRepository so the DB's owner-only RLS policy (migration 0133) is actually on
    // the line. `sports-follows-tool-rls.test.ts` already proves isolation one layer below the
    // gateway (calling SportsService.followTeam/unfollowTeam directly with a scoped db); this
    // proves it through the tool/gateway path — i.e. that AssistantToolGateway.callTool threads
    // *the calling token's* actorUserId into the data context, not some cached/ambient one. That
    // threading is the trust boundary self-operation introduces: these tools run with no
    // confirmation card, so nothing else stands between an untrusted call and the DB.
    const grantManifest: SelfOperationManifestInput = {
      id: sportsModuleManifest.id,
      assistantTools: sportsModuleManifest.assistantTools,
      assistantActionFamilies: sportsModuleManifest.assistantActionFamilies
    };
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-sports-rls-grant-a" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );
    await runner.withDataContext(
      { actorUserId: ids.userB, requestId: "req-sports-rls-grant-b" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );

    // Real writer (the default `new SportsFollowsRepository()` — no fake). Following/unfollowing
    // a whole competition (no teamKey) never reaches the league-roster lookup, so the dataset
    // client stub is unused and can stay untyped, same as the install-grant test above.
    configureSportsChatTools({} as never);

    function dbBackedSportsActionPolicy(ctx: { actorUserId: string; requestId: string }) {
      return {
        getFamilyTier: async (moduleId: string, familyId: string) =>
          runner.withDataContext(
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            async (scopedDb) => {
              const policies = await repository.listActionPolicies(scopedDb);
              return (
                policies.find((p) => p.moduleId === moduleId && p.actionFamilyId === familyId)
                  ?.tier ?? null
              );
            }
          ),
        getFamilyManifest: async (_moduleId: string, familyId: string) =>
          sportsModuleManifest.assistantActionFamilies?.find((f) => f.id === familyId) ?? null
      };
    }

    const sportsGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [sportsModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: (ctx) => dbBackedSportsActionPolicy(ctx)
    });

    const tokenA = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-sports-rls-a",
      allowedToolNames: null
    });
    const tokenB = tokens.mint({
      actorUserId: ids.userB,
      chatSessionId: "s-sports-rls-b",
      allowedToolNames: null
    });

    const followed = await sportsGateway.callTool(tokenA, "sports.followTeam", {
      competitionKey: "nfl"
    });
    expect(followed.ok).toBe(true);

    // The actual assertion: user B's own token, entering via the same gateway/tool path an
    // untrusted request would use, must not see or remove user A's follow. Mutation-tight against
    // the exact bug this test targets: if the gateway ever ignored the token and threaded a fixed
    // actor (e.g. userA) into the data context instead, this call would execute as userA and the
    // row WOULD be removed — `removed` would flip to `true` and the assertion below would fail.
    const bobUnfollow = await sportsGateway.callTool(tokenB, "sports.unfollowTeam", {
      competitionKey: "nfl"
    });
    expect(bobUnfollow.ok).toBe(true);
    if (bobUnfollow.ok) {
      expect(bobUnfollow.structuredData).toEqual({ removed: false });
    }

    // Positive control: user A's own call still finds and removes the row it owns — proves the
    // follow genuinely exists and user B's `removed: false` isn't vacuously true for everyone.
    const aliceUnfollow = await sportsGateway.callTool(tokenA, "sports.unfollowTeam", {
      competitionKey: "nfl"
    });
    expect(aliceUnfollow.ok).toBe(true);
    if (aliceUnfollow.ok) {
      expect(aliceUnfollow.structuredData).toEqual({ removed: true });
    }
  });

  it("installing calendar does not arm the background follow-through writer", async () => {
    // #1263 Fable security review, PR #1268: buildCalendarFollowThroughPort.executeAutoActions
    // (module-registry/src/index.ts:711) is a second, unattended reader of calendar_writeback's
    // tier — on a block_time signal it calls calendarWrite.createEvent directly, no card, no
    // chat session, no gateway. Granting trusted_auto at install would arm unattended background
    // calendar writes the instant the module is enabled. Task 1 moved createEvent to
    // user_promotable so install must not write trusted_auto for calendar_writeback at all.
    const grantManifest: SelfOperationManifestInput = {
      id: calendarModuleManifest.id,
      assistantTools: calendarModuleManifest.assistantTools,
      assistantActionFamilies: calendarModuleManifest.assistantActionFamilies
    };

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-calendar-install-grant-no-writeback" },
      (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
    );

    const writebackTier = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-calendar-install-grant-no-writeback-read" },
      async (scopedDb) => {
        const policies = await repository.listActionPolicies(scopedDb);
        return (
          policies.find(
            (p) =>
              p.moduleId === calendarModuleManifest.id && p.actionFamilyId === "calendar_writeback"
          )?.tier ?? null
        );
      }
    );

    // Tightened per Coordinator review (PR #1268): grantSelfOperationForModule only inserts rows
    // for granted_at_install families, and calendar_writeback's only owner (createEvent) is
    // user_promotable — so install must write no row at all, not merely a non-trusted_auto one.
    expect(writebackTier).toBeNull();
  });

  // Task 13 (#1264): per-actor, per-tool rate limiting on the gateway's unconfirmed auto-run
  // branches. Runaway-loop guard, not a security boundary — in-memory, restart-clearing. See the
  // coordinator's 2 binding build conditions in relay-12: (1) the limiter check on the
  // resolvePolicy==="run" branch must carry its own `risk !== "read"` guard (that branch's
  // existing guard only wraps notify+audit, not runHandler — a naive insertion would throttle
  // every read tool in the product); (2) a trip must never be silent — auto-branch degrades to
  // the existing confirmAndRun action_request path (a loop can't click a button), yolo-branch
  // hard-denies (user opted into unattended ops), and both record a distinct
  // { outcome: "denied", errorClass: "rate_limited" } audit row at the moment the limiter trips.
  describe("auto-run rate limiting", () => {
    async function readAuditRows(actorUserId: string) {
      return runner.withDataContext(
        { actorUserId, requestId: `req-audit-read-${actorUserId}` },
        (scopedDb) =>
          repository.listActionAuditLog(scopedDb, {
            since: new Date(Date.now() - 60_000),
            limit: 100
          })
      );
    }

    it("auto branch: the (max+1)th unconfirmed call in-window degrades to a confirmation card, never a silent no-op (condition 2)", async () => {
      const grantManifest: SelfOperationManifestInput = {
        id: exampleToolModule.id,
        assistantTools: exampleToolModule.assistantTools?.map((tool) =>
          tool.name === "example.autoWrite"
            ? { ...tool, selfOperationGrant: "granted_at_install" as const }
            : tool
        )
      };
      await runner.withDataContext(
        { actorUserId: ids.userB, requestId: "req-rl-auto-grant" },
        (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
      );

      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [exampleToolModule],
        repository,
        runner,
        tokens,
        confirmations,
        notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
        confirmTimeoutMs: 30_000,
        actionPolicy: (ctx) => dbBackedActionPolicy(ctx)
      });
      // #1264 Task 13: userB, not userA — an earlier test in this file
      // ("stored always_confirm override still produces an action card") permanently sets
      // (exampleToolModule.id, "dummy", userA) to tier "always_confirm" via setActionPolicy, and
      // grantSelfOperationForModule deliberately never overwrites an existing tier row (protects
      // a user's explicit choice). Reusing userA here left every call stuck on the confirm path,
      // hanging the very first loop iteration in confirmAndRun with no assertion failure.
      const token = tokens.mint({
        actorUserId: ids.userB,
        chatSessionId: "s-rl-auto",
        allowedToolNames: null
      });

      const { maxCalls } = GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS;
      for (let i = 0; i < maxCalls; i++) {
        const res = await gateway.callTool(token, "example.autoWrite", { value: `ok-${i}` });
        expect(res.ok).toBe(true);
      }
      expect(exampleToolCalls).toHaveLength(maxCalls);
      expect(emitted.every((entry) => entry.record.kind === "action_result")).toBe(true);

      const degraded = gateway.callTool(token, "example.autoWrite", { value: "throttled" });
      await vi.waitFor(
        () => expect(emitted.some((entry) => entry.record.kind === "action_request")).toBe(true),
        { timeout: 5_000 }
      );
      const request = emitted.find((entry) => entry.record.kind === "action_request");
      if (!request || request.record.kind !== "action_request") {
        throw new Error("expected an action_request card once the limit tripped");
      }
      expect(request.record.toolName).toBe("example.autoWrite");
      // Still unexecuted — the throttled call is pending confirmation, not silently dropped.
      expect(exampleToolCalls).toHaveLength(maxCalls);

      await vi.waitFor(async () => {
        const rows = await readAuditRows(ids.userB);
        expect(
          rows.some(
            (row) =>
              row.tool_name === "example.autoWrite" &&
              row.approval_mode === "auto" &&
              row.outcome === "denied" &&
              row.error_class === "rate_limited"
          )
        ).toBe(true);
      });

      await gateway.resolveActionRequest(ids.userB, request.record.actionRequestId, "cancelled");
      const finalResult = await degraded;
      expect(finalResult.ok).toBe(false);
    });

    it("the confirmation path is never rate-limited, because condition 2's degrade target must remain reachable", async () => {
      const grantManifest: SelfOperationManifestInput = {
        id: exampleToolModule.id,
        assistantTools: exampleToolModule.assistantTools?.map((tool) =>
          tool.name === "example.autoWrite"
            ? { ...tool, selfOperationGrant: "granted_at_install" as const }
            : tool
        )
      };
      await runner.withDataContext(
        { actorUserId: ids.userB, requestId: "req-rl-confirm-grant" },
        (scopedDb) => grantSelfOperationForModule(scopedDb, repository, grantManifest)
      );

      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [exampleToolModule],
        repository,
        runner,
        tokens,
        confirmations,
        notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
        confirmTimeoutMs: 30_000,
        actionPolicy: (ctx) => dbBackedActionPolicy(ctx)
      });
      // #1264 Task 13: userB — see the same-named test above for why userA is poisoned to
      // tier "always_confirm" by the earlier "stored always_confirm override" test.
      const token = tokens.mint({
        actorUserId: ids.userB,
        chatSessionId: "s-rl-confirm-still-runs",
        allowedToolNames: null
      });

      // Trip the bucket for this (actor, tool) exactly like the degrade test above.
      const { maxCalls } = GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS;
      for (let i = 0; i < maxCalls; i++) {
        const res = await gateway.callTool(token, "example.autoWrite", { value: `ok-${i}` });
        expect(res.ok).toBe(true);
      }
      const callsBeforeDegrade = exampleToolCalls.length;

      // Trip it further, well past the ceiling, to be sure the bucket stays tripped.
      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < 3; i++) {
        pending.push(gateway.callTool(token, "example.autoWrite", { value: `throttled-${i}` }));
      }
      const requests = await vi.waitFor(() => {
        const cards = emitted.filter((entry) => entry.record.kind === "action_request");
        expect(cards.length).toBeGreaterThanOrEqual(3);
        return cards;
      });
      // None of the throttled calls executed — only the confirmation cards were emitted.
      expect(exampleToolCalls).toHaveLength(callsBeforeDegrade);

      // Confirming ANY one of the degraded calls must still execute the tool: the confirm
      // path itself is never consulted against the rate limit, no matter how tripped the
      // bucket is. If it were, condition 2's degrade-to-card behavior would be a dead end —
      // the user gets a card, clicks confirm, and nothing happens (the exact silent-comply
      // failure condition 2 exists to prevent, one step further along).
      const request = requests[0];
      if (!request || request.record.kind !== "action_request") {
        throw new Error("expected an action_request card");
      }
      await gateway.resolveActionRequest(ids.userB, request.record.actionRequestId, "confirmed");
      await vi.waitFor(() => {
        expect(exampleToolCalls).toHaveLength(callsBeforeDegrade + 1);
      });

      // Clean up the remaining pending cards so the test doesn't leak open waiters.
      for (const entry of requests.slice(1)) {
        if (entry.record.kind === "action_request") {
          await gateway.resolveActionRequest(ids.userB, entry.record.actionRequestId, "cancelled");
        }
      }
      await Promise.all(pending);
    });

    it("yolo branch: the (max+1)th call in-window hard-denies with a distinct rate_limited audit row, isolated per actor and per tool (condition 2, plan step 1b)", async () => {
      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [exampleToolModule],
        repository,
        runner,
        tokens,
        confirmations,
        notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
        confirmTimeoutMs: 30_000,
        yoloMode: async () => true
      });
      const tokenA = tokens.mint({
        actorUserId: ids.userA,
        chatSessionId: "s-rl-yolo-a",
        allowedToolNames: null
      });
      const tokenB = tokens.mint({
        actorUserId: ids.userB,
        chatSessionId: "s-rl-yolo-b",
        allowedToolNames: null
      });

      const { maxCalls } = GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS;
      for (let i = 0; i < maxCalls; i++) {
        const res = await gateway.callTool(tokenA, "example.write", { value: `ok-${i}` });
        expect(res.ok).toBe(true);
      }

      const tripped = await gateway.callTool(tokenA, "example.write", { value: "throttled" });
      if (tripped.ok || !("denied" in tripped)) {
        throw new Error("expected a rate-limit denial, got: " + JSON.stringify(tripped));
      }
      expect(tripped.denied).toBe(true);

      await vi.waitFor(async () => {
        const rows = await readAuditRows(ids.userA);
        expect(
          rows.some(
            (row) =>
              row.tool_name === "example.write" &&
              row.approval_mode === "yolo" &&
              row.outcome === "denied" &&
              row.error_class === "rate_limited"
          )
        ).toBe(true);
      });

      // Per-tool isolation: same actor, a different tool's bucket is untouched.
      const otherTool = await gateway.callTool(tokenA, "example.autoWrite", { value: "fresh" });
      expect(otherTool.ok).toBe(true);

      // Per-actor isolation: a different actor's bucket for the SAME tool is untouched.
      const otherActor = await gateway.callTool(tokenB, "example.write", { value: "fresh" });
      expect(otherActor.ok).toBe(true);
    });

    it("read tools are never rate-limited even hammered well past the ceiling (condition 1 regression guard)", async () => {
      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [exampleToolModule],
        repository,
        runner,
        tokens,
        confirmations,
        notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
        confirmTimeoutMs: 30_000
      });
      const token = tokens.mint({
        actorUserId: ids.userA,
        chatSessionId: "s-rl-read",
        allowedToolNames: null
      });

      const attempts = GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS.maxCalls + 5;
      for (let i = 0; i < attempts; i++) {
        const res = await gateway.callTool(token, "example.read", { value: `read-${i}` });
        expect(res.ok).toBe(true);
      }
      expect(exampleToolCalls).toHaveLength(attempts);
      expect(emitted).toHaveLength(0);
    });
  });

  it("the planned built-in confirm_always tools remain the only confirmation declarations", () => {
    const confirmAlwaysTools: string[] = [];
    for (const manifest of getBuiltInModuleManifests()) {
      for (const tool of manifest.assistantTools ?? []) {
        if (tool.selfOperationGrant === "confirm_always") {
          confirmAlwaysTools.push(tool.name);
        }
      }
    }

    // web.read has no actionFamilyId, while Sports source writes share a non-promotable family;
    // all remain explicit confirmation-only declarations.
    expect(confirmAlwaysTools.sort()).toEqual(
      [
        "email.sendReply",
        "memory.forget",
        "people.merge",
        "people.splitIdentity",
        "sports.confirmSource",
        "sports.confirmSourceAssignments",
        "sports.confirmSourceRecipe",
        "sports.removeSource",
        "sports.retrySource",
        "web.read"
      ].sort()
    );
  });
});
