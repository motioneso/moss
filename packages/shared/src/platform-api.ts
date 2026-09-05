import type { ModuleWebDto } from "./platform-api-modules.js";
import { errorResponseSchema } from "./schema-fragments.js";

export interface UserDto {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly isInstanceAdmin: boolean;
  readonly status: "pending" | "active" | "deactivated";
  readonly isBootstrapOwner: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminAuditEventDto {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly requestId: string | null;
  readonly createdAt: string;
}

export interface AuthProviderStatusDto {
  readonly id: string;
  readonly displayName: string;
  readonly providerType: "local" | "oauth" | "oidc";
  readonly enabled: boolean;
}

export interface ModuleNavigationEntryDto {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon: string | null;
  readonly order: number | null;
  /**
   * #1285: a count badge on this nav entry, derived from a core-owned count — never
   * module-supplied text or a number. Closed enum with one member today. Mirrors
   * `ExternalModuleNavigationEntry.badge` (module-sdk), the manifest-facing type this is
   * serialized from in `serializeExternalModule` (apps/api/src/server.ts). Absent for
   * built-ins and any external entry without one.
   */
  readonly badge?: {
    readonly source: "notifications";
  };
}

export interface ModuleSettingsSurfaceDto {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly scope: "user" | "admin" | "system";
  readonly order: number | null;
}

export interface ModuleDto {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly lifecycle: "required" | "optional" | "user-toggleable" | "workspace-toggleable";
  readonly navigation: readonly ModuleNavigationEntryDto[];
  readonly settings: readonly ModuleSettingsSurfaceDto[];
  /** #917: true for active external (non-compiled) modules. Absent/false for built-ins. */
  readonly external?: boolean;
  /** #918: web contribution declaration. Absent for built-ins and modules without one. */
  readonly web?: ModuleWebDto;
  /**
   * #1756: true when this module is still a running draft owned by the caller (#1753's
   * draft status). /api/modules only ever returns a draft row to its own owner (the active-module
   * resolver filters everyone else's out), so seeing this true here always means "your own,
   * still-being-built module" — never someone else's. Absent once the module has shipped.
   */
  readonly draft?: boolean;
}

export interface InstanceSettingDto {
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly updatedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BootstrapStatusResponse {
  readonly needsBootstrap: boolean;
}

export type LocaleDateFormat = "24" | "12";
export interface LocaleSettingsDto {
  readonly timezone: string;
  readonly region: string;
  readonly dateFormat: LocaleDateFormat;
}
/**
 * The locale a user sees before saving one. `GET /api/me/locale` reports this when no preference
 * row exists, so anything resolving the actor's *effective* timezone must fall back to the same
 * value. #2157: the chat clock read the raw row, found nothing, and answered in UTC while Settings
 * showed Pacific.
 */
export const DEFAULT_LOCALE_SETTINGS: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};
export interface GetLocaleSettingsResponse {
  readonly locale: LocaleSettingsDto;
}
export interface PutLocaleSettingsRequest {
  readonly locale: LocaleSettingsDto;
}
export type PutLocaleSettingsResponse = GetLocaleSettingsResponse;
export interface ListUsersResponse {
  readonly users: readonly UserDto[];
}

/**
 * FIN-04 (#1149): one row of the authenticated (non-admin) user directory.
 * Deliberately id + name ONLY — no email, admin flag, status, or timestamps.
 * `name` may be null upstream; clients fall back to a neutral label, never to
 * the email (the email must not reach this surface at all).
 */
export interface UserDirectoryEntryDto {
  readonly id: string;
  readonly name: string | null;
}

export interface ListUserDirectoryResponse {
  readonly users: readonly UserDirectoryEntryDto[];
}

export interface ListInstanceSettingsResponse {
  readonly settings: readonly InstanceSettingDto[];
}

export interface UpsertInstanceSettingRequest {
  readonly value: Record<string, unknown>;
}

export interface UpsertInstanceSettingResponse {
  readonly setting: InstanceSettingDto;
}

export interface ListAdminAuditEventsResponse {
  readonly auditEvents: readonly AdminAuditEventDto[];
}

export interface ListAuthProviderStatusesResponse {
  readonly providers: readonly AuthProviderStatusDto[];
}

export interface ListModulesResponse {
  readonly modules: readonly ModuleDto[];
}

const authProviderStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "displayName", "providerType", "enabled"],
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    providerType: { type: "string", enum: ["local", "oauth", "oidc"] },
    enabled: { type: "boolean" }
  }
} as const;

