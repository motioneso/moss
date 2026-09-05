import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import {
  commitmentsModuleManifest,
  commitmentsModuleSqlMigrationDirectory,
  COMMITMENT_EXTRACTION_QUEUE,
  CommitmentsRepository
} from "@moss/commitments";
import {
  peopleModuleManifest,
  peopleModuleSqlMigrationDirectory,
  PeopleNotesService,
  PeopleNotesFolderUnavailableError,
  registerPeopleRoutes,
  registerPersonIndexWorker,
  registerSyncPersonMemoryWorker,
  createPeopleVaultIngestProvider,
  PERSON_INDEX_QUEUE,
  SYNC_PERSON_MEMORY_QUEUE
} from "@moss/people";
import { getVaultBaseDir, VaultContextRunner } from "@moss/vault";
import {
  workflowsModuleManifest,
  workflowsModuleSqlMigrationDirectory,
  WORKFLOW_QUEUE_DEFINITIONS,
  registerWorkflowWorkers
} from "@moss/workflows";
import { registerWorkflowsRoutes } from "@moss/workflows/routes";
import { registerCommitmentsRoutes } from "@moss/commitments/routes";
import { registerCommitmentExtractionWorker } from "@moss/commitments/workers";
import {
  AI_QUEUE_DEFINITIONS,
  AiAutoRegisterService,
  AiRepository,
  createPlatformDiagnosticsService,
  aiModuleManifest,
  aiModuleSqlMigrationDirectory,
  createUnwiredActionResolver,
  createAiSecretCipher,
  generateStructured,
  ModelDiscoveryService,
  registerAiMaintenanceWorkers,
  registerAiRoutes,
  approveModuleBuildPlan,
  cancelModuleBuild,
  type AssistantToolGateway,
  type PlatformDiagnosticsService,
  type ProviderKind,
  type TerminalRpcConnectOptions,
  type TerminalRpcHandle
} from "@moss/ai";
import {
  GraphMemoryRecallService,
  ManualMemoryCandidateService,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  MemoryRepository,
  type MemoryRetriever,
  memoryModuleManifest,
  memorySqlMigrationDirectory,
  registerMemoryDashboardRoutes,
  registerMemoryGraphRoutes,
  registerVaultIngestRootProvider,
  registerVaultIngestWorkers,
  VAULT_INGEST_QUEUE_DEFINITIONS
} from "@moss/memory";
import {
  PreferencesRepository,
  structuredStateModuleManifest,
  structuredStateSqlMigrationDirectory,
  createStructuredStateVaultIngestProvider
} from "@moss/structured-state";
import { isBehaviorEnabled, type SourceBehaviorPreferencesPort } from "@moss/source-behaviors";
import {
  BRIEFINGS_QUEUE_DEFINITIONS,
  BriefingsRepository,
  briefingsModuleManifest,
  briefingsModuleSqlMigrationDirectory,
  createBriefingsFeedbackTargetVerifier,
  registerBriefingsJobWorkers,
  registerBriefingsRoutes,
  type ComposeDeps,
  type ExternalBriefingInvoker
} from "@moss/briefings";
import {
  CalendarRepository,
  calendarFollowThroughSourceRef,
  isCalendarFollowThroughEvent,
  isCalendarFollowThroughTask,
  calendarModuleManifest,
  calendarModuleSqlMigrationDirectory,
  CALENDAR_QUEUE_DEFINITIONS,
  registerCalendarRoutes,
  registerCalendarJobWorkers
} from "@moss/calendar";
import {
  CHAT_QUEUE_DEFINITIONS,
  ChatEngineRpcClient,
  chatModuleManifest,
  chatModuleSqlMigrationDirectory,
  CliChatUnavailableError,
  buildEveningInterviewSeed,
  buildCalendarWriteService,
  chatCommitmentProvider,
  ChatRepository,
  createChatFeedbackTargetVerifier,
  createCliStructuredAdapterFactory,
  registerChatJobWorkers,
  registerChatRoutes,
  type ChatEngineFactory,
  type ChatRoutesDependencies,
  type RpcConnection
} from "@moss/chat";
// #1059 — terminal-rpc-client lives under chat's "./live" subpath (public.ts), not the package
// root. This is the composition-root injection point for TerminalRpcClient into @moss/ai's
// terminal-routes.ts: packages/ai deliberately does NOT depend on @moss/chat (that edge was
// tried and reverted — it creates real dependency cycles caught by check-package-deps.ts, since
// @moss/chat itself depends on @moss/ai). module-registry already depends on BOTH @moss/ai
// and @moss/chat with no cycle (same fan-in pattern already used for ChatEngineFactory below),
// so it's the correct place to bridge the two.
import { TerminalRpcClient } from "@moss/chat/live";
import {
  ConnectorsRepository,
  EmailActionSuppressionRepository,
  GOOGLE_SYNC_QUEUE_DEFINITIONS,
  GOOGLE_SYNC_SWEEP_QUEUE_DEFINITIONS,
  GoogleEmailWriteProvider,
  IMAP_SYNC_QUEUE_DEFINITIONS,
  ImapEmailWriteProvider,
  MONITOR_QUEUE_DEFINITIONS,
  buildFeatureGrantService,
  buildRuntimeSourceContextService,
  connectorsModuleManifest,
  connectorsModuleSqlMigrationDirectory,
  createConnectorSecretCipher,
  getConnectorSyncAt,
  GoogleApiClient as RuntimeGoogleApiClient,
  GoogleConnectionService as RuntimeGoogleConnectionService,
  GoogleOAuthClient,
  registerConnectorsJobWorkers,
  registerConnectorsRoutes,
  registerGoogleSyncSweepWorker,
  registerImapSyncWorker,
  registerSourceMonitorWorkers,
  sharesSubjectToken,
  parseEmailSourceRef,
  type ActionRowRelevancePort,
  type EmailTaskCreationPort,
  type GoogleApiClient,
  type GoogleConnectionService
} from "@moss/connectors";
import type { ActiveModulesResolver, AiSecretCipher } from "@moss/ai";
import {
  resolveMossEnv,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner,
  type MossDatabase
} from "@moss/db";
import { resolveTimeZone, type ProactiveSource } from "@moss/shared";
import {
  emailModuleManifest,
  emailModuleSqlMigrationDirectory,
  EmailRepository,
  registerEmailRoutes
} from "@moss/email";
import {
  assertMetadataOnlyPayload,
  FOUNDATION_QUEUES,
  registerDataContextWorker,
  sendJob,
  MODULE_BUILD_QUEUE,
  type QueueDefinition
} from "@moss/jobs";
import { createModuleLogger } from "@moss/module-sdk";
import type {
  MossModuleManifest,
  JsonMossModuleManifest,
  RegisteredFocusSignal,
  RegisteredModuleDiagnosticProvider,
  RegisteredProactiveMonitorProvider
} from "@moss/module-sdk";
import {
  NotificationsRepository,
  DIGEST_COMPOSE_QUEUE,
  type NotificationPreferencePort,
  runNotificationDigestCompose,
  notificationsModuleManifest,
  notificationsModuleSqlMigrationDirectory,
  registerNotificationsRoutes,
  type NotificationDigestSender
} from "@moss/notifications";
import {
  type AuthProviderStatusDto,
  type ChatMultiplexerChoice,
  type OnboardingProviderCheckResponse,
  type OnboardingProviderKind
} from "@moss/shared";
import {
  EXPORT_QUEUE_DEFINITIONS,
  createWebSearchSecretCipher,
  readBraveSearchApiKey,
  resolveWebSearchEngine,
  registerSettingsJobWorkers,
  registerSettingsRoutes,
  registerRuntimeConfigRoutes,
  registerWebSearchKeyRoutes,
  settingsModuleManifest,
  settingsModuleSqlMigrationDirectory,
  SettingsRepository,
  type HostDiagnosticsProvider,
  type MeSessionsService,
  type PersonaPreviewInput,
  type ReconcileProactiveScheduleFn,
  type VerifySelfPasswordPort,
  type HasPasswordCredentialPort,
  type OnboardingInstallDependencies,
  type OnboardingLoginDependencies,
  type ExternalModulesDependencies,
  type SettingsRoutesDependencies,
  type ModuleDistributionDependencies,
  type HerdrInstallDependencies,
  type HostRestartDependencies,
  type AppMapReadService,
  collectHostDiagnostics,
  assertDiagnosticsSafe,
  loadAppMap,
  createAppMapReadService,
  createSourceInspector,
  getModuleBuild,
  updateModuleBuildStatus
} from "@moss/settings";
import {
  TASKS_QUEUE_DEFINITIONS,
  TasksRepository,
  registerTasksJobWorkers,
  registerTasksRoutes,
  TasksCompatibilityHelper,
  tasksModuleManifest,
  tasksModuleSqlMigrationDirectory,
  type EmailTriageFeedbackPort
} from "@moss/tasks";
import {
  goalsModuleManifest,
  goalsModuleSqlMigrationDirectory,
  registerGoalsRoutes,
  registerGoalsMemorySyncWorker,
  registerGoalsMemorySyncReconcileWorker,
  GoalsRepository,
  GOALS_MEMORY_SYNC_QUEUE,
  GOALS_MEMORY_SYNC_RECONCILE_QUEUE
} from "@moss/goals";
import {
  integrationsModuleManifest,
  integrationsModuleSqlMigrationDirectory,
  registerIntegrationsRoutes
} from "@moss/integrations";
import {
  createHostRateLimiter,
  createRobotsGate,
  fetchWebResource,
  fetchWebResourceBytes,
  invalidateWebSearchProviderCache,
  resolveWebSearchProvider,
  setModelNativeSearchResolver,
  setWebSearchKeyResolver,
  type ModelNativeSearchResolver,
  webModuleManifest
} from "@moss/web-research";
import {
  registerWellnessRoutes,
  registerWellnessExportRoutes,
  registerWellnessExportWorkers,
  WELLNESS_EXPORT_QUEUE_DEFINITIONS,
  wellnessModuleManifest,
  wellnessModuleSqlMigrationDirectory
} from "@moss/wellness";
import { registerWeatherRoutes, weatherModuleManifest } from "@moss/weather";
import { workshopModuleManifest } from "@moss/workshop";
import {
  configureSportsBriefingService,
  configureSportsChatTools,
  createSportsPreviewStore,
  createEspnDatasetAdapter,
  registerSportsRoutes,
  SportsFollowsRepository,
  SportsBrowserBroker,
  SportsBrowserBrokerServer,
  SportsBrowserClient,
  SportsEspnCoverageRepository,
  SportsPhotoStore,
  SportsPublicSourceReader,
  SportsService,
  type RegisteredStory,
  SportsSourceService,
  SportsSourcesRepository,
  SPORTS_BROWSER_SOCKETS,
  sportsModuleManifest,
  sportsModuleSqlMigrationDirectory
} from "@moss/sports";
import {
  configureNewsBriefingService,
  createRssDatasetAdapter,
  NEWS_QUEUE_DEFINITIONS,
  newsAddSourceRequirement,
  newsModuleManifest,
  newsModuleSqlMigrationDirectory,
  registerNewsJobWorkers,
  registerNewsRoutes,
  NewsCredentialRepository,
  createNewsCredentialedSourceReader,
  NEWSAPI_CONNECTION_ID,
  publisherConnection,
  createRegistryNewsPublisherConnectionPort,
  enqueueNewsRefresh,
  type NewsAiPort,
  type NewsRoutesDependencies,
  type NewsStoryFeedbackPort
} from "@moss/news";
import { assertValidFetchHosts, createDatasetClient, DatasetCache } from "@moss/datasets";
import {
  notesModuleManifest,
  notesCommitmentProvider,
  createNotesRecallPort,
  notesModuleSqlMigrationDirectory,
  NOTES_QUEUE_DEFINITIONS,
  reconcileNotesSchedule,
  registerNotesSyncRoutes,
  registerNotesJobWorkers
} from "@moss/notes";
import {
  registerScratchpadRoutes,
  scratchpadModuleManifest,
  scratchpadModuleSqlMigrationDirectory
} from "@moss/scratchpad";
import {
  FeedbackTargetVerifierRegistry,
  buildStoryTargetContext,
  createStoryFeedbackTargetVerifier,
  createStoryRelevancePolicy,
  registerUsefulnessFeedbackRoutes,
  storyFeedbackTargetRef,
  usefulnessFeedbackModuleManifest,
  usefulnessFeedbackModuleSqlMigrationDirectory
} from "@moss/usefulness-feedback";
import {
  CardRepository,
  makeProactiveCardVerifier,
  proactiveMonitoringModuleManifest,
  proactiveMonitoringSqlMigrationDirectory,
  PROACTIVE_SCAN_SOURCE_QUEUE,
  registerProactiveMonitoringRoutes,
  registerProactiveMonitoringWorkers,
  type ProactiveScanSourceJobPayload
} from "@moss/proactive-monitoring";

import {
  createDefaultPersonaPreview,
  createRuntimeEmbeddingProvider,
  quietHoursPortImpl,
  runtimeMemoryRetriever,
  usefulnessFeedbackRepository
} from "./built-in-module-helpers.js";
import { assertModulesCompatible } from "./compat-gate.js";
import {
  buildWorkflowRegistry,
  validateModuleWorkflows,
  type WorkflowRegistry
} from "./workflow-registry.js";
import {
  makeCliPresentProbe,
  makeChatMultiplexerStatusProbe,
  makeProviderConnectionCheckProbe,
  resolveChatEngineFactory,
  createPersistentRuntimeConfigLiveReader,
  type LiveChatMultiplexerStatus
} from "./chat-multiplexer.js";
import { createNewsCredentialCipherPort } from "./news-credential-cipher.js";
import { buildOnboardingInstall } from "./onboarding-install.js";
import { buildCliModelLister, buildOnboardingLogin } from "./onboarding-login.js";

// Declared here (not `apps/api/src/server.ts`, which sets it via an onRequest hook)
// because module-registry is the composition root every consumer of the field
// already reaches: apps/api sets `request.timeZone` and imports this package
// directly, and every built-in module that reads it (e.g. wellness's
// `resolveRouteTimeZone` via `resolveRequestTimeZoneForRoute` below) is wired
// through here. Ambient module augmentations only apply within the TS program
// they're compiled into, so keeping the declaration next to the file everyone
// already imports avoids "works in one tsc invocation, breaks in another" drift
// (#801 Phase A — apps/web's isolated `tsc` once reached wellness routes through
// a since-removed settings -> module-registry import edge and couldn't see the
// augmentation while it lived in server.ts).
declare module "fastify" {
  interface FastifyRequest {
    timeZone?: string;
  }
}

export type { ChatEngineFactory } from "@moss/chat";
export type { TerminalRpcConnectOptions, TerminalRpcHandle } from "@moss/ai";
export type { MossModuleManifest } from "@moss/module-sdk";
export { aggregateFocusSignals } from "@moss/module-sdk";
// Re-exported for the two external-module rpc construction sites (#1281): they
// need the same embedder seam built-in modules use, without naming a provider.
export { createRuntimeEmbeddingProvider } from "./built-in-module-helpers.js";
// Re-exported for apps/worker's module AI bridge, which must supply the same CLI structured
// adapter apps/api does or every module worker AI call fails `needs_config` against a
// CLI-authenticated provider. The worker reaches chat internals through this package rather than
// taking a direct @moss/chat dependency, exactly as it does for the embedder above.
export { createCliStructuredAdapterFactory } from "@moss/chat";

export * from "./external/validate.js";
export * from "./external/types.js";
export * from "./external/reconcile.js";
export * from "./external/preferences.js";

export {
  createActiveModulesResolver,
  type ActiveModulesResolverDeps
} from "./active-modules-resolver.js";

