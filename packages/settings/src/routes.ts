import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { AccessContext, DataContextDb, DataContextRunner, MossDatabase, User } from "@moss/db";
import {
  adminDeleteUserRouteSchema,
  adminRejectUserRouteSchema,
  adminRevokeSessionsRouteSchema,
  adminUserActionRouteSchema,
  bootstrapStatusRouteSchema,
  getChatMultiplexerSettingsRouteSchema,
  getRegistrationSettingsRouteSchema,
  listAdminAuditEventsRouteSchema,
  listAuthProviderStatusesRouteSchema,
  listInstanceSettingsRouteSchema,
  listUserDirectoryRouteSchema,
  listUsersRouteSchema,
  meRouteSchema,
  patchMeProfileRouteSchema,
  putChatMultiplexerSettingsRouteSchema,
  putRegistrationSettingsRouteSchema,
  upsertInstanceSettingRouteSchema,
  type AuthProviderStatusDto,
  type ChatMultiplexerAvailability,
  type ChatMultiplexerChoice,
  type MultiplexerKind,
  type MultiplexerSource,
  type UpsertInstanceSettingRequest
} from "@moss/shared";
import type { MossModuleManifest } from "@moss/module-sdk";
import { HttpError } from "@moss/module-sdk";

import type { PgBoss } from "@moss/jobs";

import { deleteUserData, LastActiveAdminError } from "../../../scripts/delete-user-data.js";
import { BootstrapHelper } from "./bootstrap.js";
import { registerDataExportRoutes } from "./data-export-routes.js";
import { registerDataExportAsyncRoutes } from "./data-export-async-routes.js";
import type { HostDiagnosticsProvider } from "./host-diagnostics.js";
import { registerHostDiagnosticsRoutes } from "./host-diagnostics-routes.js";
import type { HerdrInstallDependencies } from "./host-install-routes.js";
import { registerHerdrInstallRoutes } from "./host-install-routes.js";
import { registerHostRestartRoutes, type HostRestartDependencies } from "./host-restart-routes.js";
import { registerLocaleRoutes } from "./locale-routes.js";
import { registerQuietHoursRoutes } from "./quiet-hours-routes.js";
import { registerWeatherLocationRoutes } from "./weather-location-routes.js";
import { registerWeatherLocationSearchRoutes } from "./weather-location-search-routes.js";
import { registerWeatherUnitRoutes } from "./weather-unit-routes.js";
import { registerThemeRoutes } from "./themes-routes.js";
import { registerYoloRoutes } from "./yolo-routes.js";
import { registerNotesSourceRoutes, type ReconcileNotesScheduleFn } from "./notes-source-routes.js";
import {
  registerNotificationPreferencesRoutes,
  type NotificationUnreadPort
} from "./notification-preferences-routes.js";
import {
  registerMeAccountRoutes,
  type HasPasswordCredentialPort,
  type VerifySelfPasswordPort
} from "./me-account-routes.js";
import { registerMeSessionsRoutes, type MeSessionsService } from "./me-sessions-routes.js";
import {
  registerOnboardingRoutes,
  type OnboardingInstallDependencies,
  type OnboardingLoginDependencies,
  type OnboardingProbes
} from "./onboarding-routes.js";
import { registerPersonaRoutes } from "./persona-routes.js";
import type { NotificationPreferencesPort, PersonaPreviewInput } from "./preferences-port.js";
import { registerPriorityRoutes } from "./priority-routes.js";
import {
  registerProactiveMonitoringSettingsRoutes,
  type ReconcileProactiveScheduleFn
} from "./proactive-monitoring-routes.js";
import { SettingsRepository } from "./repository.js";
import { createModuleCredentialSecretCipher } from "./module-credential-crypto.js";
import { registerModuleCredentialRoutes } from "./routes-module-credentials.js";
// #917: the module-management route family was extracted here for the 1000-line file-size gate.
import { registerModuleRegistryRoutes } from "./routes-module-registry.js";
import { registerModuleRoutes } from "./routes-modules.js";
import {
  handleRouteError,
  serializeAdminAuditEvent,
  serializeInstanceSetting,
  serializeUser
} from "./routes-serializers.js";
import { registerSourceBehaviorRoutes } from "./source-behavior-routes.js";
import {
  INSTANCE_SETTINGS_REGISTRY,
  KNOWN_INSTANCE_SETTING_KEYS,
  SECRET_INSTANCE_SETTING_KEYS
} from "./instance-settings-keys.js";

