import { sql } from "kysely";
import type { PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";
import {
  selfHealGrantedAtInstallTier,
  type AiRepository,
  type ConfirmationRegistry,
  type SessionTokenRegistry,
  type ActiveModulesResolver,
  type AssistantToolGatewayDependencies,
  type PlatformDiagnosticsService,
  type SessionNotifier
} from "@moss/ai";
import { CalendarRepository, sendCalendarCacheEvictJob } from "@moss/calendar";
import { EmailRepository } from "@moss/email";
import { PreferencesRepository } from "@moss/structured-state";
import type {
  ConnectorSecretCipher,
  ConnectorsRepository,
  FeatureGrantService,
  GoogleApiClient,
  GoogleConnectionService,
  SourceContextService
} from "@moss/connectors";
import { sendJob } from "@moss/jobs";
import { NOTES_SYNC_QUEUE, type NotesSyncJobPayload, type NotesSyncToolService } from "@moss/notes";
import { TasksCompatibilityHelper } from "@moss/tasks";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  SettingsRepository,
  setNotificationPreferenceEnabled,
  type AppMapReadService,
  type NotificationPreferenceWriteService
} from "@moss/settings";

import { resolveEffectiveTimezone } from "./locale-utils.js";
import { ChatRepository } from "./repository.js";
import { ChatUserMemorySettingsRepository } from "./memory-settings-repository.js";
import { buildCalendarWriteService } from "./calendar-write-impl.js";
import { buildEmailWriteService } from "./email-write-impl.js";
import { buildModuleBuildStartService } from "./module-build-start-impl.js";
import { NATIVE_CONFIRM_TIMEOUT_MS } from "./live/claude-permission-hook.js";
import type { CurrentViewReadService } from "./live/current-view.js";
import type { ChatAttachmentsService } from "./attachments-service.js";
import { createNotesReadToolTrustBoundary } from "./live/notes-tool-trust.js";

const YOLO_INSTANCE_SETTING_KEY = "yolo.instance_enabled";
const YOLO_ALLOWED_PREF_KEY = "yolo.allowed";
const YOLO_ENABLED_PREF_KEY = "yolo.enabled";

/**
 * Builds the gateway toolServices map from optional collaborators. Missing service collaborators
 * simply omit that service, so the gateway fail-closed filter hides unsatisfiable tools.
 */
export function buildChatToolServices(deps: {
  googleConnectionService?: GoogleConnectionService;
  googleApiClient?: GoogleApiClient;
  connectorsRepository?: ConnectorsRepository;
  cipher?: ConnectorSecretCipher;
  boss?: PgBoss;
  featureGrantService?: FeatureGrantService;
  listModuleManifests?: () => readonly MossModuleManifest[];
}): Record<string, unknown> {
  const services: Record<string, unknown> = {};
  if (deps.googleConnectionService && deps.googleApiClient && deps.connectorsRepository) {
    services.calendarWrite = buildCalendarWriteService({
      googleService: deps.googleConnectionService,
      googleApiClient: deps.googleApiClient,
      connectorsRepository: deps.connectorsRepository,
      calendarRepository: new CalendarRepository(),
      enqueueCacheEvict: deps.boss
        ? (eventId, actorUserId) =>
            sendCalendarCacheEvictJob(deps.boss!, { targetItemId: eventId, actorUserId })
        : undefined
    });
    services.emailWrite = buildEmailWriteService({
      emailRepository: new EmailRepository(),
      connectorsRepository: deps.connectorsRepository,
      googleService: deps.googleConnectionService,
      googleApiClient: deps.googleApiClient,
      cipher: deps.cipher!,
      preferencesRepository: new PreferencesRepository()
    });
  }
  if (deps.boss) {
    const boss = deps.boss;
    services.notesSync = {
      enqueue: (actorUserId, sourcePath) =>
        sendJob(boss, NOTES_SYNC_QUEUE, { actorUserId, sourcePath } satisfies NotesSyncJobPayload, {
          singletonKey: `notes-sync:${actorUserId}`
        })
    } satisfies NotesSyncToolService;
  }
  if (deps.featureGrantService) {
    services.featureGrants = deps.featureGrantService;
  }
  if (deps.listModuleManifests) {
    const listModuleManifests = deps.listModuleManifests;
    services.notificationPreferenceWrite = {
      setEnabled: (scopedDb, actorUserId, moduleId, enabled, clearUnread) =>
        setNotificationPreferenceEnabled(
          scopedDb,
          {
            listModuleManifests,
            preferencesRepository: new PreferencesRepository(),
            repository: new SettingsRepository()
          },
          actorUserId,
          moduleId,
          enabled,
          clearUnread
        )
    } satisfies NotificationPreferenceWriteService;
  }
  return services;
}