export {
  PLATFORM_UNGUARDED_ROUTES,
  assertRouteCoverage,
  buildRouteModuleIndex,
  lookupModuleForRoute,
  registerRouteEnablementGuard,
  routeKey,
  type RegisteredRoute,
  type RouteGuardDeps,
  type RouteKey,
  type RouteModuleIndex
} from "./route-guard.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate pnpm-workspace.yaml above ${startDir}`);
}

const APP_MAP_ARTIFACT_PATH = join(findWorkspaceRoot(MODULE_DIR), "dist", "app-map.json");

export interface BuiltInRouteDependencies {
  // Raw root handle forwarded to settings' BootstrapHelper (pre-session bootstrap status).
  // Documented Kysely< exemption — see packages/settings/src/bootstrap.ts. This is the
  // ONLY root-handle escape hatch in the route layer; module admin checks run through
  // DataContextDb (connectors' admin check was converted off appDb in Audit B3) — plus
  // the bounded pre-auth non-secret instance-config reads documented in
  // DEVELOPMENT_STANDARDS.md (registration gate + `chat.multiplexer` boot resolution).
  readonly rootDb: Kysely<MossDatabase>;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly listConfiguredAuthProviders: () => readonly AuthProviderStatusDto[];
  readonly listModuleManifests: () => readonly MossModuleManifest[];
  /**
   * Async, actor-filtered resolver (the enablement SEAM). Used by the tool surfaces
   * (MCP gateway + AI REST tools) and the route guard. Distinct from
   * listModuleManifests (the full registered set used by briefings + /api/modules).
   */
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  /**
   * Per-request, per-actor focus-signal aggregator. The composition root resolves the
   * actor's ACTIVE modules first, builds providers from them, then runs EACH provider in
   * its OWN withDataContext (fresh transaction → fresh pg connection) before aggregating —
   * so a disabled module contributes nothing AND one provider aborting its transaction
   * (25P02) cannot poison the others (fail-soft is real, not just declared). Tasks consumes
   * an opaque FocusSignal[].
   */
  readonly focusSignals?: (ctx: {
    readonly actorUserId: string;
    readonly requestId: string;
  }) => Promise<readonly { moduleId: string; readiness: number; summary: string }[]>;
  /** Resolved MCP endpoint advertised to CLI chat engines. Owned by API composition config. */
  readonly mcpServerUrl: string;
  /** #1110 app-map read service, built once in registerBuiltInApiRoutes and threaded to the ai/chat modules' assistant tool wiring. */
  readonly appMapService?: AppMapReadService;
  /** Read-only platform diagnostics, kept in the chat gateway's read service bag. */
  readonly platformDiagnostics?: PlatformDiagnosticsService;
  /** Override the live-chat engine factory (tests inject a fake); defaults to real tmux. */
  readonly chatEngineFactory?: ChatEngineFactory;
  /**
   * #1059 TEST-ONLY override for the owner-terminal WS relay's cli-runner dial (tests inject a
   * fake handle to exercise the connect-ok/open-fail cleanup path without a real cli-runner
   * process); defaults to the real TerminalRpcClient.connect below when absent.
   */
  readonly connectTerminalRpc?: (options: TerminalRpcConnectOptions) => Promise<TerminalRpcHandle>;
  /**
   * #342 (§3.5 boot-time fork) — built by `registerBuiltInApiRoutes` only on the socket path
   * (JARVIS_CLI_RUNNER_SOCKET set) and forwarded to `registerChatRoutes`, where the chat runtime uses
   * it to select the RPC client (and fail-fast on a missing §6.6 secret), wire the §5.3 reconciliation
   * hook, and start the §5.5 idle reaper. Absent on the in-process / host-dev path (the late-bound
   * {@link chatEngineFactory} wrapper is used there instead, preserving admin `chat.multiplexer`
   * resolution).
   */
  readonly chatEngineSelection?: ChatRoutesDependencies["engineSelection"];
  /** Chat-owned passive graph recall seam; no module imports graph internals directly. */
  readonly passiveMemoryRecall?: ChatRoutesDependencies["passiveMemoryRecall"];
  readonly notesRecall?: ChatRoutesDependencies["notesRecall"];
  /**
   * #342 (§3.4) — the ONE RPC connection to the cli-runner sidecar, when the api runs containerized
   * (JARVIS_CLI_RUNNER_SOCKET set). Owned by the chat runtime (it constructs the connection WITH the
   * §5.3 onReconcile hook + the idle reaper). The composition root adopts it for the onboarding probes
   * (§4.8 socket route) and the connect-on-boot / close-on-shutdown lifecycle. May be supplied here
   * directly, or published after route registration via {@link adoptChatRpcConnection}. Absent on the
   * in-process / host-dev path (no socket).
   */
  readonly chatRpcConnection?: RpcConnection;
  /**
   * #342 — set by `registerBuiltInApiRoutes` and consumed inside `registerChatRoutes` (the composition
   * seam): the chat runtime calls this to publish the ONE RPC connection it constructed back to the
   * probes + boot lifecycle, so a single socket serves both chat and onboarding (§3.4). No-op on the
   * in-process path.
   */
  readonly adoptChatRpcConnection?: (connection: RpcConnection) => void;
  /**
   * #1081 H2 — set by `registerBuiltInApiRoutes` and consumed inside `registerChatRoutes`:
   * the same late-bound "adopt" seam as {@link adoptChatRpcConnection}, but publishing the
   * chat session manager's `dropSessionsForProvider` (built inside `registerChatRoutes`,
   * after this composition root wires the onboarding-install seam). Forwarded into
   * `buildOnboardingInstall`'s `dropSessionsForProvider` dependency via a lazy-dereferencing
   * wrapper, so `/api/onboarding/provider-install` can drop a provider's live sessions after
   * a binary-changing reinstall.
   */
  readonly adoptDropSessionsForProvider?: ChatRoutesDependencies["adoptDropSessionsForProvider"];
  /**
   * #1256 — same late-bound "adopt" seam as {@link adoptChatRpcConnection}, but publishing the
   * chat module's live `AssistantToolGateway` so the ai module's assistant-action resolve route
   * can be wired to `gateway.resolveActionRequest` instead of persisting a decision with no check
   * that a waiter is actually pending on it.
   */
  readonly adoptChatGateway?: ChatRoutesDependencies["adoptChatGateway"];
  /**
   * #1256 — per-server getter over the value {@link adoptChatGateway} publishes. Built fresh inside
   * `registerBuiltInApiRoutes` for each call (mirrors `getRpcConnection`/`getDropSessionsForProvider`
   * above), so the ai module's resolve route reads the gateway wired for THIS server, not whichever
   * server registered chat routes most recently. Do not replace with a module-level binding shared
   * across servers — several integration test files construct multiple `createApiServer` instances
   * in one process, and a shared binding would let the wrong server's gateway (wrong runner/appDb/
   * ConfirmationRegistry) answer another server's resolve calls.
   */
  readonly getResolveActionRequestFn?: () =>
    | AssistantToolGateway["resolveActionRequest"]
    | undefined;
  /**
   * #1554 task #6 — set by `registerBuiltInApiRoutes` and consumed inside `registerChatRoutes`:
   * same late-bound "adopt" seam as {@link adoptChatRpcConnection}/
   * {@link adoptDropSessionsForProvider}, publishing the wiring closure's
   * `SessionTokenRegistry.revokeBySessionId` back to the composition root so the in-process boot
   * path's `resolveChatEngineFactory` call can thread it into the persistent-runtime pool's
   * `onPersistentReap` (closes task #5's documented gap — see `chat-multiplexer.ts`).
   */
  readonly adoptMcpTokenRevoke?: ChatRoutesDependencies["adoptMcpTokenRevoke"];
  readonly resolveEveningInterviewSeed?: ChatRoutesDependencies["resolveEveningInterviewSeed"];
  readonly revokeUserSessions?: (userId: string) => Promise<number>;
  /** Auth-owned current-user session list/revoke service (#237). */
  readonly meSessions?: MeSessionsService;
  /**
   * Auth-owned password re-verification for self-service account deletion (#239).
   * Absent when no auth runtime is wired; the route fails closed for
   * password-bearing accounts.
   */
  readonly verifySelfPassword?: VerifySelfPasswordPort;
  /**
   * Auth-owned existence probe (does the actor own a password credential?) for
   * GET /api/me + the self-delete dialog (migration 0045 revoked app_runtime
   * SELECT on auth_accounts).
   */
  readonly hasPasswordCredential?: HasPasswordCredentialPort;
  readonly bootstrapConnectionString?: string;
  readonly googleConnectionService?: GoogleConnectionService;
  readonly googleApiClient?: GoogleApiClient;
  readonly connectorsRepository?: ConnectorsRepository;
  /** Live multiplexer status probe for the admin settings UI (resolved fresh per request). */
  readonly getChatMultiplexerStatus?: (
    configured: ChatMultiplexerChoice
  ) => Promise<LiveChatMultiplexerStatus>;
  /** Host diagnostics runtime-facts provider (#255), built by the API composition root. */
  readonly hostDiagnostics?: HostDiagnosticsProvider;
  readonly personaPreview?: (input: PersonaPreviewInput) => Promise<string>;
  readonly createCliStructuredAdapter?: ReturnType<typeof createCliStructuredAdapterFactory>;
  /**
   * Bounded, live onboarding probes (Phase 2). Built inside registerBuiltInApiRoutes (sync,
   * no boot-time probing) and forwarded to the settings module so it keeps no @moss/ai /
   * @moss/connectors PACKAGE dependency (module isolation). Each probes lazily, per request.
   */
  readonly onboardingProbes?: {
    readonly cliPresent: (kind: OnboardingProviderKind) => Promise<boolean>;
    readonly testProviderConnection: (
      kind: OnboardingProviderKind
    ) => Promise<OnboardingProviderCheckResponse>;
    readonly connectorAccountExists: (scopedDb: DataContextDb) => Promise<boolean>;
  };
  /**
   * #342 §A.5 install seam, built inside registerBuiltInApiRoutes on the socket path and forwarded
   * to the settings module (module isolation — settings never imports @moss/chat / cli-runner).
   * Absent on the host-dev / in-process path ⇒ the install route fails closed (500).
   */
  readonly onboardingInstall?: OnboardingInstallDependencies;
  /**
   * #342 §L.5 login seam, built inside registerBuiltInApiRoutes on the socket path and forwarded to
   * the settings module (module isolation). Absent on the host-dev / in-process path ⇒ the login
   * routes fail closed (500).
   */
  readonly onboardingLogin?: OnboardingLoginDependencies;
  /**
   * #2208 — the ONE model-discovery service for the ai module's routes, built inside
   * registerBuiltInApiRoutes with the cli-runner model lister on the socket path. Absent (tests,
   * host-dev) ⇒ the ai routes build a lister-less service and CLI discovery reports `unavailable`.
   */
  readonly aiModelDiscovery?: ModelDiscoveryService;
  /**
   * #917 — boot-time external-module discovery snapshot, built by the API composition root
   * (apps/api discoverExternalModules) and forwarded to the settings module, where the Task 9
   * admin GET route reconciles it against app.external_modules. Absent ⇒ feature off. Optional
   * so every existing registerBuiltInApiRoutes call site keeps compiling unchanged.
   */
  readonly externalModules?: ExternalModulesDependencies;
  /** #1762: forwarded verbatim to the settings routes; see the port's doc comment there. */
  readonly listInstalledExternalModules?: SettingsRoutesDependencies["listInstalledExternalModules"];
  readonly moduleDistribution?: ModuleDistributionDependencies;
  /** Fixed-script Herdr install executor port (#993), built by the API composition root. */
  readonly herdrInstall?: HerdrInstallDependencies;
  /** #1748 admin restart control directory, built by the API composition root. */
  readonly hostRestart?: HostRestartDependencies;
  readonly reconcileExternalModuleJobs?: (
    change:
      | { readonly kind: "module"; readonly moduleId: string }
      | { readonly kind: "user"; readonly userId: string }
  ) => Promise<void>;
  /** TEST-ONLY. Inject a fake fetch for weather (and any other external HTTP) without real network. */
  readonly fetchFn?: typeof fetch;
  /**
   * #1263 Task 15: install-time self-operation grant port, built by the API composition root
   * over its one AiRepository instance and forwarded to the settings module (module isolation —
   * settings never imports @moss/ai). Threaded straight through to registerSettingsRoutes.
   */
  readonly grantSelfOperationForModule?: (
    scopedDb: DataContextDb,
    manifest: MossModuleManifest
  ) => Promise<void>;
}

export interface BuiltInWorkerDependencies {
  readonly rootDb: Kysely<MossDatabase>;
  readonly dataContext: DataContextRunner;
  readonly focusSignals?: BuiltInRouteDependencies["focusSignals"];
  /**
   * Structured logger for worker-path diagnostics. Production (apps/worker) passes
   * a pino root; tests omit it. Threaded into per-module worker registrations so
   * no `console.*` lands in production worker logs (observability spec #413).
   */
  readonly logger?: FastifyBaseLogger;
  /**
   * #1282 Task 2: external (JSON-manifest) module discovery, built by apps/worker (the only
   * place holding both external-module discovery and the external worker runtime) and
   * forwarded to the briefings module. Both fields are optional — a host with zero external
   * modules must still boot, and neither is constructed here: packages/module-registry has
   * no external discovery and no external worker runtime, so building them in this file
   * would violate module isolation (J2).
   */
  readonly externalBriefingManifests?: readonly JsonMossModuleManifest[];
  readonly invokeExternalBriefing?: ExternalBriefingInvoker;
}

export function createStructuredChatEngineFactory(options: {
  readonly socketConfigured: boolean;
  readonly getRpcConnection: () => RpcConnection | undefined;
  readonly fallback: ChatEngineFactory;
}): ChatEngineFactory {
  return (provider, sessionKey, engineOptions) => {
    if (!options.socketConfigured) return options.fallback(provider, sessionKey, engineOptions);
    const connection = options.getRpcConnection();
    if (!connection) {
      throw new CliChatUnavailableError("cli-runner RPC connection is not ready");
    }
    return new ChatEngineRpcClient(provider, sessionKey, connection, engineOptions?.executionMode);
  };
}

export interface BuiltInModuleRegistration {
  readonly manifest: MossModuleManifest;
  readonly sqlMigrationDirectories: readonly string[];
  readonly queueDefinitions: readonly QueueDefinition[];
  readonly registerRoutes?: (
    server: FastifyInstance,
    dependencies: BuiltInRouteDependencies
  ) => void;
  readonly registerWorkers?: (
    boss: PgBoss,
    dependencies: BuiltInWorkerDependencies
  ) => Promise<readonly string[]>;
}

const newsRobotsGate = createRobotsGate();
const newsHostRateLimiter = createHostRateLimiter();

function buildNewsDiscoveryPorts(
  logger?: Pick<FastifyBaseLogger, "info" | "warn">,
  // #2229: takes the already-built adapter, not a raw engine factory. The route path must pass
  // deps.createCliStructuredAdapter (built from structuredChatEngineFactory, which resolves
  // correctly on both the socket and in-process paths) rather than building a new adapter from
  // deps.chatEngineFactory — that raw late-bound bridge never resolves on the socket path, so
  // every one-shot structured call (source preview) threw "not resolved yet". The worker path
  // keeps its own default (no live chat engine involved there).
  createCliStructuredAdapter: ReturnType<
    typeof createCliStructuredAdapterFactory
  > = createCliStructuredAdapterFactory()
) {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();
  return {
    fetch: (url: string) =>
      fetchWebResource(url, {
        requireHttps: true,
        robots: newsRobotsGate,
        rateLimiter: newsHostRateLimiter
      }),
    image: (url: string, maxBytes: number, allowedHosts?: readonly string[]) =>
      fetchWebResourceBytes(url, {
        requireHttps: true,
        robots: newsRobotsGate,
        rateLimiter: newsHostRateLimiter,
        maxBytes,
        ...(allowedHosts ? { allowedHosts } : {})
      }),
    search: {
      async search(
        scopedDb: DataContextDb,
        query: string,
        options: { limit: number; freshness?: "day" | "week" }
      ) {
        const result = await (
          await resolveWebSearchProvider(scopedDb)
        ).search({
          query,
          ...options
        });
        return { results: [...result.results] };
      }
    },
    ai: {
      generateJson: (
        scopedDb: DataContextDb,
        input: {
          schema: Record<string, unknown>;
          prompt: string;
          maxOutputTokens?: number;
        }
      ) =>
        generateStructured(
          scopedDb,
          { service: "module.news", ...input },
          { repository, cipher, logger, createCliStructuredAdapter }
        ),
      async fingerprint(scopedDb: DataContextDb) {
        const model = (
          await repository.resolveModelForService(scopedDb, "module.news", {
            capability: "json",
            tierHint: "economy"
          })
        ).model;
        if (!model) return null;
        return createHash("sha256").update(`${model.provider_kind}\0${model.id}`).digest("hex");
      }
    }
  };
}

