import { registerActionNotificationLifecycle } from "./action-notification-lifecycle.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import type { ActAsGrantRegistry } from "@moss/module-sdk/server";
import { createAppActionsService } from "./app-actions.js";

import type { AccessContext, DataContextRunner, MossDatabase, PreferencesPort } from "@moss/db";
import {
  AI_MODEL_CAPABILITIES,
  CHAT_SETTINGS_PREFERENCE_KEY,
  getChatSettingsRouteSchema,
  listChatThreadMessagesRouteSchema,
  listChatThreadsRouteSchema,
  listMemoryCorrectionsRouteSchema,
  normalizeChatSettings,
  putChatSettingsRouteSchema,
  type AiModelCapability,
  type AnswerSourceSupportCard,
  type PutChatSettingsRequest
} from "@moss/shared";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  createAiSecretCipher,
  type ActiveModulesResolver,
  type GatewaySessionRecord,
  type PlatformDiagnosticsService,
  type ProviderKind,
  type SessionNotifier
} from "@moss/ai";
import { PreferencesRepository } from "@moss/structured-state";
import type { NotesRecallPort } from "@moss/notes";
import type { AcpPermissionDecider } from "@moss/acp";
import { getConnectorSyncAt } from "@moss/connectors";
import type {
  ConnectorsRepository,
  FeatureGrantService,
  GoogleApiClient,
  GoogleConnectionService,
  SourceContextService
} from "@moss/connectors";
import {
  ChatMemoryFactsRepository,
  ChatMemorySuppressionsRepository,
  createMemoryFactSignature
} from "@moss/memory";
import { type MossModuleManifest, type RouteCatalogHolder } from "@moss/module-sdk";
import { type ChatGatewayNotifier, createChatGatewayNotifier } from "./gateway-notifier.js";
import { ClassifierShadowRepository } from "./classifier-shadow-repository.js";
import { readRouteSurface } from "./live/chat-surface.js";
import { reconcileInterruptedTurns } from "./live-turns.js";
import { registerChatLiveRoutes, type EveningInterviewSeed } from "./live-routes.js";
import { handleRouteError } from "./route-errors.js";
import { createCurrentViewReadService, type CurrentViewReadService } from "./live/current-view.js";
import { PageContextStore } from "./live/page-context-store.js";
import type { PassiveMemoryGraphRecallPort } from "./live/passive-retrieval.js";
import { createChatSessionRuntime, type ChatEngineFactory } from "./live/runtime.js";
import type {
  CreateChatSessionRuntimeDeps,
  ChatSessionRuntime,
  PersonaPreferencesPort,
  RpcConnection
} from "./live/runtime.js";
import { ChatUserMemorySettingsRepository } from "./memory-settings-repository.js";
import {
  parsePagination,
  parseSettingsPatch,
  serializeCorrection,
  serializeFact,
  serializeSettings
} from "./memory-serializers.js";
import { readStoredProvenance, provenanceCards } from "./live/answer-provenance.js";
import {
  registerMcpTransportRoute,
  registerNativePermissionRoute,
  registerVaultReadReportRoute
} from "./mcp-transport.js";
import { VaultContextRunner, getVaultBaseDir } from "@moss/vault";

import { registerChatAttachmentRoutes } from "./attachments-routes.js";
import { ChatAttachmentsService } from "./attachments-service.js";
import { ChatRepository } from "./repository.js";
import { ConversationProvenanceStore } from "./conversation-provenance.js";
import {
  registerMeetingChatBoundary,
  dereferenceMeetingCitation,
  isMeetingEvidenceAvailable
} from "./meeting-chat-boundary.js";
import {
  createMeetingChatRuntime,
  readMeetingChatContext,
  type MeetingChatData
} from "./live/meeting-chat-runtime.js";
import {
  asRecord,
  readShadowReportDays,
  serializeMessage,
  serializeShadowReport,
  serializeThread
} from "./route-serializers.js";
import { registerChatSkillsRoutes } from "./skills/routes.js";
import { ChatSkillsRepository } from "./skills/repository.js";
import { type AppMapReadService } from "@moss/settings";
import { RuntimeConfigResolver } from "@moss/settings";
import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY } from "@moss/settings";
import { buildClassifierGateRunner, GATE_TOKEN_TTL_MS } from "./live/classifier-gate-runner.js";
import type { ClassifierGateRunner } from "./live/classifier-gate-runner.js";
import { createCliStructuredAdapterFactory } from "./live/cli-structured-adapter.js";
import { createClassifierGatePortsFactory } from "./live/classifier-gate-wiring.js";
import { createClassifierGateShadowRunner } from "./live/classifier-gate-shadow.js";
import { THRESHOLD_VERSION, type GateMode } from "./live/classifier-gate.js";
import { resolveEffectiveGateMode } from "./classifier-shadow-review-repository.js";
import { buildChatGatewayDependencies } from "./gateway-services.js";
import { buildCheckTokenMinter, type CheckTokenMinter } from "./check-token-minter.js";