export type GetChatMultiplexerStatus = (configured: ChatMultiplexerChoice) => Promise<{
  readonly available: ChatMultiplexerAvailability;
  readonly herdrInstalled: boolean;
  readonly active: MultiplexerKind | null;
  readonly activeSource: MultiplexerSource | null;
  readonly envOverride: MultiplexerKind | null;
}>;

// #917/#964/#1762: the external-module and module-distribution dependency types moved to their
// own file for the 1000-line file-size gate. Re-exported so importers keep using ./routes.js.
import type {
  ExternalModulesDependencies,
  InstalledExternalModuleSummary,
  ModuleDistributionDependencies
} from "./routes-external-module-types.js";
export type {
  ExternalModuleDiscovery,
  ExternalModuleRejection,
  ExternalModulesDependencies,
  InstalledExternalModuleSummary,
  ModuleDistributionDependencies,
  RegistryEntriesSnapshot
} from "./routes-external-module-types.js";

export interface SettingsRoutesDependencies {
  // Kysely exemption: only BootstrapHelper uses rootDb before any actor/session exists.
  readonly rootDb: Kysely<MossDatabase>;
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly listConfiguredAuthProviders?: () => readonly AuthProviderStatusDto[];
  readonly listModuleManifests: () => readonly MossModuleManifest[];
  /**
   * Derived module-owned deletion tables (Phase A, #801), flattened by the composition
   * root from every built-in module's `dataLifecycle.deletion.tables` (see
   * @moss/module-registry's `getModuleDeletionTables`/`MODULE_DELETION_TABLES`).
   * Threaded to `deleteUserData` so migrated modules' rows come off this package's
   * hardcoded `userScopedCountQueries` list.
   */
  readonly moduleDeletionTables: readonly { table: string; countPredicate: string }[];
  readonly preferencesRepository?: NotificationPreferencesPort;
  readonly personaPreview?: (input: PersonaPreviewInput) => Promise<string>;
  readonly repository?: SettingsRepository;
  /** #917 external-module discovery snapshot; routes added in Task 9 consume it. */
  readonly externalModules?: ExternalModulesDependencies;
  /**
   * #1762 — installed, instance-active external modules for the acting user, injected by the
   * composition root for the same no-import-cycle reason as `externalModules.reconcile`.
   *
   * Deliberately NOT filtered by the actor's own deny rows: this feeds the personal Modules list,
   * which has to keep showing a module the user switched off so they can switch it back on.
   *
   * Only the fields that list needs are in the port. In particular `hasPreferences` is a flag, not
   * the declarations — the pane fetches those separately when the user opens the module.
   */
  readonly listInstalledExternalModules?: (
    accessContext: AccessContext
  ) => Promise<readonly InstalledExternalModuleSummary[]>;
  /** #964 module-distribution port; registry routes degrade to enabled:false when absent. */
  readonly moduleDistribution?: ModuleDistributionDependencies;
  readonly reconcileExternalModuleJobs?: (
    change:
      | { readonly kind: "module"; readonly moduleId: string }
      | { readonly kind: "user"; readonly userId: string }
  ) => Promise<void>;
  readonly revokeUserSessions?: (userId: string) => Promise<number>;
  /** Auth-owned current-user session list/revoke service (#237). */
  readonly meSessions?: MeSessionsService;
  /**
   * Auth-owned password re-verification for self-service account deletion (#239).
   * Absent in deployments without an auth runtime; the route fails closed for
   * password-bearing accounts when this is unset.
   */
  readonly verifySelfPassword?: VerifySelfPasswordPort;
  /**
   * Auth-owned existence probe (does the actor own a password credential?) for
   * GET /api/me and the self-delete dialog. Required behind an auth port because
   * migration 0045 revoked app_runtime SELECT on auth_accounts.
   */
  readonly hasPasswordCredential?: HasPasswordCredentialPort;
  readonly bootstrapConnectionString?: string;
  /** Live multiplexer status probe, resolved fresh per request. */
  readonly getChatMultiplexerStatus?: GetChatMultiplexerStatus;
  /** Onboarding probes; injected to preserve module isolation and fail closed if absent. */
  readonly onboardingProbes?: OnboardingProbes;
  /**
   * §A.5 install seam (#342 Phase 2): the catalog installability port, the cli-runner
   * `installProvider` RPC client, the admin-actor state store, and the §A.4.2 reconcile
   * port. Injected by the composition root (module isolation — settings never imports
   * @moss/chat / cli-runner). Absent ⇒ the install route fails closed (500) and the
   * status route serves the Phase-1 presence-only surface.
   */
  readonly onboardingInstall?: OnboardingInstallDependencies;
  /**
   * §L.5 login seam (#342 Phase 3): the loginability port, the cli-runner login RPC client, and
   * the admin-actor login state store. Injected by the composition root (module isolation). Absent
   * ⇒ the login routes fail closed (500).
   */
  readonly onboardingLogin?: OnboardingLoginDependencies;
  /** Host diagnostics runtime-facts provider (#255); injected by the composition root. */
  readonly hostDiagnostics?: HostDiagnosticsProvider;
  /** Fixed-script Herdr install executor port (#993); injected by the composition root. */
  readonly herdrInstall?: HerdrInstallDependencies;
  /**
   * #1748 admin restart control directory; injected by the composition root. Absent on a
   * deployment that has no bind-mounted control dir, which fails the route closed.
   */
  readonly hostRestart?: HostRestartDependencies;
  /** pg-boss instance for enqueueing export.build jobs (#431). */
  readonly boss?: PgBoss;
  /**
   * #449: per-actor 15-min notes-sync heartbeat reconcile hook. Injected by the
   * composition root (lives in @moss/notes; injected here to avoid a circular
   * import). Absent ⇒ no heartbeat (manual sync still works).
   */
  readonly reconcileNotesSchedule?: ReconcileNotesScheduleFn;
  /** Optional: reconcile per-source proactive-monitoring recurring jobs on settings save. */
  readonly reconcileProactiveSchedule?: ReconcileProactiveScheduleFn;
  readonly notificationUnreadPort?: NotificationUnreadPort;
  /**
   * #1263 Task 15: install-time self-operation grant port (settings never imports @moss/ai
   * directly — module isolation). Called on built-in module ENABLE only (user + admin routes),
   * inside the same actor-scoped transaction as the enable write, after it succeeds. Absent ⇒
   * enable proceeds with no grant (matches pre-#1263 behavior). External module enable
   * (/api/admin/external-modules/:id) never calls this — that's #1267.
   */
  readonly grantSelfOperationForModule?: (
    scopedDb: DataContextDb,
    manifest: MossModuleManifest
  ) => Promise<void>;
  /** Overrides the global fetch for outbound calls made by settings routes (tests only). */
  readonly fetchFn?: typeof fetch;
}