const sportsHostRateLimiter = createHostRateLimiter();

/** #1572: Sports' own discovery ports — URL-only, so no `search` (unlike News). */
function buildSportsDiscoveryPorts(
  logger?: Pick<FastifyBaseLogger, "info" | "warn">,
  browser?: SportsBrowserClient
) {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();
  return {
    fetch: (
      url: string,
      options?: {
        readonly allowedHosts?: readonly string[];
        readonly requestHeaders?: Readonly<Record<string, string>>;
        readonly userAgent?: string;
        readonly allowedContentTypes?: readonly string[];
        readonly beforeRequest?: (hop: {
          readonly url: URL;
          readonly redirectCount: number;
        }) => boolean | void | Promise<boolean | void>;
        readonly maxBytes?: number;
        readonly rejectOversizedResponses?: boolean;
        readonly timeoutMs?: number;
        readonly signal?: AbortSignal;
      }
    ) =>
      fetchWebResource(url, {
        requireHttps: true,
        rateLimiter: sportsHostRateLimiter,
        allowedHosts: options?.allowedHosts,
        requestHeaders: options?.requestHeaders,
        userAgent: options?.userAgent,
        allowedContentTypes: options?.allowedContentTypes,
        beforeRequest: options?.beforeRequest,
        maxBytes: options?.maxBytes,
        rejectOversizedResponses: options?.rejectOversizedResponses,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal
      }),
    // #2211: publication favicons for the source-icon route. Same safety layer as `fetch`, bytes out.
    fetchBytes: (
      url: string,
      options: {
        readonly allowedHosts: readonly string[];
        readonly maxBytes: number;
        readonly rejectOversizedResponses: boolean;
        readonly timeoutMs: number;
      }
    ) =>
      fetchWebResourceBytes(url, {
        requireHttps: true,
        rateLimiter: sportsHostRateLimiter,
        allowedHosts: options.allowedHosts,
        maxBytes: options.maxBytes,
        rejectOversizedResponses: options.rejectOversizedResponses,
        timeoutMs: options.timeoutMs
      }),
    ...(browser ? { browser } : {}),
    ai: {
      generateJson: (
        scopedDb: DataContextDb,
        input: {
          schema: Record<string, unknown>;
          prompt: string;
          maxOutputTokens?: number;
        }
      ) =>
        generateStructured(
          scopedDb,
          { service: "module.sports", ...input },
          {
            repository,
            cipher,
            logger,
            createCliStructuredAdapter: createCliStructuredAdapterFactory()
          }
        ),
      async fingerprint(scopedDb: DataContextDb) {
        const model = (
          await repository.resolveModelForService(scopedDb, "module.sports", {
            capability: "json",
            tierHint: "economy"
          })
        ).model;
        if (!model) return null;
        return createHash("sha256").update(`${model.provider_kind}\0${model.id}`).digest("hex");
      }
    }
  };
}

/**
 * #2228: News' web search availability, resolved once per call through the actor's effective
 * chat model. Shared by hasWebSearch and webSearchReason so the model lookup and engine
 * resolution only happen a single time per call site.
 */
export async function resolveNewsWebSearch(scopedDb: DataContextDb) {
  const model = await new AiRepository().selectChatModelForUser(scopedDb);
  return resolveWebSearchEngine(
    scopedDb,
    model ? { id: model.id, capabilities: model.capabilities } : null
  );
}

/**
 * #2228: the composition-root seam behind model-native (built-in) web search for list-shaped
 * callers (News described topics, source-by-name, the web.search tool). Per request it looks up
 * the actor's effective chat model, asks the engine resolver whether built-in search is active
 * for that model, and if so returns a runner that executes ONE structured request against that
 * exact model with the provider's search tool enabled. The runner closes over the request's
 * scoped data context, so it is built per call and never shared across actors.
 */
export function buildModelNativeSearchResolver(deps: {
  readonly repository: Pick<
    AiRepository,
    "selectChatModelForUser" | "resolveModelForService" | "selectProviderWithCredential"
  >;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly logger?: Pick<FastifyBaseLogger, "info" | "warn">;
  readonly createCliStructuredAdapter?: ReturnType<typeof createCliStructuredAdapterFactory>;
  readonly resolveEngine?: typeof resolveWebSearchEngine;
  readonly generate?: typeof generateStructured;
}): ModelNativeSearchResolver {
  const resolveEngine = deps.resolveEngine ?? resolveWebSearchEngine;
  const generate = deps.generate ?? generateStructured;
  return async (scopedDbUnknown) => {
    const scopedDb = scopedDbUnknown as DataContextDb;
    const model = await deps.repository.selectChatModelForUser(scopedDb);
    const resolution = await resolveEngine(
      scopedDb,
      model ? { id: model.id, capabilities: model.capabilities } : null
    );
    if (resolution.engine !== "model-native" || !model) return null;
    return {
      modelId: model.id,
      runner: async (input) => {
        const generated = await generate(
          scopedDb,
          {
            service: "module.web-research",
            schema: input.schema,
            prompt: input.prompt,
            nativeSearch: true,
            explicitModel: {
              id: model.id,
              provider_config_id: model.provider_config_id,
              provider_kind: model.provider_kind,
              provider_model_id: model.provider_model_id
            }
          },
          {
            repository: deps.repository,
            cipher: deps.cipher,
            logger: deps.logger,
            createCliStructuredAdapter: deps.createCliStructuredAdapter
          }
        );
        if (!generated.ok) return null;
        return { object: generated.object, sources: generated.sources };
      }
    };
  };
}

/**
 * #1110: UAT-only. Deterministically fakes a transient News source-preview error for one
 * sentinel input, so the app-map-grounding UAT spec can prove the "no invented fix" path
 * without a live upstream. Both env vars are set unconditionally in the UAT app container's
 * env_file (tests/uat/provisioner.ts writeUatEnvFile) — absent in every non-UAT deploy, so this
 * is undefined (a no-op) everywhere else.
 */
function buildUatNewsPreviewOverride(): NewsRoutesDependencies["previewOverride"] | undefined {
  const transientInput = resolveMossEnv(process.env, "JARVIS_UAT_NEWS_TRANSIENT_INPUT")?.trim();
  // JARVIS_UAT_SEED_CONFIRM is a Tier C carve-out (never renamed to MOSS_*) — left as a
  // direct read.
  if (process.env.JARVIS_UAT_SEED_CONFIRM !== "1" || !transientInput) return undefined;
  return (input) =>
    input === transientInput
      ? {
          status: "unavailable",
          error: { code: "news.add_source.discovery_unavailable", class: "transient" }
        }
      : undefined;
}

/**
 * #2018: saving, editing or taking back a story preference reshapes what the owning module
 * shows, so it asks that module to recompile. Only News acts on it today — Sports attaches its
 * own refresh in #2019. Several setups run with no queue at all, so a missing queue is a no-op
 * rather than a failure: a preference is still saved, it just takes effect on the next refresh.
 *
 * Exported so the decision can be tested without booting the whole registry.
 */
export function buildStoryPreferenceRefresh(
  boss: PgBoss | null
): (input: { readonly ownerUserId: string; readonly targetKind: string }) => Promise<void> {
  return async ({ ownerUserId, targetKind }) => {
    if (targetKind !== "news_story" || boss === null) return;
    try {
      await enqueueNewsRefresh(boss, ownerUserId);
    } catch {
      // Saving the preference is still truthful when the optional queue is unavailable. A later
      // idempotent request calls this callback again, so a transient send failure cannot strand it.
    }
  };
}

/**
 * #2018: the composition root is the only place News and usefulness feedback meet. News never
 * imports the feedback package (module isolation, and the reference helper hashes with Node's
 * crypto, which must stay out of the browser bundle News also ships), so the concrete port is
 * assembled here and injected into both the News routes and the News workers.
 */
function buildNewsStoryFeedbackPort(
  ai: NewsAiPort,
  logger?: Pick<FastifyBaseLogger, "info" | "warn">
): NewsStoryFeedbackPort {
  const policy = createStoryRelevancePolicy({
    // #953/provider-agnostic: News hands over the same router-backed port it already uses. The
    // policy never names a provider or a model.
    ai,
    repository: usefulnessFeedbackRepository,
    // Counts and names only. A reason, a headline, a link or a story reference never reaches here.
    logger: {
      info: (fields) => logger?.info(fields, "story relevance"),
      warn: (fields) => logger?.warn(fields, "story relevance")
    }
  });
  return {
    storyRef: (canonicalUrl) => storyFeedbackTargetRef("news", canonicalUrl),
    listDismissedRefs: async (scopedDb, ownerUserId) => {
      const rules = await usefulnessFeedbackRepository.listActiveStoryRules(
        scopedDb,
        ownerUserId,
        "news"
      );
      return new Set(
        rules.filter((rule) => rule.direction === "less").map((rule) => rule.targetRef)
      );
    },
    registerTargets: async (scopedDb, ownerUserId, rows) => {
      for (const row of rows) {
        await usefulnessFeedbackRepository.upsertTarget(scopedDb, {
          ownerUserId,
          targetKind: "news_story",
          targetRef: row.storyRef,
          surface: row.surface,
          sourceKind: "news",
          sourceLabel: row.sourceLabel,
          metadata: buildStoryTargetContext({
            moduleId: "news",
            headline: row.headline,
            sourceLabel: row.sourceLabel,
            publishedAt: row.publishedAt,
            topicRef: row.topicRef,
            hasEditorialEvidence: row.hasEditorialEvidence
          })
        });
      }
    },
    recordTargetRegistrationFailure: ({ targetCount }) =>
      logger?.warn({ event: "news_story_target_registration_failed", targetCount }),
    applyRelevance: (scopedDb, input) =>
      policy(scopedDb, {
        ownerUserId: input.ownerUserId,
        moduleId: "news",
        candidates: input.candidates,
        now: input.now
      })
  };
}

/** Recurring per-user/per-source scheduled check — at most every 30 minutes (spec §7). */
const PROACTIVE_CHECK_CRON = "*/30 * * * *";
export const PEOPLE_NOTES_SUGGEST_UPDATES_BEHAVIOR_ID = "people.notes.suggest-updates";

export function buildCalendarFollowThroughPort(
  deps: {
    readonly tasksRepository?: Pick<TasksRepository, "create">;
    readonly aiRepository?: Pick<AiRepository, "listActionPolicies">;
    readonly calendarWrite?: {
      createEvent(
        scopedDb: DataContextDb,
        ctx: {
          readonly actorUserId: string;
          readonly requestId: string;
          readonly chatSessionId: string;
        },
        window: {
          readonly start: Date;
          readonly end: Date;
          readonly durationMinutes: number;
          readonly title: string;
        },
        options: { readonly requireCacheMirror: true; readonly followThroughTargetRef: string }
      ): Promise<{ readonly created: boolean; readonly calendarEventId?: string }>;
    };
  } = {}
): NonNullable<ComposeDeps["calendarFollowThrough"]> {
  const tasksRepository = deps.tasksRepository ?? new TasksRepository();
  const aiRepository = deps.aiRepository ?? new AiRepository();
  const connectorsRepository = new ConnectorsRepository();
  const calendarRepository = new CalendarRepository();
  const calendarWrite =
    deps.calendarWrite ??
    buildCalendarWriteService({
      googleService: new RuntimeGoogleConnectionService({
        repository: connectorsRepository,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient()
      }),
      googleApiClient: new RuntimeGoogleApiClient(),
      connectorsRepository,
      calendarRepository
    });

  return {
    async executeAutoActions({ scopedDb, actorUserId, requestId, targetRef, signal }) {
      const refs: { targetRef: string; taskId?: string; calendarEventId?: string } = { targetRef };
      const sourceRef = calendarFollowThroughSourceRef(targetRef);

      if (signal.suggestedActions.includes("create_task")) {
        const task = await tasksRepository.create(scopedDb, {
          title: signal.summary,
          status: "todo",
          source: "calendar",
          sourceRef,
          externalKey: sourceRef
        });
        refs.taskId = task.id;
      }

      if (signal.suggestedActions.includes("block_time")) {
        const policies = await aiRepository.listActionPolicies(scopedDb);
        const writebackPolicy = policies.find(
          (policy) =>
            policy.moduleId === "calendar" && policy.actionFamilyId === "calendar_writeback"
        );
        if (writebackPolicy?.tier === "trusted_auto") {
          const window = calendarFollowThroughWindow(signal);
          if (window) {
            const result = await calendarWrite.createEvent(
              scopedDb,
              { actorUserId, requestId, chatSessionId: "" },
              window,
              { requireCacheMirror: true, followThroughTargetRef: targetRef }
            );
            if (result.created && result.calendarEventId) {
              refs.calendarEventId = result.calendarEventId;
            }
          }
        }
      }

      return refs;
    }
  };
}

export function buildCalendarFollowThroughSideEffects(
  deps: {
    readonly tasksRepository?: Pick<TasksRepository, "getById" | "update">;
    readonly calendarRepository?: Pick<CalendarRepository, "getById">;
    readonly calendarWrite?: {
      deleteEvent(
        scopedDb: DataContextDb,
        ctx: {
          readonly actorUserId: string;
          readonly requestId: string;
          readonly chatSessionId: string;
        },
        input: { readonly eventId: string }
      ): Promise<{ readonly deleted: boolean }>;
    };
  } = {}
) {
  const tasksRepository = deps.tasksRepository ?? new TasksRepository();
  const connectorsRepository = new ConnectorsRepository();
  const calendarRepository = deps.calendarRepository ?? new CalendarRepository();
  const calendarWrite =
    deps.calendarWrite ??
    buildCalendarWriteService({
      googleService: new RuntimeGoogleConnectionService({
        repository: connectorsRepository,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient()
      }),
      googleApiClient: new RuntimeGoogleApiClient(),
      connectorsRepository,
      calendarRepository: calendarRepository as CalendarRepository
    });

  return {
    async removeCreatedRefs(
      scopedDb: DataContextDb,
      actorUserId: string,
      metadata: Record<string, unknown>
    ): Promise<string | null> {
      const refs = readCalendarFollowThroughRefs(metadata);
      if (!refs) return null;
      const sourceRef = calendarFollowThroughSourceRef(refs.targetRef);
      const removed: string[] = [];

      if (refs.taskId) {
        const task = await tasksRepository.getById(scopedDb, refs.taskId);
        if (task && isCalendarFollowThroughTask(task, sourceRef)) {
          await tasksRepository.update(scopedDb, task.id, { status: "archived" });
          removed.push(`task:${task.id}`);
        }
      }

      if (refs.calendarEventId) {
        const event = await calendarRepository.getById(scopedDb, refs.calendarEventId);
        if (event && isCalendarFollowThroughEvent(event, refs.targetRef)) {
          const result = await calendarWrite.deleteEvent(
            scopedDb,
            { actorUserId, requestId: "feedback:calendar-follow-through", chatSessionId: "" },
            { eventId: event.id }
          );
          if (result.deleted) removed.push(`calendar_event:${event.id}`);
        }
      }

      return removed.length > 0 ? removed.join(",") : null;
    }
  };
}