/**
 * Assembles the AssistantToolGatewayDependencies registerChatRoutes uses, INCLUDING toolServices from
 * buildChatToolServices. Exported so a test can assert the real construction path carries toolServices
 * (i.e. that registerChatRoutes does not forget to pass it) — closing the "factory exists but isn't
 * wired" gap. registerChatRoutes calls THIS, then `new AssistantToolGateway(deps)`.
 */
export function buildChatGatewayDependencies(args: {
  resolveActiveModules: ActiveModulesResolver;
  repository: AiRepository;
  runner: DataContextRunner;
  tokens: SessionTokenRegistry;
  confirmations: ConfirmationRegistry;
  notifier: SessionNotifier;
  agencyPreferences?: PreferencesPort;
  localePreferences?: PreferencesPort;
  appMapService?: AppMapReadService;
  platformDiagnostics?: PlatformDiagnosticsService;
  collaborators: {
    googleConnectionService?: GoogleConnectionService;
    googleApiClient?: GoogleApiClient;
    connectorsRepository?: ConnectorsRepository;
    boss?: PgBoss;
    featureGrantService?: FeatureGrantService;
    sourceContextService?: SourceContextService;
    currentViewService?: CurrentViewReadService;
    /** #1133 — read-only vault-backed attachment reads for chat.readAttachment. */
    attachmentsService?: ChatAttachmentsService;
    listModuleManifests?: () => readonly MossModuleManifest[];
  };
}): AssistantToolGatewayDependencies {
  return {
    resolveActiveModules: args.resolveActiveModules,
    repository: args.repository,
    runner: args.runner,
    tokens: args.tokens,
    confirmations: args.confirmations,
    notifier: args.notifier,
    // #1158: MUST stay below the permission hook's internal deadline — see the deadline
    // ordering comment in live/claude-permission-hook.ts (unit-tested invariant).
    confirmTimeoutMs: NATIVE_CONFIRM_TIMEOUT_MS,
    agencyPrefs: buildAgencyPrefs({
      runner: args.runner,
      preferences: args.agencyPreferences
    }),
    actionPolicy: buildActionPolicy({
      runner: args.runner,
      repository: args.repository,
      preferences: args.agencyPreferences,
      resolveActiveModules: args.resolveActiveModules
    }),
    yoloMode: (ctx) =>
      args.runner.withDataContext(
        { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
        resolveYoloMode
      ),
    toolServices: {
      ...buildChatToolServices(args.collaborators),
      // #1888 — asking Moss for a module in chat. Built here rather than in
      // buildChatToolServices because it needs the ai repository as well as the queue, and it
      // reuses this file's resolveYoloMode so a module build follows exactly the same
      // auto-approve rule as every other write. No queue means no service, which means the
      // gateway hides workshop.buildModule entirely (fail closed).
      ...(args.collaborators.boss
        ? {
            moduleBuildStart: buildModuleBuildStartService({
              boss: args.collaborators.boss,
              aiRepository: args.repository,
              isYoloActive: resolveYoloMode
            })
          }
        : {})
    },
    readToolTrustBoundary: createNotesReadToolTrustBoundary({
      threads: new ChatRepository(),
      memorySettings: new ChatUserMemorySettingsRepository()
    }),
    readToolServices:
      args.collaborators.featureGrantService ||
      args.collaborators.sourceContextService ||
      args.collaborators.currentViewService ||
      args.collaborators.attachmentsService ||
      args.appMapService ||
      args.platformDiagnostics
        ? {
            ...(args.collaborators.featureGrantService
              ? { featureGrants: args.collaborators.featureGrantService }
              : {}),
            ...(args.collaborators.sourceContextService
              ? { sourceContext: args.collaborators.sourceContextService }
              : {}),
            ...(args.collaborators.currentViewService
              ? { currentView: args.collaborators.currentViewService }
              : {}),
            // #1133 — readContent only; belongs in the read registry so the write→confirm
            // floor stays structurally intact (read tools never see toolServices).
            ...(args.collaborators.attachmentsService
              ? { chatAttachments: args.collaborators.attachmentsService }
              : {}),
            ...(args.appMapService ? { appMap: args.appMapService } : {}),
            ...(args.platformDiagnostics ? { platformDiagnostics: args.platformDiagnostics } : {})
          }
        : undefined,
    resolveLocalTimezone: args.localePreferences
      ? (actorUserId) =>
          args.runner.withDataContext(
            { actorUserId, requestId: "gateway:resolve-locale-tz" },
            async (scopedDb) => {
              const raw = await args.localePreferences!.get(scopedDb, "locale");
              // #2157: match what Settings shows — never leave the tool context blank (→ UTC)
              // just because the user has not saved a locale yet.
              return resolveEffectiveTimezone(raw);
            }
          )
      : undefined
  };
}

export async function resolveYoloMode(scopedDb: DataContextDb): Promise<boolean> {
  const master = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", YOLO_INSTANCE_SETTING_KEY)
    .executeTakeFirst();
  if ((master?.value as { enabled?: boolean } | undefined)?.enabled !== true) return false;

  const prefs = await scopedDb.db
    .selectFrom("app.preferences")
    .select(["key", "value_json"])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("key", "in", [YOLO_ALLOWED_PREF_KEY, YOLO_ENABLED_PREF_KEY])
    .execute();
  const values = new Map(prefs.map((row) => [row.key, (row.value_json as unknown) === true]));
  return values.get(YOLO_ALLOWED_PREF_KEY) === true && values.get(YOLO_ENABLED_PREF_KEY) === true;
}

function buildActionPolicy(args: {
  runner: DataContextRunner;
  repository: AiRepository;
  preferences?: PreferencesPort;
  resolveActiveModules: ActiveModulesResolver;
}): AssistantToolGatewayDependencies["actionPolicy"] {
  return (ctx) => ({
    getFamilyTier: async (moduleId: string, familyId: string) => {
      return args.runner.withDataContext(
        { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
        async (scopedDb) => {
          if (moduleId === "tasks" && familyId === "task_changes") {
            // #1311 finding #2: task_changes must resolve ONLY through the legacy-aware compat
            // helper, never fall through to the generic granted_at_install self-heal below — that
            // path only checks the canonical action_policies table and is blind to a legacy
            // `tasks.agency_auto_execute=false` revocation stored in app.preferences. Structural
            // guard: even if `args.preferences` is ever absent, fail closed (null → manifest's
            // ask_each_time default) rather than let the generic heal grant trusted_auto.
            if (!args.preferences) return null;
            const compat = new TasksCompatibilityHelper(args.preferences);
            return compat.getResolvedTaskChangesPolicy(scopedDb);
          }
          const policies = await args.repository.listActionPolicies(scopedDb);
          const policy = policies.find(
            (p) => p.moduleId === moduleId && p.actionFamilyId === familyId
          );
          if (policy) return policy.tier;

          const activeModules = await args.resolveActiveModules(ctx.actorUserId);
          const manifest = activeModules.find((m) => m.id === moduleId);
          if (!manifest) return null;
          return selfHealGrantedAtInstallTier(scopedDb, args.repository, manifest, familyId);
        }
      );
    },
    getFamilyManifest: async (moduleId: string, familyId: string) => {
      const activeModules = await args.resolveActiveModules(ctx.actorUserId);
      const manifest = activeModules.find((m) => m.id === moduleId);
      if (!manifest || !manifest.assistantActionFamilies) return null;
      return manifest.assistantActionFamilies.find((f) => f.id === familyId) ?? null;
    }
  });
}

function buildAgencyPrefs(args: {
  runner: DataContextRunner;
  preferences?: PreferencesPort;
}): AssistantToolGatewayDependencies["agencyPrefs"] {
  if (!args.preferences) return undefined;
  return (ctx) => ({
    get: (key: string) =>
      args.runner.withDataContext(
        { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
        (scopedDb) => args.preferences!.get(scopedDb, key)
      ),
    upsert: (key: string, value: unknown) =>
      args.runner.withDataContext(
        { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
        (scopedDb) => args.preferences!.upsert(scopedDb, key, value)
      )
  });
}