export { buildCheckTokenMinter, type CheckTokenMinter } from "./check-token-minter.js";

export {
  buildChatGatewayDependencies,
  buildChatToolServices,
  resolveYoloMode
} from "./gateway-services.js";

export interface ChatRoutesDependencies {
  readonly meetingChat?: MeetingChatData;
  readonly rootDb: Kysely<MossDatabase>;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: ChatRepository;
  readonly skillsRepository?: ChatSkillsRepository;
  /** Override the classifier shadow-record store (tests inject a fake). */
  readonly classifierShadowRepository?: ClassifierShadowRepository;
  /** Override the live-chat engine factory (tests inject a fake); defaults to real tmux. */
  readonly chatEngineFactory?: ChatEngineFactory;
  readonly resolveActiveModules?: ActiveModulesResolver;
  readonly mcpServerUrl?: string;
  /** #1133 — override the attachment store (tests use a tmpdir vault base). */
  readonly attachmentsService?: ChatAttachmentsService;
  /** pg-boss for enqueueing embed/extract-facts jobs after each completed turn. */
  readonly boss?: PgBoss;
  readonly passiveMemoryRecall?: PassiveMemoryGraphRecallPort;
  readonly notesRecall?: NotesRecallPort;
  readonly personaPreferences?: PersonaPreferencesPort;
  readonly chatPreferences?: PreferencesPort;
  readonly localePreferences?: PreferencesPort;
  /**
   * #2228: which web search engine is active for an actor (composition root resolves it through
   * the settings module). The gateway hides the web.search tool only when it returns "none".
   */
  readonly webSearchEngineForActor?: (
    actorUserId: string
  ) => Promise<"brave" | "model-native" | "none">;
  readonly agencyPreferences?: PreferencesPort;
  /** Priority preferences port — forwarded to the chat runtime for cross-tool context ranking (#721). */
  readonly priorityPreferences?: PreferencesPort;
  /** Connector collaborators for the calendar focus-time write tool (composition host). */
  readonly googleConnectionService?: GoogleConnectionService;
  readonly googleApiClient?: GoogleApiClient;
  readonly connectorsRepository?: ConnectorsRepository;
  /** Injected by the composition root; gates email/calendar read tools to accounts with active grants. */
  readonly featureGrantService?: FeatureGrantService;
  /** Injected by the composition root; live-first email/calendar reads for the read tools (#729). */
  readonly sourceContextService?: SourceContextService;
  /** Injected by the composition root; app-map read tool (#1110). Never bucket under collaborators. */
  readonly appMapService?: AppMapReadService;
  /** Read-only platform diagnostics service; never exposed in the write service bag. */
  readonly platformDiagnostics?: PlatformDiagnosticsService;
  /** Injected by the composition root; settings.notificationPreference.setEnabled tool service. */
  readonly listModuleManifests?: () => readonly MossModuleManifest[];
  /**
   * #342 (§3.5 boot-time fork) — when no explicit {@link chatEngineFactory} is supplied, hand this to
   * {@link createChatSessionRuntime} so chat selects its ACP engine over the cli-runner socket. The
   * runtime owns the §5.3 reconciliation hook (which needs the manager) and the §5.5 idle reaper.
   * Structured/module callers keep their separate late-bound factory until slice 2 moves them.
   */
  readonly engineSelection?: CreateChatSessionRuntimeDeps["engineSelection"];
  /**
   * #342 (§3.4) — composition seam: after the runtime builds its ONE RPC connection (socket path), the
   * chat routes publish it back to `registerBuiltInApiRoutes` so a single socket serves both chat and
   * the onboarding probes (§4.8) and gets the connect-on-boot / close-on-shutdown lifecycle. No-op on
   * the in-process path (the runtime exposes no connection).
   */
  readonly adoptChatRpcConnection?: (connection: RpcConnection) => void;
  /** Publishes the ACP initialize check for the admin provider status route. */
  readonly adoptAcpProviderInitialization?: (
    check: ChatSessionRuntime["checkProviderInitialization"]
  ) => void;
  /**
   * #1081 H2 — same late-bound "adopt" seam as {@link adoptChatRpcConnection}, but for the
   * chat session manager itself (built inside this function, AFTER the composition root
   * assembles the onboarding-install seam). Publishes `ChatSessionManager.dropSessionsForProvider`
   * back to `registerBuiltInApiRoutes`, which forwards a lazy-dereferencing wrapper into
   * `buildOnboardingInstall`'s `dropSessionsForProvider` dependency — so a binary-changing
   * reinstall (`/api/onboarding/provider-install`) can drop that provider's live sessions.
   * Unconditional (unlike the RPC connection, `runtime.manager` always exists).
   */
  readonly adoptDropSessionsForProvider?: (
    dropSessionsForProvider: (provider: ProviderKind) => Promise<void>
  ) => void;
  // #1256 — publishes the wiring's live AssistantToolGateway back to the composition root so the
  // ai module's assistant-action resolve route can go through the same confirmation-registry gate
  // as this module's own action-requests resolve path, instead of two divergent implementations.
  readonly adoptChatGateway?: (gateway: AssistantToolGateway) => void;
  /**
   * #1554 task #6 — same late-bound "adopt" seam as {@link adoptChatRpcConnection}/
   * {@link adoptDropSessionsForProvider}, publishing the wiring closure's
   * `SessionTokenRegistry.revokeBySessionId` (built inside this function, when `wiring` is
   * constructed) back to the composition root. `module-registry/src/index.ts` forwards it into
   * `chat-multiplexer.ts`'s `resolveChatEngineFactory` as `onPersistentReap`'s target, so the
   * persistent-runtime pool's idle-reap/LRU-evict sweep revokes the reaped session's MCP token —
   * closing task #5's documented gap (that pool is constructed in `runtime.ts`, one layer below
   * this file, via `resolveChatEngineFactory` → `createRealEngineFactory`). No-op when no gateway
   * is wired (`wiring === null`, i.e. no `resolveActiveModules`/`mcpServerUrl` supplied).
   */
  readonly adoptMcpTokenRevoke?: (revoke: (chatSessionId: string) => void) => void;
  /**
   * #2901 — same late-bound "adopt" seam: publishes the classifier gate runner the wiring closure
   * built, so a test can drive the REAL route setup (mint/revoke/allowlist) and assert it. No-op
   * when no gateway is wired.
   */
  readonly adoptClassifierGate?: (runner: ClassifierGateRunner) => void;
  /**
   * #2689: publishes a minter for a token that may call only the named tools, and a way to drop it.
   * The version check uses it so its throwaway session is refused any call to another tool.
   */
  readonly adoptCheckTokenMinter?: (minter: CheckTokenMinter) => void;
  /** #3065: the built-in route catalog; null until the server's onReady fills it. */
  readonly routeCatalog?: RouteCatalogHolder;
  readonly actAsGrants?: ActAsGrantRegistry;
  readonly resolveEveningInterviewSeed?: (
    actorUserId: string,
    briefingRunId?: string
  ) => Promise<EveningInterviewSeed>;
}