function readCalendarFollowThroughRefs(metadata: Record<string, unknown>): {
  readonly targetRef: string;
  readonly taskId?: string;
  readonly calendarEventId?: string;
} | null {
  const raw = metadata.calendarFollowThrough;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.targetRef !== "string" || record.targetRef.length === 0) return null;
  const refs = {
    targetRef: record.targetRef,
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.calendarEventId === "string"
      ? { calendarEventId: record.calendarEventId }
      : {})
  };
  return refs.taskId || refs.calendarEventId ? refs : null;
}

function calendarFollowThroughWindow(signal: {
  readonly type?: string;
  readonly summary: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}): { start: Date; end: Date; durationMinutes: number; title: string } | null {
  const start = signal.startsAt ? new Date(signal.startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = signal.endsAt ? new Date(signal.endsAt) : null;
  if (signal.type === "prep_needed") {
    const prepEnd = start;
    const prepStart = new Date(prepEnd.getTime() - 60 * 60_000);
    return { start: prepStart, end: prepEnd, durationMinutes: 60, title: "Prep time" };
  }
  if (!end || Number.isNaN(end.getTime()) || end <= start) return null;
  const durationMinutes = Math.min(
    120,
    Math.max(15, Math.floor((end.getTime() - start.getTime()) / 60_000))
  );
  return { start, end, durationMinutes, title: "Focus time" };
}

export function isPeopleNotesSuggestUpdatesEnabled(
  scopedDb: DataContextDb,
  preferencesRepository: SourceBehaviorPreferencesPort = new PreferencesRepository()
): Promise<boolean> {
  return isBehaviorEnabled(
    scopedDb,
    { manifests: getBuiltInModuleManifests(), preferencesRepository },
    PEOPLE_NOTES_SUGGEST_UPDATES_BEHAVIOR_ID
  );
}

export function createNotificationPreferencePort(
  preferencesRepository = new PreferencesRepository()
): NotificationPreferencePort {
  return {
    async isModuleEnabled(scopedDb, moduleId) {
      const raw = await preferencesRepository.get(scopedDb, `notifications:${moduleId}`);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
      const enabled = (raw as { enabled?: unknown }).enabled;
      return typeof enabled === "boolean" ? enabled : true;
    }
  };
}

export function buildReconcileProactiveSchedule(boss: PgBoss): ReconcileProactiveScheduleFn {
  return async (actorUserId, pref) => {
    const allProviders = proactiveMonitorProvidersFor(getBuiltInModuleManifests());
    for (const { provider } of allProviders) {
      const source = provider.source as ProactiveSource;
      // "/" separator, NOT ":" — pg-boss v12's assertKey restricts schedule keys to
      // [\w.\-/] (see job-reconciler.ts's identical fix, #1147). One row per user+source.
      const scheduleKey = `${actorUserId}/${source}`;
      if (pref.enabled && pref.sources[source]?.enabled) {
        const data: ProactiveScanSourceJobPayload = {
          actorUserId,
          source,
          reason: "scheduled-check",
          idempotencyKey: `scheduled-check:${actorUserId}:${source}`
        };
        // Defense-in-depth: boss.schedule does NOT route through sendJob's metadata guard.
        assertMetadataOnlyPayload(data);
        await boss.schedule(PROACTIVE_SCAN_SOURCE_QUEUE.name, PROACTIVE_CHECK_CRON, data, {
          key: scheduleKey
        });
      } else {
        await boss.unschedule(PROACTIVE_SCAN_SOURCE_QUEUE.name, scheduleKey);
      }
    }
  };
}

function createNotificationDigestSender(): NotificationDigestSender {
  const connectorsRepository = new ConnectorsRepository();
  const cipher = createConnectorSecretCipher();
  const googleProvider = new GoogleEmailWriteProvider(
    new RuntimeGoogleConnectionService({
      repository: connectorsRepository,
      cipher,
      oauthClient: new GoogleOAuthClient()
    }),
    new RuntimeGoogleApiClient()
  );
  const imapProvider = new ImapEmailWriteProvider(connectorsRepository, cipher);

  return {
    async sendDigest(scopedDb, input) {
      const accounts = await connectorsRepository.listAccounts(scopedDb);
      const google = accounts.find(
        (account) => account.status === "active" && account.provider_type === "google"
      );
      if (google) {
        return googleProvider.sendNew(scopedDb, {
          to: input.to,
          subject: input.subject,
          body: input.text
        });
      }
      const imap = accounts.find(
        (account) => account.status === "active" && account.provider_type === "imap"
      );
      if (!imap) return { ok: false };
      return imapProvider.sendNew(scopedDb, {
        connectorAccountId: imap.id,
        to: input.to,
        subject: input.subject,
        body: input.text
      });
    }
  };
}

/**
 * Composes the tasks module's EmailTriageFeedbackPort over the email cache and the
 * connectors feedback store. Lives here because only the composition root may import
 * both modules; enrichment comes from the CACHED row (metadata columns only) — full
 * bodies never reach the learning record (#729 §9).
 */
export function createEmailTriageFeedbackPort(): EmailTriageFeedbackPort {
  const emailRepository = new EmailRepository();
  const connectorsRepository = new ConnectorsRepository();
  const suppressionRepository = new EmailActionSuppressionRepository();
  return {
    async record(scopedDb, input) {
      const parsedRef = input.taskSourceRef ? parseEmailSourceRef(input.taskSourceRef) : null;
      const row = parsedRef
        ? await emailRepository.getByConnectorAccountAndExternalId(
            scopedDb,
            parsedRef.connectorAccountId,
            parsedRef.externalId
          )
        : undefined;
      const signals = (row?.signals ?? {}) as {
        actionability?: { category?: string };
        confidence?: number;
      };
      const sender = row?.sender ?? "unknown";
      const senderDomain = sender.includes("@")
        ? (sender.split("@").pop() ?? "unknown").toLowerCase()
        : "unknown";
      await connectorsRepository.recordTriageFeedback(scopedDb, {
        connectorAccountId: row?.connector_account_id ?? null,
        actionability: signals.actionability?.category ?? "unknown",
        sender,
        senderDomain,
        subjectPrefix: row ? row.subject.slice(0, 120) : null,
        actionType: null,
        confidence: typeof signals.confidence === "number" ? signals.confidence : null,
        modelVersion: null,
        verdict: input.verdict,
        reason: null
      });
      if (input.subjectSignature) {
        if (input.verdict === "accepted") {
          await suppressionRepository.resetAccepted(scopedDb, input.subjectSignature);
        } else {
          await suppressionRepository.incrementDismissal(scopedDb, input.subjectSignature);
        }
      }
    }
  };
}

/** Boolean-only bridge from connectors to both existing memory retrieval paths. */
export function createActionRowRelevancePort(): ActionRowRelevancePort {
  return {
    async hasRelevantContext(scopedDb, input) {
      const [vaultChunks, graphResult] = await Promise.all([
        runtimeMemoryRetriever.retrieve(scopedDb, input.inferredSubject, 5, "vault"),
        (async () => {
          const provider = await createRuntimeEmbeddingProvider(scopedDb);
          return new GraphMemoryRecallService(provider).recall(
            scopedDb,
            input.ownerUserId,
            input.inferredSubject
          );
        })()
      ]);
      return (
        graphResult.items.length > 0 ||
        vaultChunks.some((chunk) => sharesSubjectToken(input.inferredSubject, chunk.text))
      );
    }
  };
}

const peopleManifest: typeof peopleModuleManifest = {
  ...peopleModuleManifest,
  routes: [
    ...(peopleModuleManifest.routes ?? []),
    { method: "GET", path: "/api/people/notes-directories" }
  ]
};

/**
 * #1263: tasks bypasses the generic canonical-key-only grant here, because it has a legacy
 * `tasks.agency_auto_execute` boolean the generic path doesn't know about — see
 * TasksCompatibilityHelper.grantInstallTimeTrustIfUnset. Extracted as a standalone, exported
 * function (rather than left inline in the settings registration below) so the ROUTING decision
 * itself — tasks manifests go to the compat helper, everything else goes to the generic port —
 * is independently testable without booting the full settings route tree.
 */
export function resolveGrantSelfOperationForModule(
  genericGrant: BuiltInRouteDependencies["grantSelfOperationForModule"]
): (scopedDb: DataContextDb, manifest: MossModuleManifest) => Promise<void> {
  return (scopedDb, manifest) =>
    manifest.id === tasksModuleManifest.id
      ? new TasksCompatibilityHelper(new PreferencesRepository()).grantInstallTimeTrustIfUnset(
          scopedDb
        )
      : (genericGrant?.(scopedDb, manifest) ?? Promise.resolve());
}

const BUILT_IN_MODULES: readonly BuiltInModuleRegistration[] = [
  {
    manifest: settingsModuleManifest,
    sqlMigrationDirectories: [settingsModuleSqlMigrationDirectory],
    queueDefinitions: [...EXPORT_QUEUE_DEFINITIONS],
    registerRoutes: (server, deps) => {
      registerSettingsRoutes(server, {
        rootDb: deps.rootDb,
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        listConfiguredAuthProviders: deps.listConfiguredAuthProviders,
        listModuleManifests: deps.listModuleManifests,
        moduleDeletionTables: MODULE_DELETION_TABLES,
        revokeUserSessions: deps.revokeUserSessions,
        meSessions: deps.meSessions,
        verifySelfPassword: deps.verifySelfPassword,
        hasPasswordCredential: deps.hasPasswordCredential,
        bootstrapConnectionString: deps.bootstrapConnectionString,
        getChatMultiplexerStatus: deps.getChatMultiplexerStatus,
        hostDiagnostics: deps.hostDiagnostics,
        herdrInstall: deps.herdrInstall,
        hostRestart: deps.hostRestart,
        onboardingProbes: deps.onboardingProbes,
        onboardingInstall: deps.onboardingInstall,
        onboardingLogin: deps.onboardingLogin,
        externalModules: deps.externalModules, // #917: thread the boot snapshot to settings routes
        listInstalledExternalModules: deps.listInstalledExternalModules, // #1762
        moduleDistribution: deps.moduleDistribution,
        reconcileExternalModuleJobs: deps.reconcileExternalModuleJobs,
        // #1263: routing extracted to resolveGrantSelfOperationForModule (see its doc comment) so
        // the tasks-vs-generic decision is independently testable, not just the compat helper.
        grantSelfOperationForModule: resolveGrantSelfOperationForModule(
          deps.grantSelfOperationForModule
        ),
        personaPreview:
          deps.personaPreview ??
          createDefaultPersonaPreview(deps.dataContext, {
            createCliStructuredAdapter: deps.createCliStructuredAdapter
          }),
        preferencesRepository: new PreferencesRepository(),
        notificationUnreadPort: new NotificationsRepository(),
        boss: deps.boss,
        // #449: wire the per-actor 15-min notes-sync heartbeat. Injected as a hook
        // (not imported in @moss/settings) because @moss/notes already depends
        // on @moss/settings for resolveNotesRoots — a direct import would cycle.
        reconcileNotesSchedule: deps.boss
          ? (actorUserId, hasPath) => reconcileNotesSchedule(deps.boss!, actorUserId, hasPath)
          : undefined,
        reconcileProactiveSchedule: deps.boss
          ? buildReconcileProactiveSchedule(deps.boss)
          : undefined,
        fetchFn: deps.fetchFn
      });
      // Instance-wide Brave Search key: dedicated admin routes (the key is AES-256-GCM
      // encrypted at rest, never returned). The web-research module stays db-free; this
      // composition root injects the decrypt-at-use resolver so the tool resolves the key
      // per request. invalidateWebSearchProviderCache on save/revoke = no restart needed.
      const webSearchCipher = createWebSearchSecretCipher();
      registerWebSearchKeyRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        repository: new SettingsRepository(),
        cipher: webSearchCipher,
        onKeyChanged: invalidateWebSearchProviderCache
      });
      registerRuntimeConfigRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        repository: new SettingsRepository()
      });
      // #2228: built-in (model-native) search for list-shaped callers, resolved per actor from
      // their own chat model. Without this the News gate unlocks but every search comes back empty.
      setModelNativeSearchResolver(
        buildModelNativeSearchResolver({
          repository: new AiRepository(),
          cipher: createAiSecretCipher(),
          logger: server.log,
          createCliStructuredAdapter: deps.createCliStructuredAdapter
        })
      );
      setWebSearchKeyResolver(
        (scopedDb) => readBraveSearchApiKey(scopedDb as DataContextDb, webSearchCipher),
        {
          // Metadata-only observability event. NEVER include the key/ciphertext/envelope/derived
          // value (Hard Invariant: secrets never escape). An operator pairs this with the setting
          // key to diagnose a keyring/rotation problem without exposing secret material.
          onDecryptFailed: () =>
            server.log.warn(
              { event: "web_search.key_decrypt_failed" },
              "Stored Brave Search key failed to decrypt; falling back to env key"
            )
        }
      );
    },
    registerWorkers: (boss, deps) =>
      registerSettingsJobWorkers(boss, deps.dataContext, deps.rootDb, getBuiltInModuleManifests)
  },
  {
    manifest: connectorsModuleManifest,
    sqlMigrationDirectories: [connectorsModuleSqlMigrationDirectory],
    queueDefinitions: [
      ...GOOGLE_SYNC_QUEUE_DEFINITIONS,
      ...GOOGLE_SYNC_SWEEP_QUEUE_DEFINITIONS,
      ...IMAP_SYNC_QUEUE_DEFINITIONS,
      ...MONITOR_QUEUE_DEFINITIONS
    ],
    registerRoutes: (server, deps) =>
      registerConnectorsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss
      }),
    registerWorkers: async (boss, deps) => {
      const createCliStructuredAdapter = createCliStructuredAdapterFactory();
      // Structural task-creation port: connectors never imports the tasks module — the
      // composition root hands it a two-method adapter over TasksRepository (module isolation).
      const tasksRepositoryForEmail = new TasksRepository();
      const emailTaskPort: EmailTaskCreationPort = {
        async create(scopedDb, input) {
          const task = await tasksRepositoryForEmail.create(scopedDb, {
            title: input.title,
            description: input.description ?? undefined,
            status: input.status,
            dueAt: input.dueAt ?? undefined,
            priority: input.priority ?? undefined,
            source: input.source,
            sourceRef: input.sourceRef,
            externalKey: input.externalKey,
            suggestionMetadata: input.suggestionMetadata
          });
          return { id: task.id };
        }
      };
      const actionRowRelevance = createActionRowRelevancePort();
      const googleWorkIds = await registerConnectorsJobWorkers(boss, {
        dataContext: deps.dataContext,
        rootDb: deps.rootDb,
        taskPort: emailTaskPort,
        actionRowRelevance,
        createCliStructuredAdapter,
        logger: deps.logger
      });
      // #792: self-healing periodic sweep, additive to the connect/manual-sync triggers
      // above. Needs the raw root Kysely handle (not DataContextDb) because it must
      // enumerate connected accounts across ALL actors via a bounded SECURITY DEFINER
      // function (sql/0143) — each subsequent GOOGLE_SYNC_QUEUE job it sends stays scoped
      // to that job's own actorUserId exactly as it does today.
      const googleSweepWorkId = await registerGoogleSyncSweepWorker(boss, deps.rootDb);
      const imapWorkIds = await registerImapSyncWorker(boss, {
        dataContext: deps.dataContext,
        createCliStructuredAdapter
      });
      const monitorWorkIds = await registerSourceMonitorWorkers(boss, {
        dataContext: deps.dataContext,
        taskPort: emailTaskPort,
        actionRowRelevance,
        createCliStructuredAdapter
      });
      return [...googleWorkIds, googleSweepWorkId, ...imapWorkIds, ...monitorWorkIds];
    }
  },
  {
    manifest: tasksModuleManifest,
    sqlMigrationDirectories: [tasksModuleSqlMigrationDirectory],
    queueDefinitions: TASKS_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) =>
      registerTasksRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss,
        agencyPreferencesRepository: new PreferencesRepository(),
        localePreferencesRepository: new PreferencesRepository(),
        aiRepository: new AiRepository(),
        aiSecretCipher: createAiSecretCipher(),
        focusSignals: deps.focusSignals,
        emailTriageFeedback: createEmailTriageFeedbackPort()
      }),
    registerWorkers: (boss, dependencies) => registerTasksJobWorkers(boss, dependencies.dataContext)
  },
  {
    manifest: goalsModuleManifest,
    sqlMigrationDirectories: [goalsModuleSqlMigrationDirectory],
    queueDefinitions: [
      {
        name: GOALS_MEMORY_SYNC_QUEUE,
        options: { retryLimit: 3, retryDelay: 60, retryBackoff: true }
      },
      {
        name: GOALS_MEMORY_SYNC_RECONCILE_QUEUE,
        options: { retryLimit: 3, retryDelay: 60, retryBackoff: true }
      }
    ],
    registerRoutes: (server, deps) =>
      registerGoalsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss
      }),
    registerWorkers: async (boss, deps) => {
      const repository = new GoalsRepository();
      const memoryGraphRepo = new MemoryGraphRepository();
      return [
        await registerGoalsMemorySyncWorker(boss, deps.dataContext, repository, memoryGraphRepo),
        await registerGoalsMemorySyncReconcileWorker(boss, deps.dataContext, repository)
      ];
    }
  },
  {
    manifest: integrationsModuleManifest,
    sqlMigrationDirectories: [integrationsModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: (server, deps) =>
      registerIntegrationsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext
      })
  },
  {
    manifest: webModuleManifest,
    sqlMigrationDirectories: [],
    queueDefinitions: []
  },
  {
    manifest: notificationsModuleManifest,
    sqlMigrationDirectories: [notificationsModuleSqlMigrationDirectory],
    queueDefinitions: [{ name: DIGEST_COMPOSE_QUEUE, options: { retryLimit: 0 } }],
    registerRoutes: registerNotificationsRoutes,
    registerWorkers: async (boss, deps) => [
      await registerDataContextWorker(
        boss,
        DIGEST_COMPOSE_QUEUE,
        deps.dataContext,
        (_job, scopedDb) =>
          runNotificationDigestCompose(scopedDb, {
            baseUrl:
              resolveMossEnv(process.env, "JARVIS_PUBLIC_BASE_URL") ?? "http://localhost:3000",
            preferencesRepository: new PreferencesRepository(),
            notificationsRepository: new NotificationsRepository(),
            notificationPreferencePort: createNotificationPreferencePort(),
            sender: createNotificationDigestSender()
          })
      )
    ]
  },
  {
    manifest: calendarModuleManifest,
    sqlMigrationDirectories: [calendarModuleSqlMigrationDirectory],
    queueDefinitions: CALENDAR_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) =>
      registerCalendarRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        calendarWritebackPolicy: {
          set: (scopedDb, moduleId, actionFamilyId, tier) =>
            new AiRepository().setActionPolicy(scopedDb, moduleId, actionFamilyId, tier)
        }
      }),
    registerWorkers: (boss, deps) => registerCalendarJobWorkers(boss, deps.dataContext)
  },
  {
    manifest: emailModuleManifest,
    sqlMigrationDirectories: [emailModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: registerEmailRoutes
  },
  {
    manifest: aiModuleManifest,
    sqlMigrationDirectories: [aiModuleSqlMigrationDirectory],
    queueDefinitions: AI_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) => {
      const preferencesRepository = new PreferencesRepository();
      const tasksCompatibility = new TasksCompatibilityHelper(preferencesRepository);
      const unwiredActionResolver = createUnwiredActionResolver({ runner: deps.dataContext });
      return registerAiRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        resolveActiveModules: deps.resolveActiveModules,
        // #2208: CLI providers discover models through the cli-runner; share the wired service.
        ...(deps.aiModelDiscovery ? { modelDiscovery: deps.aiModelDiscovery } : {}),
        // #915 D6: installed set, not actor-filtered enablement.
        listInstalledModuleIds: () => deps.listModuleManifests().map((manifest) => manifest.id),
        tasksCompatibility,
        readToolServices: {
          ...(deps.connectorsRepository
            ? {
                featureGrants: buildFeatureGrantService({
                  connectorsRepository: deps.connectorsRepository,
                  preferencesRepository: new PreferencesRepository()
                }),
                sourceContext: buildRuntimeSourceContextService({
                  createCliStructuredAdapter: deps.createCliStructuredAdapter
                })
              }
            : {}),
          appMap: deps.appMapService!,
          platformDiagnostics: deps.platformDiagnostics
        },
        // #1059 — the actual @moss/chat dependency for the owner-terminal WS relay lives HERE,
        // not in packages/ai (see the import comment above for why). TerminalRpcClient.connect
        // opens the Unix-domain-socket RPC connection to the cli-runner's terminal host.
        // deps.connectTerminalRpc is the TEST-ONLY override (see BuiltInRouteDependencies) —
        // absent in production, where the real TerminalRpcClient.connect is always used.
        connectTerminalRpc:
          deps.connectTerminalRpc ?? ((options) => TerminalRpcClient.connect(options)),
        // #1256 — late-bound: the chat module's live gateway is adopted below (chat registers
        // after ai on this pass), so this closure defers the lookup to call time, through the
        // per-server getter in `deps` (see getResolveActionRequestFn), instead of capturing a
        // module-level binding that every server sharing this process would contend over.
        resolveActionRequest: (actorUserId, id, status) => {
          const fn = deps.getResolveActionRequestFn?.() ?? unwiredActionResolver;
          return fn(actorUserId, id, status);
        },
        // #1888 — the "Build it" button. packages/ai owns the ownership check and the status
        // transition; the queue lives out here, so the composition root supplies the send.
        // No queue means the field stays undefined and the route answers 503.
        approveModuleBuild: deps.boss
          ? async (scopedDb, buildId, actorUserId) => {
              const boss = deps.boss!;
              await approveModuleBuildPlan(
                {
                  getModuleBuild: async (id) => {
                    const build = await getModuleBuild(scopedDb, id);
                    return build ? { id: build.id, ownerUserId: build.ownerUserId } : null;
                  },
                  updateModuleBuildStatus: (id, status, step) =>
                    updateModuleBuildStatus(scopedDb, id, { status, step }),
                  sendBuildJob: async (id, owner) => {
                    await sendJob(
                      boss,
                      MODULE_BUILD_QUEUE,
                      { buildId: id, actorUserId: owner },
                      { singletonKey: `build:${id}` }
                    );
                  }
                },
                buildId,
                actorUserId
              );
            }
          : undefined,
        cancelModuleBuild: async (scopedDb, buildId, actorUserId) =>
          cancelModuleBuild(
            {
              getModuleBuild: async (id) => {
                const build = await getModuleBuild(scopedDb, id);
                return build
                  ? {
                      id: build.id,
                      ownerUserId: build.ownerUserId,
                      status: build.status,
                      moduleId: build.moduleId
                    }
                  : null;
              },
              updateModuleBuildStatus: (id, status) =>
                updateModuleBuildStatus(scopedDb, id, { status })
            },
            buildId,
            actorUserId
          )
      });
    },
    registerWorkers: (boss, deps) => registerAiMaintenanceWorkers(boss, deps.rootDb)
  },
  {
    manifest: chatModuleManifest,
    sqlMigrationDirectories: [chatModuleSqlMigrationDirectory],
    queueDefinitions: CHAT_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) =>
      registerChatRoutes(server, {
        rootDb: deps.rootDb,
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        // #342 (§3.5): on the RPC/socket path the chat runtime selects the engine itself via
        // `engineSelection`, so we must NOT also pass the in-process late-bound factory wrapper (which
        // would win the explicit-factory branch and never select the RPC client, and would throw
        // "not resolved yet" because the host-dev onReady resolver is skipped on the socket path). On
        // the host-dev path `engineSelection` is undefined and the resolved factory is passed instead.
        chatEngineFactory: deps.chatEngineSelection ? undefined : deps.chatEngineFactory,
        engineSelection: deps.chatEngineSelection,
        adoptChatRpcConnection: deps.adoptChatRpcConnection,
        // #1081 H2: same late-bound "adopt" seam as adoptChatRpcConnection above, publishing
        // the manager's dropSessionsForProvider back to the composition root.
        adoptDropSessionsForProvider: deps.adoptDropSessionsForProvider,
        // #1256 — same late-bound "adopt" seam, publishing the chat module's live
        // AssistantToolGateway so the ai module's resolve route can reach it.
        adoptChatGateway: deps.adoptChatGateway,
        // #1554 task #6: same late-bound "adopt" seam, publishing the wiring closure's
        // SessionTokenRegistry.revokeBySessionId so onReady's resolveChatEngineFactory call
        // below can thread it into the persistent-runtime pool's onPersistentReap.
        adoptMcpTokenRevoke: deps.adoptMcpTokenRevoke,
        resolveActiveModules: deps.resolveActiveModules,
        mcpServerUrl: deps.mcpServerUrl,
        boss: deps.boss,
        personaPreferences: new PreferencesRepository(),
        chatPreferences: new PreferencesRepository(),
        localePreferences: new PreferencesRepository(),
        agencyPreferences: new PreferencesRepository(),
        priorityPreferences: new PreferencesRepository(),
        // #2228: the gateway hides the web.search tool only when the actor has no search engine
        // (no Brave key and no chat model with built-in search, or built-in search switched off).
        webSearchEngineForActor: (actorUserId) =>
          deps.dataContext.withDataContext(
            { actorUserId, requestId: "gateway:web-search-engine" },
            async (scopedDb) => (await resolveNewsWebSearch(scopedDb)).engine
          ),
        notesRecall: deps.notesRecall,
        googleConnectionService: deps.googleConnectionService,
        googleApiClient: deps.googleApiClient,
        connectorsRepository: deps.connectorsRepository,
        featureGrantService: deps.connectorsRepository
          ? buildFeatureGrantService({
              connectorsRepository: deps.connectorsRepository,
              preferencesRepository: new PreferencesRepository()
            })
          : undefined,
        sourceContextService: deps.connectorsRepository
          ? buildRuntimeSourceContextService({
              createCliStructuredAdapter: deps.createCliStructuredAdapter
            })
          : undefined,
        appMapService: deps.appMapService,
        platformDiagnostics: deps.platformDiagnostics,
        listModuleManifests: deps.listModuleManifests
      }),
    registerWorkers: (boss, deps) =>
      registerChatJobWorkers(boss, deps.dataContext, {
        embeddingProviderFactory: createRuntimeEmbeddingProvider,
        extractFactsDeps: {
          aiRepository: new AiRepository(),
          cipher: createAiSecretCipher(),
          candidatesRepository: new MemoryCandidatesRepository(),
          graphRepository: new MemoryGraphRepository()
        },
        logger: deps.logger ? createModuleLogger(deps.logger, "chat") : undefined
      })
  },
  {
    manifest: briefingsModuleManifest,
    sqlMigrationDirectories: [briefingsModuleSqlMigrationDirectory],
    queueDefinitions: BRIEFINGS_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) =>
      registerBriefingsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        listModuleManifests: deps.listModuleManifests,
        boss: deps.boss,
        feedbackRepository: usefulnessFeedbackRepository
      }),
    registerWorkers: (boss, dependencies) => {
      const briefingsLogger = dependencies.logger
        ? createModuleLogger(dependencies.logger, "briefings")
        : undefined;
      return registerBriefingsJobWorkers(boss, dependencies.dataContext, {
        moduleManifests: getBuiltInModuleManifests(),
        // A13: inject the full synthesis deps so the production scheduled briefing
        // actually grounds in vault recency/semantics AND fires the "ready"
        // notification — without this the worker falls back to the no-op retriever
        // (no vault grounding) and never delivers the notification (both seams are
        // built in the engine; this is the wiring that activates them).
        composeDeps: {
          moduleManifests: getBuiltInModuleManifests(),
          aiRepository: new AiRepository(),
          cipher: createAiSecretCipher(),
          personaRepository: new PreferencesRepository(),
          priorityPreferencesRepository: new PreferencesRepository(),
          focusReadiness: dependencies.focusSignals,
          sourceBehaviorPolicy: {
            manifests: getBuiltInModuleManifests(),
            preferencesRepository: new PreferencesRepository()
          },
          resolveUserName: async (scopedDb, actorUserId) => {
            const row = await scopedDb.db
              .selectFrom("app.users")
              .select("name")
              .where("id", "=", actorUserId)
              .executeTakeFirst();
            const name = row?.name?.trim();
            return name && name.length > 0 ? name : actorUserId;
          },
          memoryRetriever: runtimeMemoryRetriever as unknown as MemoryRetriever,
          logger: briefingsLogger,
          connectorSyncAt: async (scopedDb, kind) => {
            const repo = new ConnectorsRepository();
            return getConnectorSyncAt(repo, scopedDb, kind);
          },
          vaultLastWriteAt: async (scopedDb) => {
            const repo = new MemoryRepository();
            return repo.getLatestIngestedAt(scopedDb, "vault");
          },
          featureGrantService: buildFeatureGrantService({
            connectorsRepository: new ConnectorsRepository(),
            preferencesRepository: new PreferencesRepository()
          }),
          sourceContextService: buildRuntimeSourceContextService({
            logger: briefingsLogger,
            createCliStructuredAdapter: createCliStructuredAdapterFactory()
          }),
          calendarFollowThrough: buildCalendarFollowThroughPort(),
          // #1282: injected by apps/worker (external discovery + runtime live only there —
          // J2). NOT read off `moduleManifests` above, which getBuiltInModuleManifests()
          // populates and which therefore matches zero external modules forever (J1).
          externalBriefingManifests: dependencies.externalBriefingManifests,
          invokeExternalBriefing: dependencies.invokeExternalBriefing
        },
        notificationsRepository: new NotificationsRepository(
          quietHoursPortImpl,
          createNotificationPreferencePort()
        ),
        logger: briefingsLogger
      });
    }
  },
  {
    manifest: memoryModuleManifest,
    sqlMigrationDirectories: [memorySqlMigrationDirectory],
    queueDefinitions: [...VAULT_INGEST_QUEUE_DEFINITIONS],
    registerRoutes: (server, deps) => {
      registerMemoryGraphRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext
      });
      registerMemoryDashboardRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext
      });
    },
    registerWorkers: (boss, deps) =>
      registerVaultIngestWorkers(boss, deps.dataContext, {
        vaultRunner: new VaultContextRunner(getVaultBaseDir()),
        vaultsBaseDir: getVaultBaseDir(),
        embeddingProviderFactory: createRuntimeEmbeddingProvider
      })
  },
  {
    manifest: usefulnessFeedbackModuleManifest,
    sqlMigrationDirectories: [usefulnessFeedbackModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: (server, deps) => {
      const cardRepository = new CardRepository();
      const registry = new FeedbackTargetVerifierRegistry();
      registry.register("chat_message", createChatFeedbackTargetVerifier(new ChatRepository()));
      registry.register(
        "briefing_run",
        createBriefingsFeedbackTargetVerifier(
          new BriefingsRepository(),
          usefulnessFeedbackRepository
        )
      );
      registry.register(
        "briefing_item",
        createBriefingsFeedbackTargetVerifier(
          new BriefingsRepository(),
          usefulnessFeedbackRepository
        )
      );
      registry.register("proactive_card", makeProactiveCardVerifier(cardRepository));
      const storyVerifier = createStoryFeedbackTargetVerifier(usefulnessFeedbackRepository);
      registry.register("news_story", storyVerifier);
      registry.register("sports_story", storyVerifier);
      registerUsefulnessFeedbackRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        registry,
        repository: usefulnessFeedbackRepository,
        onStoryPreferenceChanged: buildStoryPreferenceRefresh(deps.boss),
        manualMemoryCandidates: new ManualMemoryCandidateService(),
        cardSideEffects: {
          applyDismiss: (scopedDb, _actorUserId, cardId) =>
            cardRepository.markDismissed(scopedDb, _actorUserId, cardId).then(() => undefined),
          undoDismissCard: (scopedDb, _actorUserId, cardId) =>
            cardRepository.reactivate(scopedDb, _actorUserId, cardId).then(() => undefined)
        },
        calendarFollowThroughSideEffects: buildCalendarFollowThroughSideEffects()
      });
    }
  },
  {
    manifest: structuredStateModuleManifest,
    sqlMigrationDirectories: [structuredStateSqlMigrationDirectory],
    queueDefinitions: [],
    registerWorkers: async () => {
      registerVaultIngestRootProvider(createStructuredStateVaultIngestProvider());
      return [];
    }
  },
  {
    manifest: wellnessModuleManifest,
    sqlMigrationDirectories: [wellnessModuleSqlMigrationDirectory],
    queueDefinitions: [...WELLNESS_EXPORT_QUEUE_DEFINITIONS],
    registerRoutes: (server, deps) => {
      const preferencesRepository = new PreferencesRepository();
      registerWellnessRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        resolveActiveModules: deps.resolveActiveModules,
        resolveRequestTimeZone: (request, accessContext) =>
          resolveRequestTimeZoneForRoute(
            request,
            accessContext,
            deps.dataContext,
            preferencesRepository
          )
      });
      registerWellnessExportRoutes(server, {
        boss: deps.boss,
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext
      });
    },
    registerWorkers: (boss, deps) => registerWellnessExportWorkers(boss, deps.dataContext)
  },
  {
    manifest: weatherModuleManifest,
    sqlMigrationDirectories: [],
    queueDefinitions: [],
    registerRoutes: (server, deps) => {
      const preferencesRepository = new PreferencesRepository();
      registerWeatherRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        preferencesRepo: preferencesRepository,
        logger: createModuleLogger(server.log, "weather"),
        resolveRequestTimeZone: (request, accessContext) =>
          resolveRequestTimeZoneForRoute(
            request,
            accessContext,
            deps.dataContext,
            preferencesRepository
          ),
        fetchFn: deps.fetchFn
      });
    }
  },
  {
    // LOADER-SEAM(sports) 1: static import + registration object (manifest, sql dir, routes).
    manifest: sportsModuleManifest,
    sqlMigrationDirectories: [sportsModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: (server, deps) => {
      // LOADER-SEAM(sports) 2: DI wiring + construction of the dataset-connector-SDK runtime
      // client (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md) bound to the
      // module's manifest-declared `espn` external source, in the composition root (which
      // concrete adapter/host-pinning config applies lives here, not in the manifest itself).
      // Sports is the sole migration case this slice, so the client is wired inline rather than
      // via a generic per-module map on `BuiltInModuleRegistration`.
      const [espnSource] = sportsModuleManifest.externalSources ?? [];
      if (!espnSource) {
        throw new Error("sports module manifest is missing its `espn` externalSources entry");
      }
      const datasetClient = createDatasetClient(espnSource, createEspnDatasetAdapter(), {
        fetchFn: deps.fetchFn,
        logger: createModuleLogger(server.log, "sports")
      });
      const rendererSocket = process.env.MOSS_SPORTS_RENDERER_SOCKET;
      let browser: SportsBrowserClient | undefined;
      if (rendererSocket) {
        const browserBroker = new SportsBrowserBroker({
          fetch: (url, options) => fetchWebResourceBytes(url, options)
        });
        const browserBrokerServer = new SportsBrowserBrokerServer({
          broker: browserBroker,
          socketPath: SPORTS_BROWSER_SOCKETS.broker
        });
        browser = new SportsBrowserClient({ broker: browserBroker, socketPath: rendererSocket });
        server.addHook("onReady", async () => {
          try {
            await browserBrokerServer.start();
          } catch (error) {
            server.log.warn(
              { error: error instanceof Error ? error.message : String(error) },
              "sports browser broker unavailable; static source discovery remains enabled"
            );
          }
        });
        server.addHook("onClose", async () => browserBrokerServer.stop());
      }
      // LOADER-SEAM(sports) 3: the briefing tool (`briefing-tool.ts`) is constructed from
      // static manifest data at import time, before this wiring runs, so it adopts the client
      // via a late-bound setter (mirrors `adoptChatRpcConnection` above for the chat RPC path).
      configureSportsBriefingService(datasetClient);
      const discovery = buildSportsDiscoveryPorts(
        createModuleLogger(server.log, "sports"),
        browser
      );
      const sourcesRepository = new SportsSourcesRepository();
      const espnCoverageRepository = new SportsEspnCoverageRepository();
      // #2237 story photos are copied into the owner's own vault and served from our origin, so
      // the vault runner and the byte fetch port are built here rather than inside the module.
      const sportsPhotoStore = new SportsPhotoStore({
        vault: new VaultContextRunner(getVaultBaseDir()),
        fetchBytes: discovery.fetchBytes
      });
      const publicSourceReader = new SportsPublicSourceReader({
        dataContext: deps.dataContext,
        repository: sourcesRepository,
        fetch: discovery.fetch,
        photos: sportsPhotoStore,
        cache: new DatasetCache({ maxEntries: 500 })
      });
      const followsRepository = new SportsFollowsRepository();
      const previews = createSportsPreviewStore();
      // Story relevance feedback (#2019). Both ports are built here, in the composition root,
      // because Sports must not reach into another module's code to get them. The model access
      // is the same one Sports already uses for its other work, so the user's configured model is
      // what runs; no provider or model is named anywhere.
      const sportsStoryLogger = createModuleLogger(server.log, "sports");
      const sportsStoryRelevance = createStoryRelevancePolicy({
        ai: discovery.ai,
        repository: usefulnessFeedbackRepository,
        logger: sportsStoryLogger
      });
      const sportsStoryFeedback = {
        refFor: (canonicalLink: string) => storyFeedbackTargetRef("sports", canonicalLink),
        registerStories: async (
          scopedDb: DataContextDb,
          ownerUserId: string,
          stories: readonly RegisteredStory[]
        ) => {
          await usefulnessFeedbackRepository.upsertTargets(
            scopedDb,
            stories.map((story) => ({
              ownerUserId,
              targetKind: "sports_story" as const,
              targetRef: story.storyRef,
              surface: story.surface,
              sourceKind: "sports",
              sourceLabel: story.sourceLabel,
              // The bounded, allow-listed shape is the only thing a story row may carry. Anything
              // outside it is dropped rather than stored.
              metadata: buildStoryTargetContext({
                moduleId: "sports",
                headline: story.headline,
                sourceLabel: story.sourceLabel,
                publishedAt: story.publishedAt,
                teamRef: story.teamRef,
                competitionRef: story.competitionRef,
                hasEditorialEvidence: story.hasEditorialEvidence,
                isOpinion: story.isOpinion ?? null
              })
            }))
          );
        }
      };
      const sourceTeamResolver = new SportsService({
        datasetClient,
        dataContext: deps.dataContext,
        repository: followsRepository,
        publicSourceReader
      });
      const sourceService = new SportsSourceService({
        follows: followsRepository,
        sources: sourcesRepository,
        espnCoverage: espnCoverageRepository,
        previews,
        discovery,
        resolveTeams: async (competitionKey) =>
          (await sourceTeamResolver.getLeagueTeams(competitionKey)).teams,
        dataContext: deps.dataContext,
        reader: publicSourceReader,
        photos: sportsPhotoStore
      });
      configureSportsChatTools(datasetClient, followsRepository, sourceService);
      registerSportsRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        datasetClient,
        discovery,
        repository: followsRepository,
        sourcesRepository,
        espnCoverageRepository,
        publicSourceReader,
        previews,
        sourceService,
        photos: sportsPhotoStore,
        storyRelevance: sportsStoryRelevance,
        storyFeedback: sportsStoryFeedback
      });
    }
  },
  {
    manifest: newsModuleManifest,
    sqlMigrationDirectories: [newsModuleSqlMigrationDirectory],
    queueDefinitions: [...NEWS_QUEUE_DEFINITIONS],
    registerRoutes: (server, deps) => {
      // Same dataset-connector-SDK wiring as sports above: the composition root binds the
      // manifest-declared `newsfeeds` external source to the concrete RSS adapter so host
      // pinning and TTLs come from the manifest, not the module code.
      const [feedsSource] = newsModuleManifest.externalSources ?? [];
      if (!feedsSource) {
        throw new Error("news module manifest is missing its `newsfeeds` externalSources entry");
      }
      const datasetClient = createDatasetClient(feedsSource, createRssDatasetAdapter(), {
        fetchFn: deps.fetchFn,
        logger: createModuleLogger(server.log, "news")
      });
      // Briefing tool is constructed at import time; it adopts the client late-bound
      // (mirrors LOADER-SEAM(sports) 3).
      configureNewsBriefingService(datasetClient);
      const discovery = buildNewsDiscoveryPorts(
        createModuleLogger(server.log, "news"),
        deps.createCliStructuredAdapter
      );
      const previewOverride = buildUatNewsPreviewOverride();
      registerNewsRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        datasetClient,
        discovery,
        boss: deps.boss,
        previewOverride,
        // #2018: the overview records the stories it showed, so the feedback API can accept a
        // preference on one. Nothing else writes those rows.
        storyFeedback: buildNewsStoryFeedbackPort(
          discovery.ai,
          createModuleLogger(server.log, "news")
        ),
        // #2005: the composition root owns key resolution; News only holds the port.
        credentialCipher: createNewsCredentialCipherPort(),
        // #2008/#2006: the reviewed connection list and its bounded key check.
        publisherConnections: createRegistryNewsPublisherConnectionPort(),
        credentialRepository: new NewsCredentialRepository(),
        // #953: news receives capability BOOLEANS only — model identity and key material stay
        // behind the AI/Settings public APIs; nothing secret crosses this seam.
        availability: {
          hasJsonModel: async (scopedDb) =>
            (
              await new AiRepository().resolveModelForService(
                scopedDb,
                newsAddSourceRequirement.service,
                {
                  capability: newsAddSourceRequirement.capability,
                  tierHint: newsAddSourceRequirement.tier
                }
              )
            ).model !== null,
          hasWebSearch: async (scopedDb) => {
            const resolution = await resolveNewsWebSearch(scopedDb);
            return resolution.engine !== "none";
          },
          webSearchReason: async (scopedDb) => {
            const resolution = await resolveNewsWebSearch(scopedDb);
            return resolution.engine === "none" ? resolution.reason : null;
          }
        }
      });
    },
    registerWorkers: (boss, deps) => {
      const discovery = buildNewsDiscoveryPorts(
        deps.logger ? createModuleLogger(deps.logger, "news") : undefined
      );
      const newsLogger = deps.logger ? createModuleLogger(deps.logger, "news") : undefined;
      const connection = publisherConnection(NEWSAPI_CONNECTION_ID);
      if (!connection) throw new Error("news module is missing its reviewed NewsAPI connection");
      const credentials = new NewsCredentialRepository();
      const credentialedSource = createNewsCredentialedSourceReader({
        connection,
        credentials,
        cipher: createNewsCredentialCipherPort()
      });
      return registerNewsJobWorkers(boss, deps.dataContext, {
        ...discovery,
        credentials,
        credentialedSource,
        // #2018: compilation applies the owner's story preferences through this port.
        storyFeedback: buildNewsStoryFeedbackPort(discovery.ai, newsLogger),
        logger: {
          info: (fields) => deps.logger?.info(fields, "news compilation"),
          warn: (fields) => deps.logger?.warn(fields, "news compilation")
        },
        // #975 Slice 4: revalidation summary notification honors quiet hours and the
        // owner's per-module notification preference like every other module emitter.
        notificationsRepository: new NotificationsRepository(
          quietHoursPortImpl,
          createNotificationPreferencePort()
        ),
        revalidationLogger: {
          info: (fields) => deps.logger?.info(fields, "news revalidation")
        }
      });
    }
  },
  {
    manifest: notesModuleManifest,
    sqlMigrationDirectories: [notesModuleSqlMigrationDirectory],
    queueDefinitions: [...NOTES_QUEUE_DEFINITIONS],
    registerRoutes: (server, deps) =>
      registerNotesSyncRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext,
        preferencesRepository: new PreferencesRepository(),
        boss: deps.boss
      }),
    registerWorkers: (boss, deps) =>
      registerNotesJobWorkers(boss, deps.dataContext, {
        embeddingProviderFactory: createRuntimeEmbeddingProvider,
        preferencesRepository: new PreferencesRepository(),
        afterSync: async ({ actorUserId }) => {
          const accessContext = { actorUserId, requestId: "notes-sync:people" };
          const vaultRunner = new VaultContextRunner(getVaultBaseDir());
          const peopleNotes = new PeopleNotesService();
          await vaultRunner.withVaultContext(accessContext, (vaultCtx) =>
            deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
              if (!(await isPeopleNotesSuggestUpdatesEnabled(scopedDb))) {
                return { projected: 0, candidates: 0 };
              }
              try {
                return await peopleNotes.refreshFromFolder(scopedDb, vaultCtx, actorUserId);
              } catch (error) {
                if (error instanceof PeopleNotesFolderUnavailableError) {
                  return { discovered: 0, projected: 0, ignored: 0, candidates: 0 };
                }
                throw error;
              }
            })
          );
        }
      })
  },
  {
    manifest: scratchpadModuleManifest,
    sqlMigrationDirectories: [scratchpadModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: (server, deps) =>
      registerScratchpadRoutes(server, {
        dataContext: deps.dataContext,
        resolveAccessContext: deps.resolveAccessContext
      })
  },
  {
    manifest: proactiveMonitoringModuleManifest,
    sqlMigrationDirectories: [proactiveMonitoringSqlMigrationDirectory],
    queueDefinitions: [PROACTIVE_SCAN_SOURCE_QUEUE],
    registerRoutes: (server, deps) => {
      const allProviders = proactiveMonitorProvidersFor(getBuiltInModuleManifests());
      const registeredSources = new Set<ProactiveSource>(
        allProviders.map((p) => p.provider.source as ProactiveSource)
      );
      registerProactiveMonitoringRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss,
        registeredSources
      });
    },
    registerWorkers: async (boss, deps) => {
      const allProviders = proactiveMonitorProvidersFor(getBuiltInModuleManifests());
      const providers = new Map(
        allProviders.map((p) => [p.provider.source as ProactiveSource, p.provider])
      );
      const preferencesRepository = new PreferencesRepository();
      return registerProactiveMonitoringWorkers(boss, {
        dataContext: deps.dataContext,
        getLocalePreference: async (scopedDb) => {
          const val = await preferencesRepository.get(scopedDb, "locale");
          if (!val || typeof val !== "object" || Array.isArray(val)) return null;
          return val as { timezone?: string };
        },
        providers
      });
    }
  },
  {
    manifest: commitmentsModuleManifest,
    sqlMigrationDirectories: [commitmentsModuleSqlMigrationDirectory],
    queueDefinitions: [{ name: COMMITMENT_EXTRACTION_QUEUE, options: {} }],
    registerRoutes: (server, deps) =>
      registerCommitmentsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss
      }),
    registerWorkers: async (boss, deps) =>
      registerCommitmentExtractionWorker(boss, deps.dataContext, {
        aiRepository: new AiRepository(),
        cipher: createAiSecretCipher(),
        repository: new CommitmentsRepository(),
        providers: [chatCommitmentProvider, notesCommitmentProvider],
        logger: deps.logger ? createModuleLogger(deps.logger, "commitments") : undefined
      })
  },
  {
    manifest: peopleManifest,
    sqlMigrationDirectories: [peopleModuleSqlMigrationDirectory],
    queueDefinitions: [{ name: PERSON_INDEX_QUEUE }, { name: SYNC_PERSON_MEMORY_QUEUE }],
    registerRoutes: (server, deps) =>
      registerPeopleRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss,
        vaultRunner: new VaultContextRunner(getVaultBaseDir()),
        peopleNotesService: new PeopleNotesService({ boss: deps.boss })
      }),
    registerWorkers: async (boss, deps) => {
      const indexId = await registerPersonIndexWorker(boss, deps.dataContext, {
        providers: []
      });
      const syncId = await registerSyncPersonMemoryWorker(boss, deps.dataContext);
      registerVaultIngestRootProvider(createPeopleVaultIngestProvider());
      return [indexId, syncId];
    }
  },
  {
    // Durable workflow run state and step worker (#2013/#2014).
    manifest: workflowsModuleManifest,
    sqlMigrationDirectories: [workflowsModuleSqlMigrationDirectory],
    queueDefinitions: WORKFLOW_QUEUE_DEFINITIONS,
    registerRoutes: (server, deps) =>
      registerWorkflowsRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss
      }),
    registerWorkers: (boss, deps) =>
      registerWorkflowWorkers(boss, {
        boss,
        dataContext: deps.dataContext,
        registry: getWorkflowRegistry(),
        vaultRunner: new VaultContextRunner(getVaultBaseDir())
      })
  },
  {
    manifest: workshopModuleManifest,
    sqlMigrationDirectories: [],
    queueDefinitions: []
  }
];

