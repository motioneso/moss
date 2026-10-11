import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createActAsGrantRegistry } from "@moss/auth";
import type { DataContextRunner } from "@moss/db";
import { createRouteCatalogHolder } from "@moss/module-registry";
import { ApprovalInputError } from "@moss/module-sdk";
import { putWeatherUnitRouteSchema } from "@moss/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppActionsService } from "../../packages/chat/src/app-actions.js";
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";
import {
  appActionActor,
  appActionCatalog,
  appActionContext,
  appActionManifests,
  makeAppActionGateway
} from "../fixtures/app-actions-gateway.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const correction = "Keep placed calendar blocks in the draft before saving.";
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function harness(kind: "schema" | "route presentation" | "dedicated presentation") {
  const server = Fastify();
  servers.push(server);
  const handler = vi.fn(async () => ({ unit: "metric" }));
  const execute = vi.fn(async () => ({ data: {} }));
  server.put("/api/me/weather-unit", { schema: putWeatherUnitRouteSchema }, handler);
  const catalog = createRouteCatalogHolder();
  catalog.set(appActionCatalog);
  const grants = createActAsGrantRegistry();
  const mint = vi.spyOn(grants, "mint");
  const appActions = createAppActionsService({ server, catalog, grants, readTurnId: () => null });
  if (kind === "route presentation") {
    const original = appActionCatalog.resolve("PUT", "/api/me/weather-unit")!;
    const route = {
      ...original.route,
      policy: {
        ...original.route.policy,
        presentation: async () => {
          throw new ApprovalInputError(correction);
        }
      }
    };
    vi.spyOn(appActions, "catalog").mockReturnValue({
      routes: [route],
      resolve: () => ({ route, params: {} }),
      search: () => []
    });
  }
  const { scoped } = makeRecordingDb({ rows: [] });
  const runner = {
    withDataContext: async (_access: unknown, run: (db: unknown) => unknown) => run(scoped)
  } as DataContextRunner;
  const h = makeAppActionGateway({
    runner,
    appActions,
    autoApprove: false,
    provenance: { isTainted: async () => true, recordAdmission: async () => undefined },
    resolveActiveModules: async () =>
      appActionManifests.map((manifest) => ({
        ...manifest,
        assistantTools: manifest.assistantTools?.map((tool) =>
          kind === "dedicated presentation" && tool.name === "settings.themeMode.set"
            ? {
                ...tool,
                // Only an approval card consults the presentation, so the write must ask.
                executionPolicy: "confirm" as const,
                execute,
                approvalPresentation: async () => {
                  throw new ApprovalInputError(correction);
                }
              }
            : tool
        )
      }))
  });
  const call = vi.spyOn(h.gateway, "callTool");
  const transport = vi.spyOn(appActions, "call");
  registerMcpTransportRoute(server, { gateway: h.gateway, tokens: h.dependencies.tokens });
  await server.ready();
  const token = h.dependencies.tokens.mint({
    actorUserId: appActionActor,
    chatSessionId: appActionContext.chatSessionId,
    threadId: appActionContext.threadId,
    allowedToolNames: new Set(["app.callAction", "settings.themeMode.set"])
  });
  return { ...h, server, token, call, transport, handler, execute, mint };
}

describe.each(["JSON", "SSE"] as const)(
  "validation corrections through real MCP %s transport",
  (mode) => {
    it.each(["schema", "route presentation", "dedicated presentation"] as const)(
      "delivers %s corrections as SDK-valid text without executing or approving a write",
      async (kind) => {
        const h = await harness(kind);
        const input =
          kind === "dedicated presentation"
            ? { mode: "dark" }
            : {
                method: "PUT",
                path: "/api/me/weather-unit",
                body: { unit: kind === "schema" ? "rankine" : "metric" }
              };
        const original = structuredClone(input);
        const response = await h.server.inject({
          method: "POST",
          url: "/api/mcp",
          headers: {
            authorization: `Bearer ${h.token}`,
            accept: mode === "SSE" ? "text/event-stream" : "application/json"
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: kind === "dedicated presentation" ? "settings.themeMode.set" : "app.callAction",
              arguments: input,
              ...(mode === "SSE" ? { _meta: { progressToken: "validation-correction" } } : {})
            }
          }
        });
        expect(response.statusCode).toBe(200);
        const frame =
          mode === "JSON"
            ? response.json()
            : JSON.parse(
                response.body
                  .split("\n")
                  .filter((line) => line.startsWith("data: "))
                  .at(-1)!
                  .slice(6)
              );
        expect(frame).toMatchObject({ jsonrpc: "2.0", id: 1 });
        expect(frame.error).toBeUndefined();
        // This is the MCP client's actual result schema, after real HTTP/SSE serialization.
        const parsed = CallToolResultSchema.parse(frame.result);
        expect(parsed.isError).toBe(false);
        expect(parsed.content).toHaveLength(1);
        const content = parsed.content[0]!;
        expect(content.type).toBe("text");
        if (content.type !== "text") throw new Error("Expected MCP text correction");
        const gatewayResponse = await h.call.mock.results[0]!.value;
        expect(gatewayResponse.ok).toBe(true);
        if (!gatewayResponse.ok) throw new Error("Expected validation business result");
        expect(gatewayResponse.data).toEqual({ text: content.text });
        expect(JSON.parse(content.text)).toEqual(gatewayResponse.structuredData);
        expect(gatewayResponse.structuredData).toMatchObject({
          ok: false,
          status: 400,
          body: { code: "invalid_input", error: expect.any(String) }
        });
        if (kind === "schema") {
          expect(content.text).toContain("Invalid body/unit");
          expect(content.text).toContain("metric");
          expect(content.text).toContain("imperial");
          expect(content.text).not.toContain("rankine");
        } else {
          expect(gatewayResponse.structuredData?.body).toEqual({
            code: "invalid_input",
            error: correction
          });
        }
        expect(input).toEqual(original);
        expect(h.handler).not.toHaveBeenCalled();
        expect(h.execute).not.toHaveBeenCalled();
        expect(h.mint).not.toHaveBeenCalled();
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.repository.createPendingAssistantAction).not.toHaveBeenCalled();
        expect(h.repository.resolveAssistantAction).not.toHaveBeenCalled();
        expect(h.events).toMatchObject([
          { kind: "action_result", outcome: "error", decidedBy: "policy", reason: "invalid_input" }
        ]);
        expect(h.events.some((event) => event.kind === "action_request")).toBe(false);
        expect(
          h.events.every(
            (event) => event.kind !== "action_result" || event.affectsModules === undefined
          )
        ).toBe(true);
      }
    );
  }
);