// #1285: closed-enum badge shape. Not `required` on the entry schema below — built-ins
// and most external entries have none.
const moduleNavigationBadgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: {
    source: { type: "string", enum: ["notifications"] }
  }
} as const;

const moduleNavigationEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "path", "icon", "order"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    path: { type: "string" },
    icon: { type: ["string", "null"] },
    order: { type: ["number", "null"] },
    // #1285: declared so fast-json-stringify does not silently strip it (undeclared
    // fields are dropped even though present on the JS object and the TS type — same
    // trap `external`/`web` above already document). NOT in `required` — absent for
    // built-ins and most external entries.
    badge: moduleNavigationBadgeSchema
  }
} as const;

const moduleSettingsSurfaceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "path", "scope", "order"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    path: { type: "string" },
    scope: { type: "string", enum: ["user", "admin", "system"] },
    order: { type: ["number", "null"] }
  }
} as const;

const moduleWebSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entrypoint", "contractVersion"],
  properties: {
    entrypoint: { type: "string" },
    contractVersion: { type: "integer" }
  }
} as const;

const moduleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "version", "lifecycle", "navigation", "settings"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    lifecycle: {
      type: "string",
      enum: ["required", "optional", "user-toggleable", "workspace-toggleable"]
    },
    navigation: { type: "array", items: moduleNavigationEntrySchema },
    settings: { type: "array", items: moduleSettingsSurfaceSchema },
    // #917: declared so fast-json-stringify does not strip it (undeclared fields are
    // silently dropped). NOT in `required` — built-ins emit external:false explicitly,
    // but existing producers/fixtures that omit it stay valid.
    external: { type: "boolean" },
    // #918: web contribution declaration. NOT in `required` — absent for built-ins.
    web: moduleWebSchema,
    // #1756: present-and-true only for the caller's own still-running draft; absent otherwise.
    draft: { type: "boolean" }
  }
} as const;

export const userSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "email",
    "emailVerified",
    "name",
    "isInstanceAdmin",
    "status",
    "isBootstrapOwner",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    emailVerified: { type: "boolean" },
    name: { type: "string" },
    isInstanceAdmin: { type: "boolean" },
    status: { type: "string", enum: ["pending", "active", "deactivated"] },
    isBootstrapOwner: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

const adminAuditEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "actorUserId",
    "action",
    "targetType",
    "targetId",
    "metadata",
    "requestId",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    actorUserId: { type: ["string", "null"] },
    action: { type: "string" },
    targetType: { type: "string" },
    targetId: { type: ["string", "null"] },
    metadata: { type: "object", additionalProperties: true },
    requestId: { type: ["string", "null"] },
    createdAt: { type: "string" }
  }
} as const;

const settingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "value", "updatedByUserId", "createdAt", "updatedAt"],
  properties: {
    key: { type: "string" },
    value: { type: "object", additionalProperties: true },
    updatedByUserId: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

export const listAuthProviderStatusesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["providers"],
      properties: {
        providers: { type: "array", items: authProviderStatusSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const listModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["modules"],
      properties: {
        modules: { type: "array", items: moduleSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const bootstrapStatusRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["needsBootstrap"],
      properties: {
        needsBootstrap: { type: "boolean" }
      }
    }
  }
} as const;

const localeSettingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["timezone", "region", "dateFormat"],
  properties: {
    timezone: { type: "string", minLength: 1, maxLength: 100 },
    region: { type: "string", minLength: 1, maxLength: 35 },
    dateFormat: { type: "string", enum: ["24", "12"] }
  }
} as const;
export const getLocaleSettingsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["locale"],
      properties: {
        locale: localeSettingsSchema
      }
    },
    401: errorResponseSchema
  }
} as const;
export const putLocaleSettingsRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["locale"],
    properties: {
      locale: localeSettingsSchema
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["locale"],
      properties: {
        locale: localeSettingsSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const listUsersRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["users"],
      properties: {
        users: { type: "array", items: userSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

/**
 * FIN-04 (#1149) directory schema. fast-json-stringify DROPS every field not
 * declared here (additionalProperties: false + explicit properties), so this
 * schema IS the redaction enforcement for the non-admin directory — a
 * serializer bug upstream cannot leak emails through this response.
 */
export const listUserDirectoryRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["users"],
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: ["string", "null"] }
            }
          }
        }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const listInstanceSettingsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["settings"],
      properties: {
        settings: { type: "array", items: settingSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const listAdminAuditEventsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["auditEvents"],
      properties: {
        auditEvents: { type: "array", items: adminAuditEventSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const upsertInstanceSettingRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
      value: { type: "object", additionalProperties: true }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["setting"],
      properties: {
        setting: settingSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

/** The admin-selectable multiplexer choice. Single source of truth — ai/settings import this. */
export type ChatMultiplexerChoice = "auto" | "tmux" | "herdr";

export interface RegistrationSettingsDto {
  readonly registrationEnabled: boolean;
  readonly requiresApproval: boolean;
}

const registrationSettingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["registrationEnabled", "requiresApproval"],
  properties: {
    registrationEnabled: { type: "boolean" },
    requiresApproval: { type: "boolean" }
  }
} as const;

export const adminUserActionRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["user"],
      properties: { user: userSchema }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;

export const adminRevokeSessionsRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["success", "count"],
      properties: {
        success: { type: "boolean" },
        count: { type: "number" }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const adminDeleteUserRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deletedUserId"],
      properties: { deletedUserId: { type: "string" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;

export const adminRejectUserRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["rejectedUserId"],
      properties: { rejectedUserId: { type: "string" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;

export const getRegistrationSettingsRouteSchema = {
  response: {
    200: registrationSettingsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const putRegistrationSettingsRouteSchema = {
  body: registrationSettingsSchema,
  response: {
    200: registrationSettingsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export interface ChatMultiplexerAvailability {
  readonly tmux: boolean;
  readonly herdr: boolean;
}

export type MultiplexerKind = "tmux" | "herdr";
export type MultiplexerSource = "env" | "configured" | "auto";

export interface ChatMultiplexerSettingsDto {
  readonly multiplexer: ChatMultiplexerChoice;
  readonly available: ChatMultiplexerAvailability;
  readonly herdrInstalled: boolean;
  readonly active: MultiplexerKind | null;
  readonly activeSource: MultiplexerSource | null;
  readonly envOverride: MultiplexerKind | null;
}

export const chatMultiplexerSettingsSchema = {
  type: "object",
  required: ["multiplexer", "available", "herdrInstalled", "active", "activeSource", "envOverride"],
  additionalProperties: false,
  properties: {
    multiplexer: { type: "string", enum: ["auto", "tmux", "herdr"] },
    available: {
      type: "object",
      required: ["tmux", "herdr"],
      additionalProperties: false,
      properties: { tmux: { type: "boolean" }, herdr: { type: "boolean" } }
    },
    herdrInstalled: { type: "boolean" },
    active: { type: ["string", "null"], enum: ["tmux", "herdr", null] },
    activeSource: { type: ["string", "null"], enum: ["env", "configured", "auto", null] },
    envOverride: { type: ["string", "null"], enum: ["tmux", "herdr", null] }
  }
} as const;

export const getChatMultiplexerSettingsRouteSchema = {
  response: {
    200: chatMultiplexerSettingsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const putChatMultiplexerSettingsRouteSchema = {
  body: {
    type: "object",
    required: ["multiplexer"],
    additionalProperties: false,
    properties: { multiplexer: { type: "string", enum: ["auto", "tmux", "herdr"] } }
  },
  response: {
    200: chatMultiplexerSettingsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

// ── Host diagnostics (admin-only, read-only, secret-safe) ───────────────────

/** Pass/warn/fail status for a single diagnostic check. */
export type HostDiagnosticStatus = "pass" | "warn" | "fail";

/** One diagnostic check. `detail` is a short, fixed, secret-free message. */
export interface HostDiagnosticCheckDto {
  readonly id: string;
  readonly label: string;
  readonly status: HostDiagnosticStatus;
  readonly detail: string;
}

/**
 * Sync runtime facts supplied by the API composition root. Every field is an
 * explicit allowlisted, non-secret value — never an env-var value, connection
 * string, secret, token, or user-data path.
 */
export interface HostDiagnosticsInfo {
  readonly uptimeSeconds: number;
  readonly environment: "production" | "development" | "test" | "unknown";
  /** App version if the deployment sets JARVIS_APP_VERSION, else null. */
  readonly version: string | null;
  /** Short commit if the deployment sets JARVIS_GIT_COMMIT, else null. */
  readonly commit: string | null;
  /** Bind host (e.g. "0.0.0.0") — a config value, not a secret. */
  readonly host: string;
  readonly port: number;
  /** Configured log level readout (env-configured; not a runtime toggle). */
  readonly logLevel: string;
  readonly deployMode: "compose" | "systemd" | "dev" | "unknown";
  /** Documented operator restart command for the deploy mode, or null. */
  readonly restartCommand: string | null;
  readonly moduleCount: number;
  readonly routeCount: number;
}

export interface HostDiagnosticsDto extends HostDiagnosticsInfo {
  readonly multiplexer: ChatMultiplexerChoice;
  readonly available: ChatMultiplexerAvailability;
  readonly checks: readonly HostDiagnosticCheckDto[];
  /** Latest available version fetched from GitHub Releases, or null. */
  readonly latestAvailableVersion: string | null;
  /** Release notes for the latest version. */
  readonly releaseNotes: string | null;
}

const hostDiagnosticCheckSchema = {
  type: "object",
  required: ["id", "label", "status", "detail"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    status: { type: "string", enum: ["pass", "warn", "fail"] },
    detail: { type: "string" }
  }
} as const;

export const hostDiagnosticsSchema = {
  type: "object",
  required: [
    "uptimeSeconds",
    "environment",
    "version",
    "commit",
    "host",
    "port",
    "logLevel",
    "deployMode",
    "restartCommand",
    "moduleCount",
    "routeCount",
    "multiplexer",
    "available",
    "checks",
    "latestAvailableVersion",
    "releaseNotes"
  ],
  additionalProperties: false,
  properties: {
    uptimeSeconds: { type: "number" },
    environment: { type: "string", enum: ["production", "development", "test", "unknown"] },
    version: { type: ["string", "null"] },
    commit: { type: ["string", "null"] },
    host: { type: "string" },
    port: { type: "number" },
    logLevel: { type: "string" },
    deployMode: { type: "string", enum: ["compose", "systemd", "dev", "unknown"] },
    restartCommand: { type: ["string", "null"] },
    moduleCount: { type: "number" },
    routeCount: { type: "number" },
    multiplexer: { type: "string", enum: ["auto", "tmux", "herdr"] },
    available: {
      type: "object",
      required: ["tmux", "herdr"],
      additionalProperties: false,
      properties: { tmux: { type: "boolean" }, herdr: { type: "boolean" } }
    },
    checks: { type: "array", items: hostDiagnosticCheckSchema },
    latestAvailableVersion: { type: ["string", "null"] },
    releaseNotes: { type: ["string", "null"] }
  }
} as const;

export const getHostDiagnosticsRouteSchema = {
  response: {
    200: hostDiagnosticsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

// ── Herdr install (admin-only, fixed-script, single-flight) — #993 ──────────

export type HerdrInstallState = "installed" | "failed" | "timeout";

export interface HerdrInstallResultDto {
  readonly state: HerdrInstallState;
  readonly herdrInstalled: boolean;
}

const herdrInstallResultSchema = {
  type: "object",
  required: ["state", "herdrInstalled"],
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: ["installed", "failed", "timeout"] },
    herdrInstalled: { type: "boolean" }
  }
} as const;

export const postHerdrInstallRouteSchema = {
  response: {
    200: herdrInstallResultSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

// #1748 — admin "Restart app" button. The request carries no body and the response carries no
// host detail: the app's entire capability here is "create one fixed filename in one bind-mounted
// directory", and a caller has nothing to choose. Deliberately NOT a Docker-socket route — see
// docs/superpowers/specs/2026-08-19-admin-restart-app-button.md for why the socket was rejected.

/** Why a restart request was not accepted. Only one cause is expressible today. */
export type HostRestartRejectionReason = "host-watcher-absent";

export interface HostRestartStatusDto {
  /**
   * Whether the host-side unit that actually performs the restart has ever been installed.
   * A weak signal by design (it proves installation, not that the unit is running right now) —
   * the strong signal is the restart itself. Used to disable the button with an honest reason
   * rather than render an enabled button that silently does nothing.
   */
  readonly hostWatcherInstalled: boolean;
  /** ISO timestamp of the pending request, or null when no request is outstanding. */
  readonly lastRequestedAt: string | null;
}

export interface HostRestartResultDto {
  readonly accepted: boolean;
  readonly reason?: HostRestartRejectionReason;
}

const hostRestartStatusSchema = {
  type: "object",
  required: ["hostWatcherInstalled", "lastRequestedAt"],
  additionalProperties: false,
  properties: {
    hostWatcherInstalled: { type: "boolean" },
    lastRequestedAt: { type: ["string", "null"] }
  }
} as const;

const hostRestartResultSchema = {
  type: "object",
  required: ["accepted"],
  additionalProperties: false,
  properties: {
    accepted: { type: "boolean" },
    reason: { type: "string", enum: ["host-watcher-absent"] }
  }
} as const;

export const getHostRestartRouteSchema = {
  response: {
    200: hostRestartStatusSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export const postHostRestartRouteSchema = {
  response: {
    200: hostRestartResultSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

// #917/#918 module admin + credential contracts moved to platform-api-modules.ts
// (file-size gate). Re-exported so @moss/shared consumers see no change.
export * from "./platform-api-modules.js";