/**
 * Modules with owned tables that have not yet declared a `dataLifecycle` manifest field
 * (see docs/superpowers/specs/2026-07-04-module-data-lifecycle-ports.md, Phase B). Listed
 * modules skip the mandatory-declaration check in `assertModuleRegistryConsistency` below;
 * any module that HAS a `dataLifecycle` is fully checked regardless of this list. Each
 * Phase B PR removes its module from this list; the final Phase B PR deletes it, making the
 * assertion unconditional. This list only ever shrinks — pinned exactly by a unit test.
 *
 * Declared BEFORE the module-load-time `assertModuleRegistryConsistency(BUILT_IN_MODULES)`
 * call below (rather than after, as originally drafted): that call runs synchronously at
 * import time, and a `const` referenced before its own declaration line throws a
 * temporal-dead-zone ReferenceError — this ordering is load-bearing, not stylistic.
 */
export const LIFECYCLE_MIGRATION_PENDING: readonly string[] = [
  "ai",
  "briefings",
  "calendar",
  "chat",
  "connectors",
  "email",
  "jarvis.commitments",
  "memory",
  "notes",
  "notifications",
  "people",
  "proactive-monitoring",
  "structured-state",
  "tasks",
  "usefulness-feedback",
  "weather"
];

const MAX_APP_MAP_DESCRIPTION_LENGTH = 240;

