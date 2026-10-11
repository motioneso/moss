import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRepository, registerAiRoutes } from "@moss/ai";
import {
  createActAsGrantRegistry,
  withActAsGrantsAndRequestCache,
  type MossAuthRuntime
} from "@moss/auth";
import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import { createRouteCatalogHolder } from "@moss/module-registry";
import { createAppActionsService } from "../../packages/chat/src/app-actions.js";
import { registerThemeRoutes } from "../../packages/settings/src/themes-routes.js";
import {
  appActionActor,
  appActionCatalog,
  appActionContext,
  appActionManifests,
  makeAppActionGateway
} from "../fixtures/app-actions-gateway.js";
import { APP_ACTION_THEME, APP_ACTION_THEME_PATH } from "../uat/specs/app-actions-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("named theme approval through real HTTP, gateway and act-as routes", () => {
  it("retains disclosure across hydration and applies the approved theme exactly once", async () => {
    const preferences = new Map<string, unknown>([
      ["themes.custom", [APP_ACTION_THEME]],
      ["themes.active", "light"]
    ]);
    const runner = {
      withDataContext: async <T>(
        _access: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => {
        const scope = {
          [dataContextBrand]: true,
          db: {
            selectFrom: (table: string) => {
              let key = "";
              const query = {
                select: () => query,
                where: (_column: string, _op: string, value: string) => {
                  key = value;
                  return query;
                },
                executeTakeFirst: async () =>
                  table === "app.instance_settings"
                    ? undefined
                    : { value_json: preferences.get(key) }
              };
              return query;
            }
          }
        } as unknown as DataContextDb;
        return work(scope);
      }
    } as DataContextRunner;
    const server = Fastify();
    const grants = createActAsGrantRegistry();
    const auth = withActAsGrantsAndRequestCache(
      {
        resolveAccessContext: async () => ({
          actorUserId: appActionActor,
          requestId: "browser-fixture"
        })
      } as unknown as MossAuthRuntime,
      grants
    ).authRuntime;
    const resolveAccessContext = auth.resolveAccessContext.bind(auth);
    const upsert = vi.fn(async (_db: DataContextDb, key: string, value: unknown) => {
      preferences.set(key, value);
    });
    registerThemeRoutes(server, {
      dataContext: runner,
      resolveAccessContext,
      preferencesRepository: {
        get: async (_db, key) => preferences.get(key),
        getWithMetadata: async () => null,
        upsert
      }
    });
    const repository = new AiRepository();
    let action: Awaited<ReturnType<AiRepository["createPendingAssistantAction"]>> | undefined;
    vi.spyOn(repository, "createPendingAssistantAction").mockImplementation(async (_db, input) => {
      action = {
        id: "44444444-4444-4444-8444-444444444444",
        owner_user_id: appActionActor,
        chat_thread_id: input.chatThreadId ?? null,
        outcome_recorded_at: null,
        outcome_ignored_at: null,
        chat_session_id: input.chatSessionId ?? null,
        expires_at: input.expiresAt ?? null,
        tool_module_id: input.toolModuleId,
        tool_module_name: input.toolModuleName,
        tool_name: input.toolName,
        permission_id: input.permissionId,
        risk: input.risk,
        status: "pending",
        input_summary: input.inputSummary,
        request_id: input.requestId ?? null,
        requested_at: new Date(),
        updated_at: new Date(),
        resolved_at: null
      };
      return { ...action };
    });
    vi.spyOn(repository, "getAssistantAction").mockImplementation(async (_db, id) =>
      action?.id === id ? { ...action } : undefined
    );
    vi.spyOn(repository, "listAssistantActions").mockImplementation(async () =>
      action ? [{ ...action }] : []
    );
    vi.spyOn(repository, "resolveAssistantAction").mockImplementation(async (_db, id, input) => {
      if (!action || action.id !== id || action.status !== "pending") return undefined;
      if (
        input.status === "confirmed" &&
        action.expires_at &&
        new Date(action.expires_at).getTime() <= Date.now()
      )
        return undefined;
      action = { ...action, status: input.status, resolved_at: new Date(), updated_at: new Date() };
      return { ...action };
    });
    vi.spyOn(repository, "insertActionAuditLog").mockResolvedValue(undefined);
    const catalog = createRouteCatalogHolder();
    catalog.set(appActionCatalog);
    const appActions = createAppActionsService({ server, catalog, grants, readTurnId: () => null });
    const h = makeAppActionGateway({
      runner,
      repository,
      appActions,
      autoApprove: false,
      confirmTimeoutMs: 10_000,
      provenance: {
        isTainted: async () => true,
        isMarked: async () => true,
        recordAdmission: async () => {},
        runAutomatic: async () => ({ kind: "confirm" })
      }
    });
    registerAiRoutes(server, {
      dataContext: runner,
      repository,
      resolveAccessContext,
      resolveActiveModules: async () => appActionManifests,
      getActionRequestPresentation: (actor, id) =>
        h.gateway.getActionRequestPresentation(actor, id),
      resolveActionRequest: (actor, id, status) => h.gateway.resolveActionRequest(actor, id, status)
    });
    await server.ready();
    try {
      // SQL/auth identity are fixture ports; HTTP validation, gateway, disclosure,
      // confirmation completion, bound app transport and theme handler are production code.
      const pending = h.call({
        method: "PUT",
        path: APP_ACTION_THEME_PATH,
        body: { id: APP_ACTION_THEME.id }
      });
      await vi.waitFor(() => expect(h.events[0]?.kind).toBe("action_request"));
      expect(action?.status).toBe("pending");
      const actionId = action!.id;
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const hydrated = await server.inject({
          url: `/api/ai/assistant-actions?threadId=${appActionContext.threadId}`
        });
        expect(hydrated.statusCode).toBe(200);
        expect(hydrated.json()).toMatchObject({
          actions: [
            {
              id: actionId,
              approvalAvailable: true,
              presentation: { summary: "Switch your theme", outsideContentNotice: true }
            }
          ]
        });
      }
      expect((await server.inject({ url: "/api/me/themes" })).json()).toMatchObject({
        activeId: "light"
      });
      const resolved = await server.inject({
        method: "POST",
        url: `/api/ai/assistant-actions/${actionId}/resolve`,
        payload: { status: "confirmed" }
      });
      expect(resolved.statusCode).toBe(200);
      expect(await pending).toMatchObject({ ok: true });
      expect((await server.inject({ url: "/api/me/themes" })).json()).toMatchObject({
        activeId: APP_ACTION_THEME.id
      });
      expect(upsert).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "themes.active",
        APP_ACTION_THEME.id
      );
      expect(h.events.at(-1)).toMatchObject({
        kind: "action_result",
        outcome: "executed",
        decidedBy: "person",
        affectsModules: ["settings"]
      });
      expect(
        (
          await server.inject({
            method: "POST",
            url: `/api/ai/assistant-actions/${actionId}/resolve`,
            payload: { status: "confirmed" }
          })
        ).statusCode
      ).toBe(404);
      expect(upsert).toHaveBeenCalledOnce();
    } finally {
      h.gateway.disposeActionRecovery();
      await server.close();
    }
  });
});