/**
 * Chat HTTP routes. The live drawer is the only chat surface: the in-process CLI
 * runtime (turn/clear/switch/stream) plus a read-only thread list for the drawer's
 * History. The legacy worker-backed thread/message CRUD was removed in the
 * retire-legacy-chat-model change.
 *
 * Phase 2: when resolveActiveModules + mcpServerUrl are supplied, also wires the
 * AssistantToolGateway (MCP transport + approve/deny endpoint).
 */
export function registerChatRoutes(
  server: FastifyInstance,
  dependencies: ChatRoutesDependencies
): void {
  // #1109 — one store for the process; shared by the PUT route below and Task 4's
  // chat.getCurrentView tool so both read/write the same actor-keyed views.
  const pageContextStore = new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 });
  // #1109 Task 4 — only wired when the #1110 app-map service is available; that's the
  // sole source of the build-stamp facts the tool must report.
  const currentViewService: CurrentViewReadService | undefined = dependencies.appMapService
    ? createCurrentViewReadService({
        store: pageContextStore,
        getModelCapabilities: async (scopedDb) => {
          const model = await new AiRepository().selectChatModelForUser(scopedDb);
          return (model?.capabilities ?? []).filter((c): c is AiModelCapability =>
            AI_MODEL_CAPABILITIES.includes(c as AiModelCapability)
          );
        },
        getBuildInfo: () => dependencies.appMapService!.getBuildInfo()
      })
    : undefined;

  const repository = dependencies.repository ?? new ChatRepository();
  const meetingChat = dependencies.meetingChat
    ? createMeetingChatRuntime({
        ...dependencies.meetingChat,
        dataContext: dependencies.dataContext,
        repository
      })
    : undefined;
  registerMeetingChatBoundary(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    runtime: meetingChat
  });
  const skillsRepository = dependencies.skillsRepository ?? new ChatSkillsRepository();
  // #1133 — attachment bytes live in the actor's vault, so the service needs only the
  // vault base dir; shared by the upload route, turn wiring, and chat.readAttachment.
  const attachmentsService =
    dependencies.attachmentsService ??
    new ChatAttachmentsService(new VaultContextRunner(getVaultBaseDir()));
  registerChatAttachmentRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    attachmentsService
  });
  const chatSettingsRepo = new PreferencesRepository();
  const memorySettingsRepo = new ChatUserMemorySettingsRepository();
  const factsRepo = new ChatMemoryFactsRepository();
  const suppressionsRepo = new ChatMemorySuppressionsRepository();
  const classifierShadowRepository =
    dependencies.classifierShadowRepository ?? new ClassifierShadowRepository();

  // The proxy is wired before the manager supplies its live notifier.
  const notifierProxy: SessionNotifier = {
    emit(chatSessionId: string, record: GatewaySessionRecord) {
      realNotifier?.emit(chatSessionId, record);
    },
    async flush(chatSessionId: string) {
      await realNotifier?.flush(chatSessionId);
    }
  };
  let realNotifier: ChatGatewayNotifier | null = null;

  const resolveActiveModules = dependencies.resolveActiveModules;
  const conversationProvenance = new ConversationProvenanceStore(dependencies.dataContext);
  const mcpServerUrl = dependencies.mcpServerUrl;
  const wiring =
    resolveActiveModules && mcpServerUrl
      ? (() => {
          const tokens = new SessionTokenRegistry();
          const confirmations = new ConfirmationRegistry();
          const aiRepository = new AiRepository();
          const appActions =
            dependencies.routeCatalog && dependencies.actAsGrants
              ? createAppActionsService({
                  server,
                  catalog: dependencies.routeCatalog,
                  grants: dependencies.actAsGrants,
                  readTurnId: (session) => tokens.readCurrentTurnId(session) ?? null
                })
              : undefined;

          const gateway = new AssistantToolGateway(
            buildChatGatewayDependencies({
              resolveActiveModules,
              repository: aiRepository,
              runner: dependencies.dataContext,
              tokens,
              confirmations,
              notifier: notifierProxy,
              appActions,
              conversationProvenance,
              collaborators: {
                googleConnectionService: dependencies.googleConnectionService,
                googleApiClient: dependencies.googleApiClient,
                connectorsRepository: dependencies.connectorsRepository,
                boss: dependencies.boss,
                featureGrantService: dependencies.featureGrantService,
                sourceContextService: dependencies.sourceContextService,
                currentViewService,
                // #1133 — lets the engine pull attachment bytes via chat.readAttachment.
                attachmentsService,
                listModuleManifests: dependencies.listModuleManifests
              },
              appMapService: dependencies.appMapService,
              platformDiagnostics: dependencies.platformDiagnostics,
              agencyPreferences: dependencies.agencyPreferences,
              localePreferences: dependencies.localePreferences,
              webSearchEngineForActor: dependencies.webSearchEngineForActor
            })
          );

          return { tokens, confirmations, gateway, mcpServerUrl, aiRepository };
        })()
      : null;

  if (wiring) dependencies.adoptChatGateway?.(wiring.gateway);

  /**
   * #2907 (plan 3.5) — the production ports factory for the gate: the actor's tool menu, the
   * classifier calls, candidate hooks and the dry-run gateway call.
   * Shared by the handled-turn runner (4.1) and the shadow runner, so neither copies wiring.
   */
  const classifierGatePorts = wiring
    ? createClassifierGatePortsFactory({
        resolveActiveModules: resolveActiveModules as ActiveModulesResolver,
        dataContext: dependencies.dataContext,
        gateway: wiring.gateway,
        classifierDeps: {
          repository: wiring.aiRepository,
          cipher: createAiSecretCipher(),
          createCliStructuredAdapter: createCliStructuredAdapterFactory(
            dependencies.chatEngineFactory
          )
        }
      })
    : undefined;

  /**
   * #2984 R2.4 — the admin mode as the gate runs it: a stored `on` reads as `shadow` until the
   * current classifier selection has a shadow review. Shared by both runners.
   */
  const readGateMode = wiring
    ? (actorUserId: string) =>
        dependencies.dataContext.withDataContext({ actorUserId }, async (scopedDb) =>
          resolveEffectiveGateMode(
            scopedDb,
            await new RuntimeConfigResolver(scopedDb).resolveEnum<GateMode>(
              CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY
            ),
            { classifierDeps: { repository: wiring.aiRepository } }
          )
        )
    : undefined;

  /**
   * Task 4.1 (#2901) — the classifier gate seam, wired with the real access token and admin setting.
   * `buildClassifierGateRunner` owns the session-id shape, the token lifetime and the admin mode
   * read. `on` runs only while the current classifier selection has a shadow review.
   */
  const classifierGate =
    wiring && readGateMode
      ? buildClassifierGateRunner({
          readMode: readGateMode,
          tokens: wiring.tokens,
          createPorts: classifierGatePorts
        })
      : undefined;

  if (classifierGate) dependencies.adoptClassifierGate?.(classifierGate);

  /**
   * #2907 (plan 3.5) — the classifier gate's shadow runner. One short-lived token is minted per
   * attempt (scoped to the actor and a fresh correlation id) and revoked in `finally`; shadows only,
   * so no tool ever executes and no card is ever raised.
   */
  const classifierGateShadow =
    wiring && classifierGatePorts && readGateMode
      ? createClassifierGateShadowRunner({
          readMode: readGateMode,
          createPorts: classifierGatePorts,
          repository: classifierShadowRepository,
          dataContext: dependencies.dataContext,
          tokens: {
            mint: (actorUserId, correlationId, threadId, allowedToolNames) => {
              // #2956: the shadow passes its turn id as the correlation id, so the
              // gate session files its tool rows under the chat turn. Revoke clears it.
              wiring.tokens.setCurrentTurnId(`classifier-gate:${correlationId}`, correlationId);
              return wiring.tokens.mint(
                {
                  actorUserId,
                  threadId,
                  chatSessionId: `classifier-gate:${correlationId}`,
                  allowedToolNames
                },
                // #2907 QA N2: the short fixed lifetime, exactly like the 4.1 gate token, so a
                // skipped revoke leaves it stale after a minute instead of an hour.
                { ttlMs: GATE_TOKEN_TTL_MS, fixedExpiry: true }
              );
            },
            revoke: (correlationId) => {
              wiring.tokens.clearCurrentTurnId(`classifier-gate:${correlationId}`);
              wiring.tokens.revokeBySessionId(`classifier-gate:${correlationId}`);
            }
          },
          listToolNames: async (actorUserId) =>
            (await wiring.gateway.listToolsForActor(actorUserId)).map((tool) => tool.name),
          thresholdVersion: THRESHOLD_VERSION,
          now: () => Date.now()
        })
      : undefined;
  const runtime = createChatSessionRuntime({
    flushActionRecords: async (sessionKey) => {
      await realNotifier?.flush(sessionKey);
    },
    conversationProvenance,
    rootDb: dependencies.rootDb,
    dataContext: dependencies.dataContext,
    engineFactory: dependencies.chatEngineFactory,
    // An explicitly injected engine factory wins for tests and embedders.
    engineSelection: dependencies.chatEngineFactory ? undefined : dependencies.engineSelection,
    boss: dependencies.boss,
    connectorSyncAt: dependencies.connectorsRepository
      ? async (scopedDb, kind) =>
          getConnectorSyncAt(dependencies.connectorsRepository!, scopedDb, kind)
      : undefined,
    // #1414 — wire crossToolGateway so cross-tool reads (email, calendar, task, note, person) produce provenance chips
    crossToolGateway: wiring?.gateway,
    passiveMemoryRecall: dependencies.passiveMemoryRecall,
    notesRecall: dependencies.notesRecall,
    personaPreferences: dependencies.personaPreferences,
    chatPreferences: dependencies.chatPreferences,
    localePreferences: dependencies.localePreferences,
    priorityPreferences: dependencies.priorityPreferences,
    // Task 4.1 (#2901) — attach the classifier gate seam. Undefined when the gateway is not wired.
    classifierGate,
    // #2907 (plan 3.5) — attach the shadow runner. Undefined when the gateway is not wired.
    classifierGateShadow,
    mcpTokenLifecycle: wiring
      ? {
          mint: async (actorUserId: string, chatSessionId: string, threadId: string | null) => {
            // Capture the actor's current executable tool set as the per-session allowlist.
            // Bare tool names (e.g. "example.read") — same format as tools/list and tools/call params.name.
            // The mcp__jarvis__<name> prefix is a client-side CLI convention that never reaches the server.
            const allowedToolNames = new Set(
              (await wiring.gateway.listToolsForActor(actorUserId)).map((tool) => tool.name)
            );
            return {
              token: wiring.tokens.mint({
                actorUserId,
                chatSessionId,
                threadId,
                allowedToolNames
              }),
              mcpServerUrl: wiring.mcpServerUrl
            };
          },
          revoke: (chatSessionId: string) => wiring.tokens.revokeBySessionId(chatSessionId),
          touch: (chatSessionId: string) => wiring.tokens.touchBySessionId(chatSessionId),
          // #2956: the chat manager files a session's tool rows under its
          // running turn; the gateway reads the same map at tool time.
          setCurrentTurn: (chatSessionId: string, turnId: string) =>
            wiring.tokens.setCurrentTurnId(chatSessionId, turnId),
          clearCurrentTurn: (chatSessionId: string) =>
            wiring.tokens.clearCurrentTurnId(chatSessionId),
          // #342 (§5.3 steps 2/4) — orphan-token reconciliation + the source-of-truth session-id list.
          // Forwarded to the manager (reconcileMcpTokens / listMcpTokenSessionIds) so a (re)connect or
          // bootId change revokes tokens for sessions the cli-runner no longer holds — even after an api
          // restart wipes the `sessions` Map (the registry, not the Map, is the orphan-token source).
          reconcile: (liveSessionIds: Set<string>) => wiring.tokens.reconcile(liveSessionIds),
          listSessionIds: () => wiring.tokens.listSessionIds(),
          // #2159 — readiness gate: the manager waits on this right after engine.launch() before
          // accepting the session's first message.
          waitForReady: (token: string) => wiring.tokens.waitForToolsListObserved(token),
          // #2164 r21 — per-turn observation reading (see Fable's r21 wiring-amendment ruling).
          getToolsListObservationCount: (token: string) =>
            wiring.tokens.getToolsListObservationCount(token),
          acpPermissionDeciderForToken: (token: string): AcpPermissionDecider => ({
            decide: async (request, session) => {
              const result = await wiring.gateway.requestAcpBuiltInPermission(token, {
                cwd: session.cwd,
                home: session.home,
                sessionId: request.sessionId,
                turnId: request.turnId,
                toolCallId: request.toolCallId,
                title: request.title,
                toolInput:
                  request.rawInput &&
                  typeof request.rawInput === "object" &&
                  !Array.isArray(request.rawInput)
                    ? (request.rawInput as Record<string, unknown>)
                    : {},
                toolName: request.toolName,
                kind: request.kind,
                locations: request.locations
              });
              return result.decision;
            },
            beginTurn: (sessionId, turnId) => {
              wiring.confirmations.beginTurn(sessionId, turnId);
            },
            cancelSession: (sessionId) => {
              wiring.confirmations.cancelSession(sessionId);
            }
          })
        }
      : undefined
  });

  // #342 (§3.4): publish the ONE RPC connection the runtime owns (socket path only) back to the
  // composition root so a single socket serves both chat and the onboarding probes, and gets the
  // connect-on-boot / close-on-shutdown lifecycle. No-op on the in-process path (connection undefined).
  if (runtime.connection) {
    dependencies.adoptChatRpcConnection?.(runtime.connection);
  }
  dependencies.adoptAcpProviderInitialization?.(runtime.checkProviderInitialization);

  // #1081 H2: publish the session manager's drop-by-provider method back to the composition
  // root (same "adopt" seam as above), unconditionally — unlike the RPC connection,
  // `runtime.manager` always exists on every runtime path.
  dependencies.adoptDropSessionsForProvider?.((provider) =>
    runtime.manager.dropSessionsForProvider(provider)
  );

  // #1554: publish token revocation to the persistent-runtime reap hook when wired.
  if (wiring) {
    dependencies.adoptMcpTokenRevoke?.((chatSessionId) =>
      wiring.tokens.revokeBySessionId(chatSessionId)
    );
    dependencies.adoptCheckTokenMinter?.(buildCheckTokenMinter(wiring.tokens, wiring.mcpServerUrl));
  }

  realNotifier = createChatGatewayNotifier(
    runtime.manager,
    dependencies.dataContext,
    wiring?.aiRepository
  );

  registerActionNotificationLifecycle(server, {
    gateway: wiring?.gateway,
    repository: wiring?.aiRepository,
    rootDb: dependencies.rootDb,
    shutdown: () => runtime.shutdown(),
    flush: async () => {
      await realNotifier?.flush();
    }
  });

  if (wiring) {
    registerMcpTransportRoute(server, { gateway: wiring.gateway, tokens: wiring.tokens });
    registerNativePermissionRoute(server, { gateway: wiring.gateway, tokens: wiring.tokens });
    registerVaultReadReportRoute(server, { gateway: wiring.gateway, tokens: wiring.tokens });

    server.post<{ Params: { id: string }; Body: { status: string } }>(
      "/api/chat/action-requests/:id/resolve",
      async (request, reply) => {
        let access: AccessContext;
        try {
          access = await dependencies.resolveAccessContext(request);
        } catch {
          return reply.code(401).send({ error: "Session is missing or expired" });
        }

        const { id } = request.params;
        const rawStatus = (request.body as { status?: unknown }).status;
        if (rawStatus !== "confirmed" && rawStatus !== "rejected" && rawStatus !== "cancelled") {
          return reply
            .code(400)
            .send({ error: "status must be confirmed, rejected, or cancelled" });
        }

        try {
          // #1250 — gateway now returns outcome so we can distinguish expired (409) from success (204)
          const outcome = await wiring.gateway.resolveActionRequest(
            access.actorUserId,
            id,
            rawStatus
          );
          if (outcome === "unavailable") {
            return reply.code(409).send({
              code: "approval_unavailable",
              error:
                "Details for this request aren’t available. Ask Moss again if you still want it."
            });
          }
          if (outcome === "expired") {
            return reply.code(409).send({ error: "This request expired — ask again." });
          }
          if (outcome === "not_found") {
            return reply.code(404).send({ error: "Action request not found" });
          }
          return reply.code(204).send();
        } catch {
          return reply.code(400).send({ error: "Could not resolve action request" });
        }
      }
    );
  }

  registerChatLiveRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    runtime: {
      ...runtime,
      resolveEveningInterviewSeed: dependencies.resolveEveningInterviewSeed
    },
    pageContextStore,
    // #1133 — lets /turn resolve uploaded attachment ids to vault metadata.
    attachmentsService
  });

  registerChatSkillsRoutes(
    server,
    {
      resolveAccessContext: dependencies.resolveAccessContext,
      dataContext: dependencies.dataContext
    },
    skillsRepository
  );

  server.get(
    "/api/chat/threads",
    { schema: listChatThreadsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const surface = readRouteSurface(request.query);
        const threads = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listThreads(scopedDb, surface)
        );
        return { threads: threads.map(serializeThread) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: { id: string } }>(
    "/api/chat/threads/:id/messages",
    { schema: listChatThreadMessagesRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const surface = readRouteSurface(request.query);
        const messages = await dependencies.dataContext.withDataContext(
          access,
          async (scopedDb) => {
            const thread = await repository.getThreadById(scopedDb, request.params.id, surface);
            if (thread?.owner_user_id !== access.actorUserId) return null;
            if (!thread) return null;
            // #3128: reopening a chat stores any reply an earlier boot left unfinished.
            await reconcileInterruptedTurns(scopedDb, thread.id);
            return repository.listMessages(scopedDb, thread.id);
          }
        );
        if (!messages) return reply.code(404).send({ error: "Chat thread not found" });
        return { messages: messages.map(serializeMessage) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Chat settings ──────────────────────────────────────────────────────────

  server.get(
    "/api/chat/settings",
    { schema: getChatSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const raw = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          chatSettingsRepo.get(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY)
        );
        return { chat: normalizeChatSettings(raw) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/chat/settings",
    { schema: putChatSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const body = request.body as PutChatSettingsRequest;
        const chat = normalizeChatSettings(body.chat);
        await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          chatSettingsRepo.upsert(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY, chat)
        );
        return { chat };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Memory settings ────────────────────────────────────────────────────────

  server.get("/api/chat/memory/settings", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const settings = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        memorySettingsRepo.getOrCreate(scopedDb, access.actorUserId)
      );
      return serializeSettings(settings);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch("/api/chat/memory/settings", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const patch = parseSettingsPatch(request.body);
      const settings = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        memorySettingsRepo.update(scopedDb, access.actorUserId, patch)
      );
      return serializeSettings(settings);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  // ── Classifier shadow records ───────────────────────────────────────────────

  // #2908 — the owner deletes their own shadow records on request. Row-level security scopes the
  // delete to the caller; there is intentionally no admin or cross-user variant here.
  server.delete("/api/chat/classifier/shadow-records", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const deleted = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        classifierShadowRepository.deleteForOwner(scopedDb)
      );
      return { deleted };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  // #2957 — temporary shadow report. Owner-only counts and disagreements over 7, 30 or
  // 90 days. Row-level security scopes every row to the caller, so an admin reads only
  // their own records; there is intentionally no admin or cross-user variant here.
  server.get("/api/chat/classifier/shadow-report", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const days = readShadowReportDays(request.query);
      const report = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        classifierShadowRepository.getReportForOwner(scopedDb, { days })
      );
      return { report: serializeShadowReport(report) };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  // ── Memory facts ───────────────────────────────────────────────────────────

  server.get("/api/chat/memory/facts", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const facts = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        factsRepo.listActiveFacts(scopedDb, access.actorUserId)
      );
      return { facts: facts.map(serializeFact) };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/chat/memory/corrections",
    { schema: listMemoryCorrectionsRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { limit, offset } = parsePagination(request.query);
        const corrections = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          suppressionsRepo.listCorrections(scopedDb, access.actorUserId, { limit, offset })
        );
        return { corrections: corrections.map(serializeCorrection) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/api/chat/memory/facts/:id",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const deleted = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          factsRepo.deleteFact(scopedDb, request.params.id)
        );
        if (!deleted) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/chat/memory/facts/:id/confirm",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const confirmed = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          factsRepo.confirmFact(scopedDb, request.params.id)
        );
        if (!confirmed) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/chat/memory/facts/:id/reject",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const rejected = await dependencies.dataContext.withDataContext(
          access,
          async (scopedDb) => {
            const fact = await factsRepo.getActiveFact(scopedDb, request.params.id);
            if (!fact || fact.provenance !== "inferred") return false;

            await suppressionsRepo.insertSuppression(scopedDb, access.actorUserId, {
              signature: createMemoryFactSignature(fact.category, fact.content),
              category: fact.category,
              content: fact.content,
              reason: "rejected"
            });
            await factsRepo.deleteFact(scopedDb, fact.id);
            return true;
          }
        );
        if (!rejected) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: { id: string } }>("/api/chat/memory/facts/:id", async (request, reply) => {
    try {
      const access = await dependencies.resolveAccessContext(request);
      const importance = (request.body as Record<string, unknown>).importance;
      if (typeof importance !== "number" || importance < 0 || importance > 1) {
        return reply.code(400).send({ error: "importance must be a number between 0 and 1" });
      }
      const updated = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
        factsRepo.updateFactImportance(scopedDb, request.params.id, importance)
      );
      if (!updated) return reply.code(404).send({ error: "Memory fact not found" });
      return reply.code(204).send();
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  // ── Answer provenance ──────────────────────────────────────────────────────

  server.get<{ Params: { messageId: string } }>(
    "/api/chat/messages/:messageId/provenance",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const message = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.getMessageById(scopedDb, request.params.messageId)
        );
        if (!message || message.owner_user_id !== access.actorUserId) {
          return reply.code(404).send({ error: "Message not found" });
        }
        const toolMetadata = asRecord(message.tool_metadata);
        const meetingBinding = readMeetingChatContext(toolMetadata);
        if (!(await isMeetingEvidenceAvailable(meetingChat, access, meetingBinding)))
          return reply.code(404).send({ error: "Meeting evidence unavailable" });
        const stored = readStoredProvenance(toolMetadata);
        const cards: AnswerSourceSupportCard[] = stored != null ? provenanceCards(stored) : [];
        return { cards };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: { messageId: string; supportId: string } }>(
    "/api/chat/messages/:messageId/provenance/:supportId/dereference",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const message = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.getMessageById(scopedDb, request.params.messageId)
        );
        if (!message || message.owner_user_id !== access.actorUserId) {
          return reply.code(404).send({ error: "Message not found" });
        }
        const toolMetadata = asRecord(message.tool_metadata);
        const meetingBinding = readMeetingChatContext(toolMetadata);
        if (!(await isMeetingEvidenceAvailable(meetingChat, access, meetingBinding)))
          return reply.code(404).send({ error: "Meeting evidence unavailable" });
        const stored = readStoredProvenance(toolMetadata);
        if (!stored) return reply.code(404).send({ error: "No provenance for this message" });

        const supportItem = stored.supportItems.find(
          (item) => item.supportId === request.params.supportId
        );
        if (!supportItem) return reply.code(404).send({ error: "Support item not found" });

        if (meetingBinding && meetingChat)
          return dereferenceMeetingCitation(
            meetingChat,
            access,
            meetingBinding,
            request.params.supportId
          );
        // Other source providers are not registered yet.
        return {
          unavailableReason: "source_unavailable" as const,
          sourceLabel: supportItem.sourceLabel,
          title: supportItem.title
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