function assertAppMapDescription(owner: string, kind: string, id: string, value: string): void {
  const length = value.trim().length;
  if (length === 0 || length > MAX_APP_MAP_DESCRIPTION_LENGTH) {
    throw new Error(
      `Module "${owner}" ${kind} "${id}" description must contain 1-${MAX_APP_MAP_DESCRIPTION_LENGTH} trimmed characters`
    );
  }
}

function assertAppMapDeclarations(manifest: MossModuleManifest): void {
  for (const surface of manifest.navigation ?? []) {
    assertAppMapDescription(manifest.id, "navigation", surface.id, surface.description);
  }
  for (const surface of manifest.settings ?? []) {
    assertAppMapDescription(manifest.id, "settings", surface.id, surface.description);
  }
  for (const feature of manifest.features ?? []) {
    assertAppMapDescription(manifest.id, "feature", feature.id, feature.description);
    const remediationIds = new Set(feature.remediations?.map((item) => item.id) ?? []);
    for (const remediation of feature.remediations ?? []) {
      assertAppMapDescription(manifest.id, "remediation", remediation.id, remediation.description);
    }
    for (const error of feature.errors ?? []) {
      assertAppMapDescription(manifest.id, "error", error.code, error.description);
      if (error.class === "prerequisite") {
        if (!error.remediationRef || !remediationIds.has(error.remediationRef)) {
          throw new Error(
            `Module "${manifest.id}" prerequisite error "${error.code}" has undeclared remediationRef "${error.remediationRef ?? ""}"`
          );
        }
      } else if (error.remediationRef !== undefined) {
        throw new Error(
          `Module "${manifest.id}" non-prerequisite error "${error.code}" must not declare remediationRef`
        );
      }
    }
  }
}

