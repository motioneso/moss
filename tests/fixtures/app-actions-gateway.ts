import { vi } from "vitest";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type AiRepository,
  type ConversationProvenancePort,
  type PerCallResolver,
  type GatewaySessionRecord
} from "@moss/ai";
import { type DataContextRunner } from "@moss/db";
import { buildRouteCatalog, getBuiltInModuleManifests } from "@moss/module-registry";
import type { MossModuleManifest, ToolContext } from "@moss/module-sdk";

import {
  createAppActionCallServices,
  type AppActionCallInput,
  type AppActionsService
} from "../../packages/chat/src/app-actions.js";

import { buildChatGatewayDependencies } from "../../packages/chat/src/gateway-services.js";

export const appActionActor = "00000000-0000-4000-8000-000000000001";
export const appActionContext: ToolContext = {
  actorUserId: appActionActor,
  requestId: "app-action-boundary",
  chatSessionId: "app-action-session",
  threadId: "00000000-0000-4000-8000-000000000091"
};
export const appActionManifests = getBuiltInModuleManifests();
export const appActionCatalog = buildRouteCatalog(appActionManifests, []);
export const themeTokens = {
  paper: "#fbfaf6",
  surface: "#ffffff",
  surface2: "#f5f3ed",
  surface3: "#edeae1",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "rgb(38, 34, 28)",
  lineSubtle: "rgb(245, 243, 237)",
  lineStrong: "rgb(210, 205, 194)",
  accent: "#2f6a4c"
};
export const medicationSentinel = "PRIVATE_MEDICATION_SENTINEL_3071";
export const therapySentinel = "PRIVATE_THERAPY_BODY_SENTINEL_3071";

/** Real gateway, token/confirmation registries, catalog, manifests, handlers and resolver.
 * The caller explicitly supplies persistence and transport: unit tests fake only those ports;
 * integration tests supply DataContextRunner, AiRepository and the real API/grant transport.
 */
export function makeAppActionGateway(options: {
  runner: DataContextRunner;
  appActions: AppActionsService;
  repository?: AiRepository;
  actorUserId?: string;
  threadId?: string;
  provenance?: ConversationProvenancePort;
  yoloMode?: boolean;
  autoApprove?: boolean;
  confirmTimeoutMs?: number;
  /** Test-only policy seam for a call forced to confirm (for example, later taint policy). */
  forceConfirm?: boolean;
  /** Simulates missing composition wiring while retaining the production availability marker. */
  withoutPerCallWiring?: boolean;
  resolveActiveModules?: (actorUserId: string) => Promise<readonly MossModuleManifest[]>;
}) {
  const actorUserId = options.actorUserId ?? appActionActor;
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const events: GatewaySessionRecord[] = [];
  const resolveActiveModules = options.resolveActiveModules ?? (async () => appActionManifests);
  let actionSequence = 0;
  const repository =
    options.repository ??
    ({
      createPendingAssistantAction: vi.fn(async () => ({ id: `app-action-${++actionSequence}` })),
      insertActionAuditLog: vi.fn(async () => undefined),
      resolveAssistantAction: vi.fn(async () => ({ status: "confirmed" })),
      listActionPolicies: vi.fn(async () => []),
      insertActionPolicyIfAbsent: vi.fn(async () => undefined)
    } as unknown as AiRepository);
  const wired = buildChatGatewayDependencies({
    runner: options.runner,
    repository,
    resolveActiveModules,
    tokens,
    confirmations,
    appActions: options.appActions,
    collaborators: {},
    notifier: {
      emit(_session, event) {
        events.push(event);
        if (options.autoApprove !== false && event.kind === "action_request") {
          queueMicrotask(() => confirmations.resolve(event.actionRequestId, "confirmed"));
        }
      }
    }
  });
  const baseResolver = wired.perCallResolvers?.["app.callAction"];
  if (!baseResolver || !wired.perCallServices?.["app.callAction"]) {
    throw new Error("Production app-action resolver and bound services must be wired");
  }
  const resolver: PerCallResolver = async (input, ctx) => {
    const resolution = await baseResolver(input, ctx);
    return options.forceConfirm && resolution.kind === "proceed"
      ? { ...resolution, forceConfirm: true }
      : resolution;
  };
  const services = createAppActionCallServices({ appActions: options.appActions, resolver });
  const dependencies = {
    ...wired,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.yoloMode === undefined ? {} : { yoloMode: async () => options.yoloMode! }),
    confirmTimeoutMs: options.confirmTimeoutMs ?? 2_000,
    logger: { error: vi.fn() },
    ...(options.forceConfirm
      ? {
          perCallResolvers: { "app.callAction": resolver },
          perCallServices: { "app.callAction": services }
        }
      : {}),
    ...(options.withoutPerCallWiring
      ? { perCallResolvers: undefined, perCallServices: undefined }
      : {})
  };
  const gateway = new AssistantToolGateway(dependencies);
  const token = tokens.mint({
    actorUserId,
    threadId: options.threadId ?? appActionContext.threadId,
    chatSessionId: appActionContext.chatSessionId,
    allowedToolNames: new Set([
      "app.findAction",
      "app.callAction",
      "settings.themeMode.set",
      "chat.listTodaysTurns"
    ])
  });
  return {
    gateway,
    dependencies,
    confirmations,
    events,
    repository,
    resolver,
    services,
    call: (input: AppActionCallInput) => gateway.callTool(token, "app.callAction", input),
    find: (query: string) => gateway.callTool(token, "app.findAction", { query }),
    theme: (mode: string) => gateway.callTool(token, "settings.themeMode.set", { mode }),
    todaysTurns: () => gateway.callTool(token, "chat.listTodaysTurns", {})
  };
}

export function blockedWellnessCalls(): AppActionCallInput[] {
  return appActionCatalog.routes
    .filter((route) => route.moduleId === "wellness" && route.policy.access === "blocked")
    .map((route) => ({
      method: route.method as AppActionCallInput["method"],
      path: route.path.replace(/:[^/]+/g, "00000000-0000-4000-8000-000000000041"),
      ...(route.method === "GET" ? {} : { body: {} })
    }));
}

/** Aggregate aliases that can contain previously derived Wellness or conversation content. */
export const aggregateConsentCalls: readonly AppActionCallInput[] = [
  { method: "GET", path: "/api/ai/activity-lines" },
  { method: "GET", path: "/api/memory/graph/recall" },
  { method: "GET", path: "/api/memory/graph/core" },
  { method: "GET", path: "/api/memory/dashboard" },
  ...["confirm", "correct", "status", "mark-stale"].map((action) => ({
    method: "POST" as const,
    path: `/api/memory/graph/facts/00000000-0000-4000-8000-000000000041/${action}`,
    body: {}
  })),
  { method: "GET", path: "/api/chat/memory/facts" },
  { method: "GET", path: "/api/chat/memory/corrections" },
  { method: "GET", path: "/api/chat/messages/00000000-0000-4000-8000-000000000041/provenance" },
  { method: "GET", path: "/api/chat/threads" },
  { method: "GET", path: "/api/chat/threads/00000000-0000-4000-8000-000000000041/messages" }
];