interface SettingParams {
  readonly key: string;
}

export function registerSettingsRoutes(
  server: FastifyInstance,
  dependencies: SettingsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new SettingsRepository();
  const preferencesRepository: NotificationPreferencesPort = dependencies.preferencesRepository ?? {
    get: async () => null,
    getWithMetadata: async () => null,
    upsert: async () => undefined,
    getWithRevision: async () => null,
    upsertWithRevision: async (_scopedDb, _key, _value, expectedRevision) => ({
      revision: (expectedRevision ?? 0) + 1
    })
  };
  const bootstrapHelper = new BootstrapHelper(dependencies.rootDb);
  registerLocaleRoutes(server, { ...dependencies, preferencesRepository });
  registerQuietHoursRoutes(server, { ...dependencies, preferencesRepository });
  registerWeatherLocationRoutes(server, { ...dependencies, preferencesRepository });
  registerWeatherLocationSearchRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    fetchFn: dependencies.fetchFn
  });
  registerWeatherUnitRoutes(server, { ...dependencies, preferencesRepository });
  registerThemeRoutes(server, { ...dependencies, preferencesRepository });
  registerNotesSourceRoutes(server, { ...dependencies, preferencesRepository });
  registerMeSessionsRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    meSessions: dependencies.meSessions
  });
  registerMeAccountRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    dataContext: dependencies.dataContext,
    repository,
    bootstrapConnectionString: dependencies.bootstrapConnectionString,
    verifySelfPassword: dependencies.verifySelfPassword,
    hasPasswordCredential: dependencies.hasPasswordCredential,
    moduleDeletionTables: dependencies.moduleDeletionTables,
    reconcileExternalModuleJobs: dependencies.reconcileExternalModuleJobs
  });
  registerPersonaRoutes(server, { ...dependencies, repository, preferencesRepository });
  registerNotificationPreferencesRoutes(server, {
    ...dependencies,
    repository,
    preferencesRepository,
    notificationUnreadPort: dependencies.notificationUnreadPort,
    boss: dependencies.boss
  });
  registerSourceBehaviorRoutes(server, { ...dependencies, preferencesRepository });
  registerPriorityRoutes(server, { ...dependencies, preferencesRepository });
  registerYoloRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository,
    preferencesRepository,
    assertAdminUser: (scopedDb, userId) => assertAdminUser(repository, scopedDb, userId),
    handleRouteError,
    requireRequestId
  });
  registerProactiveMonitoringSettingsRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    reconcileProactiveSchedule: dependencies.reconcileProactiveSchedule
  });
  registerDataExportRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    rootDb: dependencies.rootDb,
    listModuleManifests: dependencies.listModuleManifests
  });
  if (dependencies.boss) {
    registerDataExportAsyncRoutes(server, {
      boss: dependencies.boss,
      dataContext: dependencies.dataContext,
      resolveAccessContext: dependencies.resolveAccessContext
    });
  }
  server.get("/api/bootstrap/status", { schema: bootstrapStatusRouteSchema }, async () => {
    // Return only the boolean the client needs. User count and owner identity are
    // instance-wide data exposed on an UNAUTHENTICATED route — do not leak them
    // (OTNR-P4 #122).
    const ownerExists = await bootstrapHelper.bootstrapOwnerExists();

    return {
      needsBootstrap: !ownerExists
    };
  });

  server.get("/api/me", { schema: meRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const { user, addressed } = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => ({
          user: await requireKnownUser(repository, scopedDb, accessContext.actorUserId),
          addressed: await preferencesRepository.get(scopedDb, "profile.addressed")
        })
      );
      // Existence-only probe runs on the auth pool (app_runtime can't read
      // auth_accounts — migration 0045). Fall back to false when no auth runtime.
      const hasPasswordCredential = dependencies.hasPasswordCredential
        ? await dependencies.hasPasswordCredential(accessContext.actorUserId)
        : false;

      return {
        user: serializeUser(user),
        profilePrefs: { addressed: typeof addressed === "string" ? addressed : null },
        hasPasswordCredential
      };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch("/api/me/profile", { schema: patchMeProfileRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = request.body as { name: string; addressed: string };
      const name = body.name.trim();
      const addressed = body.addressed.trim();
      if (name.length === 0) throw new HttpError(400, "Display name is required");
      const user = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const updated = await repository.updateSelfName(scopedDb, {
            actorUserId: accessContext.actorUserId,
            name
          });
          await preferencesRepository.upsert(scopedDb, "profile.addressed", addressed);
          return updated;
        }
      );
      return { user: serializeUser(user), profilePrefs: { addressed } };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/admin/auth/providers",
    { schema: listAuthProviderStatusesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          assertAdminUser(repository, scopedDb, accessContext.actorUserId)
        );

        return {
          providers: dependencies.listConfiguredAuthProviders?.() ?? []
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // FIN-04 (#1149): authenticated NON-admin directory — id + name of active
  // members only. Deliberate, narrow product surface relative to #75 /
  // migration 0047 (which stopped GUC-less enumeration of full user rows
  // including emails): household sharing UX needs co-member display names, and
  // the alternative — persisting names into module storage — violates "ids
  // only in storage" and goes stale on rename. The DB read rides the same
  // SECURITY DEFINER app.list_all_users() the admin route uses (the admin gate
  // was always route-level, not DB-level); redaction to { id, name } is
  // enforced by the response schema (fast-json-stringify drops undeclared
  // fields) in addition to the serializer below.
  server.get(
    "/api/users/directory",
    { schema: listUserDirectoryRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const users = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            // Any known (active) member may resolve names — requireKnownUser
            // is the /api/me idiom, not assertAdminUser.
            await requireKnownUser(repository, scopedDb, accessContext.actorUserId);
            return repository.listUsers(scopedDb);
          }
        );

        return {
          users: users
            .filter((user) => user.status === "active")
            .map((user) => ({ id: user.id, name: user.name ?? null }))
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get("/api/admin/users", { schema: listUsersRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const users = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          return repository.listUsers(scopedDb);
        }
      );

      return { users: users.map(serializeUser) };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/admin/settings",
    { schema: listInstanceSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const settings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            return repository.listInstanceSettings(scopedDb);
          }
        );

        const registeredKeys = new Set(
          INSTANCE_SETTINGS_REGISTRY.filter((e) => !e.secret).map((e) => e.key)
        );
        return {
          settings: settings.filter((s) => registeredKeys.has(s.key)).map(serializeInstanceSetting)
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: SettingParams }>(
    "/api/admin/settings/:key",
    { schema: upsertInstanceSettingRouteSchema },
    async (request, reply) => {
      try {
        if (!KNOWN_INSTANCE_SETTING_KEYS.has(request.params.key)) {
          return reply.status(400).send({ error: "Unknown settings key" });
        }
        // Secret keys (e.g. the Brave Search API key) are write-only through their dedicated
        // encrypted routes — reject them here so a plaintext value can never be stored via the
        // generic jsonb upsert path.
        if (SECRET_INSTANCE_SETTING_KEYS.has(request.params.key)) {
          return reply.status(400).send({ error: "This setting is managed via a dedicated route" });
        }
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseInstanceSettingBody(request.body);
        const setting = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            return repository.upsertInstanceSetting(scopedDb, {
              key: request.params.key,
              value: body.value,
              updatedByUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext)
            });
          }
        );

        return { setting: serializeInstanceSetting(setting) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/admin/users/:id/approve",
    { schema: adminUserActionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const user = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            const existing = await repository.getUserById(scopedDb, id);
            if (!existing) throw new HttpError(404, "User not found");
            if (existing.status !== "pending")
              throw new HttpError(409, "Only pending accounts can be approved");
            return repository.setUserStatus(scopedDb, {
              targetUserId: id,
              status: "active",
              action: "user.approve",
              actorUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext)
            });
          }
        );
        return { user: serializeUser(user) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  const lifecycleAction = (verb: string, status: "active" | "deactivated", action: string) =>
    server.post(
      `/api/admin/users/:id/${verb}`,
      { schema: adminUserActionRouteSchema },
      async (request, reply) => {
        try {
          const accessContext = await dependencies.resolveAccessContext(request);
          const { id } = request.params as { id: string };
          const user = await dependencies.dataContext.withDataContext(
            accessContext,
            async (scopedDb) => {
              await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
              return repository.setUserStatus(scopedDb, {
                targetUserId: id,
                status,
                action,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              });
            }
          );
          if (verb === "deactivate" && dependencies.revokeUserSessions) {
            await dependencies.revokeUserSessions(id);
          }
          try {
            await dependencies.reconcileExternalModuleJobs?.({ kind: "user", userId: id });
          } catch (error) {
            request.log.warn(
              { userId: id, errorName: (error as Error).name },
              "external module user schedule reconcile failed"
            );
          }
          return { user: serializeUser(user) };
        } catch (error) {
          return handleRouteError(error, reply);
        }
      }
    );

  lifecycleAction("reactivate", "active", "user.reactivate");
  lifecycleAction("deactivate", "deactivated", "user.deactivate");

  server.post(
    "/api/admin/users/:id/revoke-sessions",
    { schema: adminRevokeSessionsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        // Admin check + target existence check share ONE transaction (post-D pattern).
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const target = await repository.getUserById(scopedDb, id);
          if (!target) throw new HttpError(404, "User not found");
        });
        // revokeUserSessions runs on the auth pool (DELETE ... WHERE user_id = id) — outside
        // the data context. It targets the named user's sessions only, never the calling
        // admin's. The response carries the deleted-row count and nothing from the session row.
        const count = dependencies.revokeUserSessions
          ? await dependencies.revokeUserSessions(id)
          : 0;
        return { success: true, count };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  const adminFlagAction = (verb: "promote" | "demote", isInstanceAdmin: boolean) =>
    server.post(
      `/api/admin/users/:id/${verb}`,
      { schema: adminUserActionRouteSchema },
      async (request, reply) => {
        try {
          const accessContext = await dependencies.resolveAccessContext(request);
          const { id } = request.params as { id: string };
          const user = await dependencies.dataContext.withDataContext(
            accessContext,
            async (scopedDb) => {
              await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
              return repository.setUserAdmin(scopedDb, {
                targetUserId: id,
                isInstanceAdmin,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              });
            }
          );
          return { user: serializeUser(user) };
        } catch (error) {
          return handleRouteError(error, reply);
        }
      }
    );

  adminFlagAction("promote", true);
  adminFlagAction("demote", false);

  async function tearDownAccount(
    request: FastifyRequest,
    id: string,
    requirePending: boolean
  ): Promise<string> {
    const accessContext = await dependencies.resolveAccessContext(request);
    await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
      // Guard order preserved from the original routes.ts (404 → pending-409 → self-422
      // → bootstrap-409 → last-admin-409). Do not reorder.
      await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
      const existing = await repository.getUserById(scopedDb, id);
      if (!existing) throw new HttpError(404, "User not found");
      if (requirePending && existing.status !== "pending") {
        throw new HttpError(409, "Only pending accounts can be rejected");
      }
      if (id === accessContext.actorUserId)
        throw new HttpError(422, "You cannot delete your own account");
      if (existing.is_bootstrap_owner)
        throw new HttpError(409, "The bootstrap owner cannot be deleted");
      if (existing.is_instance_admin) await repository.assertNotLastActiveAdmin(scopedDb, id);
    });
    // The pre-check above is a fast-path 409 for the common case; it commits and
    // releases its advisory lock before deleteUserData runs. deleteUserData
    // re-asserts the last-admin guard under the same lock inside its own
    // transaction, so it is the authoritative serialized check. Map its typed
    // failure back to a 409 if a concurrent removal won the race (#94).
    try {
      await deleteUserData({
        userId: id,
        confirmUserId: id,
        actorUserId: accessContext.actorUserId,
        requestId: requireRequestId(accessContext),
        bootstrapConnectionString: dependencies.bootstrapConnectionString,
        dryRun: false,
        moduleDeletionTables: dependencies.moduleDeletionTables
      });
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        throw new HttpError(409, error.message);
      }
      throw error;
    }
    try {
      await dependencies.reconcileExternalModuleJobs?.({ kind: "user", userId: id });
    } catch (error) {
      request.log.warn(
        { userId: id, errorName: (error as Error).name },
        "external module user schedule reconcile failed"
      );
    }
    return id;
  }

  server.post(
    "/api/admin/users/:id/reject",
    { schema: adminRejectUserRouteSchema },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const rejectedUserId = await tearDownAccount(request, id, true);
        return { rejectedUserId };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/admin/users/:id",
    { schema: adminDeleteUserRouteSchema },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deletedUserId = await tearDownAccount(request, id, false);
        return { deletedUserId };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/admin/registration",
    { schema: getRegistrationSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          return repository.getRegistrationSettings(scopedDb);
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/registration",
    { schema: putRegistrationSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as { registrationEnabled: boolean; requiresApproval: boolean };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          return repository.setRegistrationSettings(scopedDb, {
            registrationEnabled: body.registrationEnabled,
            requiresApproval: body.requiresApproval,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/admin/chat-multiplexer",
    { schema: getChatMultiplexerSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const { multiplexer } = await repository.getChatMultiplexerSetting(scopedDb);
          const status = (await dependencies.getChatMultiplexerStatus?.(multiplexer)) ?? {
            available: { tmux: false, herdr: false },
            herdrInstalled: false,
            active: null,
            activeSource: null,
            envOverride: null
          };
          return { multiplexer, ...status };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/chat-multiplexer",
    { schema: putChatMultiplexerSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as { multiplexer: ChatMultiplexerChoice };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const { multiplexer } = await repository.setChatMultiplexerSetting(scopedDb, {
            multiplexer: body.multiplexer,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          const status = (await dependencies.getChatMultiplexerStatus?.(multiplexer)) ?? {
            available: { tmux: false, herdr: false },
            herdrInstalled: false,
            active: null,
            activeSource: null,
            envOverride: null
          };
          return { multiplexer, ...status };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/admin/audit-events",
    { schema: listAdminAuditEventsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const auditEvents = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            return repository.listAdminAuditEvents(scopedDb);
          }
        );

        return { auditEvents: auditEvents.map(serializeAdminAuditEvent) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  registerOnboardingRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    onboardingProbes: dependencies.onboardingProbes,
    onboardingInstall: dependencies.onboardingInstall,
    onboardingLogin: dependencies.onboardingLogin,
    repository,
    requireKnownUser: (scopedDb, userId) => requireKnownUser(repository, scopedDb, userId),
    assertBootstrapOwnerAdminUser: (scopedDb, userId) =>
      assertBootstrapOwnerAdminUser(repository, scopedDb, userId),
    requireRequestId,
    handleRouteError
  });

  registerHostDiagnosticsRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository,
    getChatMultiplexerStatus: dependencies.getChatMultiplexerStatus,
    hostDiagnostics: dependencies.hostDiagnostics,
    assertAdminUser: (scopedDb, userId) => assertAdminUser(repository, scopedDb, userId),
    handleRouteError
  });

  registerHerdrInstallRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository,
    getChatMultiplexerStatus: dependencies.getChatMultiplexerStatus,
    herdrInstall: dependencies.herdrInstall,
    assertAdminUser: (scopedDb, userId) => assertAdminUser(repository, scopedDb, userId),
    requireRequestId,
    handleRouteError
  });

  registerHostRestartRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository,
    hostRestart: dependencies.hostRestart,
    assertAdminUser: (scopedDb, userId) => assertAdminUser(repository, scopedDb, userId),
    requireRequestId,
    handleRouteError
  });

  // #917: the module-management route family (admin modules, external modules, per-user
  // modules) plus parseDisabledBody was extracted to ./routes-modules.js to satisfy the
  // 1000-line file-size gate (Task 9 pushed routes.ts over the cap). Pure move — same handlers,
  // same order, same admin/RLS/fail-closed logic. registerSettingsRoutes keeps its signature.
  registerModuleRoutes(server, { dependencies, repository, assertAdminUser, requireRequestId });
  registerModuleRegistryRoutes(server, {
    dependencies,
    repository,
    assertAdminUser,
    requireRequestId
  });
  // #918: module-credential admin/per-user routes, with their own dedicated cipher
  // (JARVIS_MODULE_CREDENTIAL_SECRET_KEY family — independent rotation from connector/AI keys).
  registerModuleCredentialRoutes(server, {
    dependencies,
    repository,
    assertAdminUser,
    requireRequestId,
    cipher: createModuleCredentialSecretCipher()
  });
}