// Compat gate (ADR 0009 §3): validate every built-in's compatibility.jarv1s against
// CORE_VERSION at load time, before any registration path runs. Throws if a module is
// incompatible or not defaultEnabled, naming the offender.
assertModulesCompatible(BUILT_IN_MODULES.map((module) => module.manifest));
assertModuleRegistryConsistency(BUILT_IN_MODULES);

// LOADER-SEAM(sports) 7: the web CSP img-src allowlist is derived from every built-in module's
// manifest-declared `externalSources[].imageHosts` (dataset-connector SDK), not from a single
// hardcoded source factory — so it can never diverge from what routing is actually allowed to
// fetch/render, and automatically picks up any future module that declares image hosts.
export const MODULE_IMAGE_CSP_HOSTS: readonly string[] = Array.from(
  new Set(
    BUILT_IN_MODULES.flatMap((module) =>
      (module.manifest.externalSources ?? []).flatMap((source) => source.imageHosts ?? [])
    )
  )
);

/**
 * #2012 (epic #819): the validated workflow lookup, built once at module load for the same reason
 * MODULE_IMAGE_CSP_HOSTS is -- so an invalid definition takes the process down here rather than
 * quietly going missing from the registry later. `assertModuleRegistryConsistency` above has
 * already run and would have thrown first; this rebuild is what a consumer actually reads.
 *
 * No module declares a workflow yet, so this is currently empty. That is the expected result.
 */
const BUILT_IN_WORKFLOW_REGISTRY: WorkflowRegistry = buildWorkflowRegistry(BUILT_IN_MODULES);

/** Validated workflow definitions, keyed by workflow id. Only definitions that passed appear. */
export function getWorkflowRegistry(): WorkflowRegistry {
  return BUILT_IN_WORKFLOW_REGISTRY;
}

export function assertModuleRegistryConsistency(
  registrations: readonly BuiltInModuleRegistration[] = BUILT_IN_MODULES
): void {
  const moduleIds = new Map<string, string>();
  const queueNames = new Map<string, string>(
    FOUNDATION_QUEUES.map((queue) => [queue.name, "foundation"])
  );
  const routeKeys = new Map<string, string>();
  const ownedTables = new Map<string, string>();
  const externalSourceIds = new Map<string, string>();

  // #2012 (epic #819): workflow graphs are checked here so the existing module-load-time call
  // above fails the API and the worker closed on a broken definition. No separate boot hook.
  validateModuleWorkflows(registrations);

  for (const registration of registrations) {
    assertAppMapDeclarations(registration.manifest);

    const moduleId = registration.manifest.id;

    assertUniqueRegistryKey(moduleIds, moduleId, moduleId, "module id");

    for (const queue of registration.queueDefinitions) {
      assertUniqueRegistryKey(queueNames, queue.name, moduleId, "queue name");
    }

    for (const route of registration.manifest.routes ?? []) {
      assertUniqueRegistryKey(routeKeys, `${route.method} ${route.path}`, moduleId, "route");
    }

    const moduleOwnedTables = registration.manifest.database?.ownedTables ?? [];
    for (const table of moduleOwnedTables) {
      assertUniqueRegistryKey(ownedTables, table, moduleId, "owned table");
    }

    // Dataset connector SDK (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md):
    // registration-time validation of every module's declared external data sources. Purely
    // manifest-driven (no adapter needed) so it applies uniformly regardless of whether a
    // module's composition-root wiring has migrated to a `DatasetClient` yet.
    for (const source of registration.manifest.externalSources ?? []) {
      assertUniqueRegistryKey(externalSourceIds, source.id, moduleId, "external source id");
      assertValidFetchHosts(source.id, source.fetchHosts);
      if (source.credential === "api-key") {
        throw new Error(
          `External source "${source.id}" (module "${moduleId}") declares credential "api-key", ` +
            "which is reserved but not yet supported — no secret storage exists for connector " +
            "credentials in this slice (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md)"
        );
      }
    }

    const lifecycle = registration.manifest.dataLifecycle;

    if (moduleOwnedTables.length > 0) {
      if (!lifecycle) {
        if (!LIFECYCLE_MIGRATION_PENDING.includes(moduleId)) {
          throw new Error(
            `Module "${moduleId}" has owned tables but declares no dataLifecycle, and is not on ` +
              "the LIFECYCLE_MIGRATION_PENDING allowlist (packages/module-registry/src/index.ts)"
          );
        }
      } else if (lifecycle.exportSections === undefined) {
        throw new Error(
          `Module "${moduleId}" declares dataLifecycle with owned tables but omits ` +
            'exportSections; declare "exportSections: []" explicitly if there is nothing to export'
        );
      }
    }

    if (lifecycle) {
      const declaredDeletionTables = new Set(lifecycle.deletion.tables.map((entry) => entry.table));
      const missingFromDeletion = moduleOwnedTables.filter(
        (table) => !declaredDeletionTables.has(table)
      );
      if (missingFromDeletion.length > 0) {
        throw new Error(
          `Module "${moduleId}" dataLifecycle.deletion.tables is missing owned table(s): ` +
            missingFromDeletion.join(", ")
        );
      }
    }
  }
}

function assertUniqueRegistryKey(
  seen: Map<string, string>,
  key: string,
  owner: string,
  label: string
): void {
  const existingOwner = seen.get(key);
  if (existingOwner) {
    throw new Error(
      `Duplicate ${label} "${key}" in module registry: ${existingOwner} and ${owner}`
    );
  }
  seen.set(key, owner);
}

export function getBuiltInModuleRegistrations(): readonly BuiltInModuleRegistration[] {
  return BUILT_IN_MODULES;
}

function markBuiltInManifestTrusted(manifest: MossModuleManifest): MossModuleManifest {
  if (!manifest.assistantTools) return manifest;
  return {
    ...manifest,
    assistantTools: manifest.assistantTools.map((tool) => ({ ...tool, isExternal: false }))
  };
}

export function getBuiltInModuleManifests(): readonly MossModuleManifest[] {
  return BUILT_IN_MODULES.map((module) => markBuiltInManifestTrusted(module.manifest));
}

/** Default predicate applied when a `ModuleDeletionTable` omits `countPredicate`. */
export const DEFAULT_MODULE_DELETION_COUNT_PREDICATE = "owner_user_id = $1::uuid";

export interface ResolvedModuleDeletionTable {
  readonly table: string;
  readonly countPredicate: string;
}

/**
 * Flattens every built-in module's `dataLifecycle.deletion.tables` into the resolved
 * (default-applied) list `scripts/delete-user-data.ts` sweeps for its before/after counts.
 * Used both by the settings composition root below (API path) and by the deletion script's
 * dynamic `import("@moss/module-registry")` inside its `import.meta.url`-guarded `main()` —
 * never call this from a statically-imported context in `@moss/settings` (that would
 * recreate the package cycle the dynamic import exists to avoid).
 */
export function getModuleDeletionTables(
  manifests: readonly MossModuleManifest[] = getBuiltInModuleManifests()
): readonly ResolvedModuleDeletionTable[] {
  return manifests.flatMap((manifest) =>
    (manifest.dataLifecycle?.deletion.tables ?? []).map((entry) => ({
      table: entry.table,
      countPredicate: entry.countPredicate ?? DEFAULT_MODULE_DELETION_COUNT_PREDICATE
    }))
  );
}

/** Module load time snapshot, mirrors the MODULE_IMAGE_CSP_HOSTS precedent above. */
export const MODULE_DELETION_TABLES: readonly ResolvedModuleDeletionTable[] =
  getModuleDeletionTables();

/**
 * External-module counterpart to getModuleDeletionTables (#914, spec D6 "lifecycle derived from
 * structure, no module code"). Built-in modules declare dataLifecycle.deletion.tables explicitly;
 * external modules never carry module code in their manifest, so the platform derives deletion
 * coverage structurally from `database.ownedTables` instead — every owned table is automatically
 * swept with the default owner_user_id predicate, with no per-module deletion declaration to
 * maintain. Manifests are passed in explicitly (unlike MODULE_DELETION_TABLES' eager snapshot)
 * because external modules install post-deploy — the caller (scripts/delete-user-data-cli.ts)
 * reads installed manifests at run time, not from a static import-time snapshot.
 */
export function getExternalModuleDeletionTables(
  installedManifests: readonly MossModuleManifest[]
): readonly ResolvedModuleDeletionTable[] {
  return installedManifests.flatMap((manifest) =>
    (manifest.database?.ownedTables ?? []).map((table) => ({
      table,
      countPredicate: DEFAULT_MODULE_DELETION_COUNT_PREDICATE
    }))
  );
}

/**
 * Build the focus-signal provider list from a manifest set. Pass the per-actor ACTIVE
 * manifests (resolveActiveModules(actorUserId)) so a per-user-disabled module is excluded.
 * Generic: any module that declares `focusSignal` participates; no module is special-cased.
 */
export function focusSignalProvidersFor(
  manifests: readonly MossModuleManifest[]
): RegisteredFocusSignal[] {
  return manifests.flatMap((manifest) =>
    manifest.focusSignal ? [{ moduleId: manifest.id, provider: manifest.focusSignal }] : []
  );
}

/** Build diagnostic providers from the actor's active manifests, so disabled modules contribute nothing. */
export function moduleDiagnosticProvidersFor(
  manifests: readonly MossModuleManifest[]
): RegisteredModuleDiagnosticProvider[] {
  return manifests.flatMap((manifest) =>
    manifest.diagnosticsProvider
      ? [{ moduleId: manifest.id, provider: manifest.diagnosticsProvider }]
      : []
  );
}

type TimeZonePreferences = {
  get(scopedDb: DataContextDb, key: string): Promise<unknown>;
};

type TimeZoneRunner = {
  withDataContext<T>(
    accessContext: AccessContext,
    work: (scopedDb: DataContextDb) => Promise<T> | T
  ): Promise<T>;
};

export async function resolveRequestTimeZoneForRoute(
  request: { readonly timeZone?: string },
  accessContext: AccessContext,
  dataContext: TimeZoneRunner,
  preferences: TimeZonePreferences
): Promise<string> {
  if (request.timeZone) return resolveTimeZone(request.timeZone, undefined);
  const stored = await dataContext.withDataContext(accessContext, (scopedDb) =>
    preferences.get(scopedDb, "locale")
  );
  return resolveTimeZone(undefined, extractStoredTimeZone(stored));
}

function extractStoredTimeZone(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const timeZone = (value as Record<string, unknown>)["timezone"];
  return typeof timeZone === "string" ? timeZone : undefined;
}

/**
 * Build the proactive-monitor provider list from a manifest set. Any module that declares
 * `proactiveMonitor` participates. Pass per-actor active manifests to exclude disabled modules.
 */
export function proactiveMonitorProvidersFor(
  manifests: readonly MossModuleManifest[]
): RegisteredProactiveMonitorProvider[] {
  return manifests.flatMap((manifest) =>
    manifest.proactiveMonitor
      ? [{ moduleId: manifest.id, provider: manifest.proactiveMonitor }]
      : []
  );
}

export function getBuiltInSqlMigrationDirectories(): readonly string[] {
  return BUILT_IN_MODULES.flatMap((module) => module.sqlMigrationDirectories);
}

export function getAllQueueDefinitions(): readonly QueueDefinition[] {
  return [...FOUNDATION_QUEUES, ...BUILT_IN_MODULES.flatMap((module) => module.queueDefinitions)];
}

export function registerBuiltInApiRoutes(
  server: FastifyInstance,
  dependencies: BuiltInRouteDependencies
): void {
  const env = process.env;
  const getChatMultiplexerStatus = makeChatMultiplexerStatusProbe(env);

  // #342 boot-time fork (§3.5): when JARVIS_CLI_RUNNER_SOCKET is set the api drives the cli-runner
  // sidecar over ONE shared socket (§3.4 — one connection per api process). That ONE connection is
  // owned by the chat runtime (it must be constructed WITH the §5.3 onReconcile hook, which needs the
  // manager — see integrationNotes), and adopted here for the onboarding probes via a late-bound ref.
  // The chat runtime surfaces it through `dependencies.chatRpcConnection` (the composition seam); the
  // probes close over this ref, which is populated either synchronously (already provided) or when the
  // chat routes register their runtime. Until populated the probes fall back to the in-process path.
  const socketConfigured = Boolean(env.JARVIS_CLI_RUNNER_SOCKET);
  let rpcConnection: RpcConnection | undefined = dependencies.chatRpcConnection;
  const getRpcConnection = (): RpcConnection | undefined => rpcConnection;

  // #1081 H2: the chat session manager's dropSessionsForProvider is built INSIDE
  // registerChatRoutes (below, via the chat module's registerRoutes call), strictly AFTER
  // this function assembles the onboarding-install seam — so it is adopted via the SAME
  // late-bound ref pattern as rpcConnection/getRpcConnection above. Absent (undefined) until
  // the chat module registers (always happens on this same synchronous pass, before any
  // request is served).
  let dropSessionsForProvider: ((provider: ProviderKind) => Promise<void>) | undefined;
  const getDropSessionsForProvider = (): ((provider: ProviderKind) => Promise<void>) | undefined =>
    dropSessionsForProvider;

  // #1256: same per-server late-bound-ref pattern as rpcConnection/dropSessionsForProvider above.
  // The chat module's live AssistantToolGateway is adopted below (via adoptChatGateway, built
  // inside registerChatRoutes strictly after this function assembles the ai module's dependencies),
  // so the ai module's resolve route dereferences THIS server's binding at call time through
  // getResolveActionRequestFn — never a module-level binding shared across every server that
  // happens to share this Node process (several integration test files construct 2-9 servers each).
  let resolveActionRequestFn: AssistantToolGateway["resolveActionRequest"] | undefined;
  const getResolveActionRequestFn = (): AssistantToolGateway["resolveActionRequest"] | undefined =>
    resolveActionRequestFn;
  // #1554 task #6: the persistent-runtime pool's onPersistentReap needs
  // SessionTokenRegistry.revokeBySessionId, which is likewise built INSIDE registerChatRoutes's
  // `wiring` closure — same late-bound "adopt" seam as dropSessionsForProvider above. Populated
  // synchronously during the BUILT_IN_MODULES registerRoutes pass below, strictly before the
  // onReady hook further down that calls resolveChatEngineFactory (the only reader).
  let revokeMcpTokenBySessionId: ((chatSessionId: string) => void) | undefined;

  // Onboarding probes: built synchronously (no boot-time probing) and forwarded to the settings
  // module. Each function probes lazily, per request, bounded by a short timeout. On the RPC path they
  // route through the cli-runner over the socket (§4.8) instead of spawning CLIs in-process; the
  // late-bound `getRpcConnection` lets a connection that is wired AFTER probe construction still be
  // used (the probes only dereference it at call time, which is strictly post-boot).
  const cliPresent = makeCliPresentProbe(getRpcConnection);

  // The factory is resolved asynchronously in onReady (a settings read) on the in-process path, but
  // routes register synchronously. Bridge with a late-bound wrapper: it is only ever invoked when a
  // chat session launches, which is strictly after onReady. Tests/embedders that pass an explicit
  // chatEngineFactory bypass resolution entirely.
  let resolvedChatFactory: ChatEngineFactory | null = null;
  const chatEngineFactory: ChatEngineFactory =
    dependencies.chatEngineFactory ??
    ((provider, key, engineOptions) => {
      if (!resolvedChatFactory) {
        throw new CliChatUnavailableError("chat engine factory is not resolved yet");
      }
      // #1242 / epic #1238: this late-bound bridge MUST forward `engineOptions` (carries
      // `executionMode`) to the resolved factory. Dropping it made the runtime.ts:97 print-engine
      // gate see `executionMode === undefined`, so every anthropic turn fell through to the
      // interactive CliChatEngineImpl (mux → herdr pane) even when the provider was configured
      // `non_interactive` — the exact "one-shot still opens a pane" P-02 UAT failure.
      return resolvedChatFactory(provider, key, engineOptions);
    });

  const structuredChatEngineFactory = createStructuredChatEngineFactory({
    socketConfigured,
    getRpcConnection,
    fallback: chatEngineFactory
  });

  const onboardingProbes = {
    cliPresent,
    testProviderConnection: makeProviderConnectionCheckProbe({
      engineFactory: chatEngineFactory,
      cliPresent,
      skipInstallCheck: dependencies.chatEngineFactory !== undefined,
      env,
      connection: getRpcConnection
    }),
    connectorAccountExists: async (scopedDb: DataContextDb) =>
      (await new ConnectorsRepository().listAccounts(scopedDb)).length > 0
  };

  // #342 §A.5: the admin-gated install seam. Built ONLY on the socket path (no in-process install
  // path exists — the CLIs live in the cli-runner container). The one RPC connection is resolved
  // lazily (`getRpcConnection`) since the chat runtime publishes it after routes register. On the
  // host-dev / in-process path this is undefined ⇒ the install route fails closed (500) and the
  // status route serves the Phase-1 presence-only surface. The admin-gated route is then the SOLE
  // install trigger (§A.7.8). #347 stays BLOCKING — multi-user concurrency is not enabled here.
  const onboardingInstall: OnboardingInstallDependencies | undefined = buildOnboardingInstall({
    enabled: socketConfigured,
    getConnection: getRpcConnection,
    repository: new SettingsRepository(),
    logger: { warn: (obj, msg) => server.log.warn(obj, msg) },
    // #1081 H2: lazy-dereferencing wrapper over the late-bound chat session manager method —
    // `dropSessionsForProvider` (this closure var above) is still undefined at THIS line (the
    // chat module registers routes further below), so every call must re-read it at call time,
    // never capture it now. OnboardingProviderKind and ProviderKind are the identical literal
    // union ("anthropic" | "openai-compatible" | "google"); no runtime mapping needed.
    dropSessionsForProvider: async (provider) => {
      const fn = getDropSessionsForProvider();
      if (fn) await fn(provider as ProviderKind);
    }
  });

  // #342 §L.5: the admin-gated login seam, built ONLY on the socket path (the login CLIs live in the
  // cli-runner container; no in-process login path). On host-dev / in-process this is undefined ⇒ the
  // login routes fail closed (500). The admin-gated routes are then the SOLE login triggers; #347 stays
  // BLOCKING — login is single-active-user (the §L.6.1 unified exclusivity gate is NOT bypassed).
  // #2208: CLI providers have no HTTP `/models`; discovery asks the cli-runner over the SAME lazy
  // socket connection the login seam uses, and the runner asks the vendor with the stored login
  // (ids only cross the socket). One service instance serves login-ready AND the admin routes so
  // the 1 h cache is shared. Off the socket path the lister is undefined ⇒ `reason: "unavailable"`.
  const aiModelDiscovery = new ModelDiscoveryService({
    cliModelLister: buildCliModelLister({
      enabled: socketConfigured,
      getConnection: getRpcConnection
    })
  });

  const onboardingLogin: OnboardingLoginDependencies | undefined = buildOnboardingLogin({
    enabled: socketConfigured,
    getConnection: getRpcConnection,
    repository: new SettingsRepository(),
    // #367: on login `ready`, auto-register a default chat model so chat works with zero manual
    // entry. Best-effort — a failure is logged here and never fails the login.
    autoRegister: new AiAutoRegisterService({
      repository: new AiRepository(),
      cipher: createAiSecretCipher(),
      // #982/#869 D2: login-ready uses same discovery service semantics as admin connect paths.
      modelDiscovery: aiModelDiscovery
    }),
    logger: { warn: (obj, msg) => server.log.warn(obj, msg) }
  });

  const appMapService = createAppMapReadService({
    artifact: loadAppMap(APP_MAP_ARTIFACT_PATH),
    resolveActiveModules: dependencies.resolveActiveModules,
    resolveFeatureFlagState: (featureFlagId) =>
      dependencies
        .listModuleManifests()
        .some((manifest) =>
          (manifest.featureFlags ?? []).some(
            (flag) => flag.id === featureFlagId && flag.defaultEnabled === true
          )
        ),
    getUser: (scopedDb, userId) => new SettingsRepository().getUserById(scopedDb, userId),
    logGap: (fields) => server.log.info(fields, "app-map coverage gap")
  });

  const platformDiagnostics = createPlatformDiagnosticsService({
    appMap: appMapService,
    sourceInspector: createSourceInspector(),
    collectHostDiagnostics: dependencies.hostDiagnostics
      ? (scopedDb) =>
          collectHostDiagnostics(
            {
              repository: new SettingsRepository(),
              hostDiagnostics: dependencies.hostDiagnostics!,
              getChatMultiplexerStatus
            },
            scopedDb
          )
      : undefined,
    repository: new AiRepository(),
    moduleProviders: async (actorUserId) =>
      moduleDiagnosticProvidersFor(await dependencies.resolveActiveModules(actorUserId)),
    runInContext: (work, context) =>
      dependencies.dataContext.withDataContext(
        { actorUserId: context.actorUserId, requestId: context.requestId },
        work
      ),
    isInstanceAdmin: async (scopedDb, actorUserId) => {
      const user = await new SettingsRepository().getUserById(scopedDb, actorUserId);
      return user?.is_instance_admin === true;
    },
    assertDiagnosticsSafe,
    onProviderError: (moduleId, errorName) =>
      server.log.warn({ moduleId, errorName }, "module diagnostics provider was dropped")
  });

  const deps: BuiltInRouteDependencies = {
    ...dependencies,
    appMapService,
    platformDiagnostics,
    chatEngineFactory,
    createCliStructuredAdapter: createCliStructuredAdapterFactory(structuredChatEngineFactory),
    // #342 (§3.5 boot-time fork): on the socket path hand the chat runtime an `engineSelection` so it
    // selects the RPC client itself (fail-fast on a missing §6.6 secret), wires the §5.3 reconciliation
    // hook, and starts the §5.5 idle reaper. The {method,id,sessionKey,bytes}-only debug logger (§6.4)
    // is intentionally omitted (no frame-body logging). Tests that inject an explicit chatEngineFactory
    // bypass this entirely (no socket selection). Undefined on the in-process / host-dev path.
    // #1554: the RPC branch also carries a live read of the persistent-runtime settings, since the
    // cli-runner has no DB access — it learns `chat.persistent_runtime.*` only from launch params.
    chatEngineSelection:
      socketConfigured && !dependencies.chatEngineFactory
        ? {
            env,
            readPersistentRuntimeConfig: createPersistentRuntimeConfigLiveReader(
              dependencies.rootDb,
              (msg) => server.log.info(msg)
            )
          }
        : undefined,
    passiveMemoryRecall: {
      async recall(scopedDb, ownerUserId, query, options) {
        const provider = await createRuntimeEmbeddingProvider(scopedDb);
        return new GraphMemoryRecallService(provider).recall(scopedDb, ownerUserId, query, options);
      }
    },
    notesRecall: createNotesRecallPort(),
    getChatMultiplexerStatus,
    onboardingProbes,
    onboardingInstall,
    onboardingLogin,
    aiModelDiscovery,
    // Surface a setter so the chat runtime (constructed inside registerChatRoutes) can publish the ONE
    // RPC connection it owns back to the probes + the boot lifecycle below. On the RPC path the runtime
    // wires reconcile + the idle reaper onto this connection; here we only need the handle to route
    // probes through it and to ensureConnected()/close() it at the composition-root boundary.
    adoptChatRpcConnection: (connection: RpcConnection) => {
      rpcConnection = connection;
    },
    // #1081 H2: mirrors adoptChatRpcConnection immediately above — publishes the chat session
    // manager's dropSessionsForProvider so the onboarding-install seam (built earlier in this
    // function, over getDropSessionsForProvider) can reach it once it exists.
    adoptDropSessionsForProvider: (fn: (provider: ProviderKind) => Promise<void>) => {
      dropSessionsForProvider = fn;
    },
    // #1256 — mirrors adoptChatRpcConnection above — publishes the chat module's live
    // AssistantToolGateway into THIS server's per-server binding, which the ai module's
    // resolveActionRequest closure reads back out through getResolveActionRequestFn below.
    adoptChatGateway: (gateway: AssistantToolGateway) => {
      resolveActionRequestFn = gateway.resolveActionRequest.bind(gateway);
    },
    getResolveActionRequestFn,
    // #1554 task #6: mirrors adoptDropSessionsForProvider immediately above — publishes the chat
    // wiring closure's SessionTokenRegistry.revokeBySessionId into this per-server binding, which
    // the onReady hook below reads through onPersistentReap when it resolves the real engine
    // factory.
    adoptMcpTokenRevoke: (fn: (chatSessionId: string) => void) => {
      revokeMcpTokenBySessionId = fn;
    },
    resolveEveningInterviewSeed: async (actorUserId: string, briefingRunId?: string) => {
      const repository = new BriefingsRepository();
      const run = await dependencies.dataContext.withDataContext(
        { actorUserId, requestId: "chat:evening-interview-seed" },
        (scopedDb) => repository.getOwnedEveningRunForInterview(scopedDb, briefingRunId)
      );
      return buildEveningInterviewSeed(run?.summary_text ?? null);
    }
  };

  for (const module of BUILT_IN_MODULES) {
    module.registerRoutes?.(server, deps);
  }

  // In-process (host-dev) path: resolve the tmux/herdr factory in onReady (a settings read). The RPC
  // path skips this — its factory is selected by the chat runtime (RPC client) via engineSelection.
  if (!dependencies.chatEngineFactory && !socketConfigured) {
    server.addHook("onReady", async () => {
      resolvedChatFactory = await resolveChatEngineFactory({
        appDb: dependencies.rootDb,
        env,
        log: (msg) => server.log.info(msg),
        // #1554 task #6: threads the wiring closure's SessionTokenRegistry.revokeBySessionId
        // (adopted above via adoptMcpTokenRevoke, populated synchronously during the
        // BUILT_IN_MODULES pass above — strictly before this onReady hook fires) into the
        // persistent-runtime pool's onPersistentReap, closing task #5's documented gap.
        onPersistentReap: (sessionKey) => {
          revokeMcpTokenBySessionId?.(sessionKey);
        }
      });
    });
  }

  // RPC path: connect on boot so the §5.3 reconciliation runs before the first user turn (§3.5), and
  // tear the socket down on server close. The chat runtime owns the reconcile hook + the idle reaper
  // (it calls runtime.shutdown() / stops the reaper); this composition root manages only the
  // connect-on-boot + close-on-shutdown lifecycle the seam is responsible for.
  if (socketConfigured) {
    server.addHook("onReady", async () => {
      const connection = getRpcConnection();
      if (!connection) return;
      // Best-effort: a failed initial connect backs off internally and the first turn retries; never
      // block readiness on the optional cli-runner being up yet (the "disabled, not crashed" contract).
      void connection.ensureConnected().catch((err) => {
        server.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "cli-runner socket not yet reachable at boot; will connect on first use"
        );
      });
    });
    server.addHook("onClose", async () => {
      getRpcConnection()?.close();
    });
  }
}

export async function registerBuiltInModuleWorkers(
  boss: PgBoss,
  dependencies: BuiltInWorkerDependencies
): Promise<string[]> {
  const workerIds = await Promise.all(
    BUILT_IN_MODULES.map(
      (module) => module.registerWorkers?.(boss, dependencies) ?? Promise.resolve([])
    )
  );

  return workerIds.flat();
}