// The admin check happens INSIDE the route's withDataContext so the admin check and the
// actual operation share one transaction. assertAdminUser/requireKnownUser take scopedDb
// from that transaction — there is no nested withDataContext and no DB-holding helper.
export async function assertAdminUser(
  repository: SettingsRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<User> {
  const user = await requireKnownUser(repository, scopedDb, userId);
  if (!user.is_instance_admin) {
    throw new HttpError(403, "Instance admin permission is required");
  }
  return user;
}

// Onboarding is founder/instance provisioning and writes the SINGLE instance-scoped
// onboarding.state row, so it must be gated to the bootstrap owner — not merely any
// instance admin. A promoted non-owner admin must NOT be able to read the owner's
// onboarding status or complete/skip it out from under them (defense-in-depth at the
// route, not only at the app.tsx trigger). Requires is_instance_admin AND
// is_bootstrap_owner; same clean 403 as assertAdminUser for any other caller.
async function assertBootstrapOwnerAdminUser(
  repository: SettingsRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<User> {
  const user = await assertAdminUser(repository, scopedDb, userId);
  if (!user.is_bootstrap_owner) {
    throw new HttpError(403, "Bootstrap owner permission is required");
  }
  return user;
}

async function requireKnownUser(
  repository: SettingsRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<User> {
  const user = await repository.getUserById(scopedDb, userId);

  if (!user) {
    throw new HttpError(401, "Session is missing or expired");
  }

  return user;
}

function requireRequestId(accessContext: AccessContext): string {
  if (!accessContext.requestId) {
    throw new HttpError(500, "Request id is missing");
  }

  return accessContext.requestId;
}

function parseInstanceSettingBody(body: unknown): UpsertInstanceSettingRequest {
  const value = requireObject(body);
  const settingValue = value.value;

  if (!settingValue || typeof settingValue !== "object" || Array.isArray(settingValue)) {
    throw new HttpError(400, "value must be a JSON object");
  }

  return {
    value: settingValue as Record<string, unknown>
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }

  return value as Record<string, unknown>;
}
