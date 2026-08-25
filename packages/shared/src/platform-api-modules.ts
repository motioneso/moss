// Module admin/credential contract family (#917/#918). Extracted verbatim from
// platform-api.ts to satisfy the 1000-line file-size gate: Task 13 added the
// module-credential DTOs/schemas and pushed platform-api.ts over the cap. This is a
// PURE MOVE — the module-enablement (admin + self-service), external-module admin, and
// module-credential contracts keep the same shape and order. platform-api.ts re-exports
// this file's surface (`export * from "./platform-api-modules.js"`) so `@moss/shared`
// consumers see no change.
import { errorResponseSchema } from "./schema-fragments.js";

// ── Module enablement (admin + self-service) ────────────────────────────────

export interface AdminModuleDto {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly lifecycle: "required" | "optional" | "user-toggleable" | "workspace-toggleable";
  readonly required: boolean;
  readonly supportsUserDisable: boolean;
  readonly instanceDisabled: boolean;
}

export interface MyModuleDto {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly lifecycle: "required" | "optional" | "user-toggleable" | "workspace-toggleable";
  readonly required: boolean;
  readonly supportsUserDisable: boolean;
  readonly instanceDisabled: boolean;
  readonly userDisabled: boolean;
  readonly active: boolean;
  /** #1725: module declares host-rendered on/off switches, reachable at /api/modules/:id/preferences. */
  readonly hasPreferences: boolean;
  /**
   * #1759: module declares credential slots at user scope, reachable at
   * /api/me/modules/:id/credentials. A module can have these and no switches at all — Finance is
   * exactly that — so the personal settings page needs its own reason to be reachable.
   */
  readonly hasUserCredentials: boolean;
  /**
   * #1945: whether this module is visible only to the person who built it, or on for everyone.
   * Always `"everyone"` for a built-in module. For an external module this reflects real
   * install-state (`"you"` while still a draft, `"everyone"` once shipped or admin-enabled).
   */
  readonly scope: "you" | "everyone";
}

/**
 * #1757: a preference value as it crosses the API. `null` belongs to integer preferences and
 * means the user has left the number unset — never zero, never "use the default".
 */
export type ModulePreferenceValue = boolean | number | null;

/** #1725: one declared setting, joined to the actor's stored value (or the manifest default). */
export interface ModulePreferenceDto {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly type: "boolean" | "integer";
  readonly default: ModulePreferenceValue;
  readonly value: ModulePreferenceValue;
  /** #1757: inclusive bounds for an integer preference; null on a switch and when undeclared. */
  readonly min: number | null;
  readonly max: number | null;
}

export interface ListModulePreferencesResponse {
  readonly preferences: readonly ModulePreferenceDto[];
}

export interface UpdateModulePreferencesResponse {
  readonly preferences: Readonly<Record<string, ModulePreferenceValue>>;
}

export interface ListAdminModulesResponse {
  readonly modules: readonly AdminModuleDto[];
}

export interface ListMyModulesResponse {
  readonly modules: readonly MyModuleDto[];
}

export interface PatchModuleEnablementRequest {
  readonly disabled: boolean;
}

const lifecycleEnum = {
  type: "string",
  enum: ["required", "optional", "user-toggleable", "workspace-toggleable"]
} as const;

const adminModuleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "version",
    "lifecycle",
    "required",
    "supportsUserDisable",
    "instanceDisabled"
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    lifecycle: lifecycleEnum,
    required: { type: "boolean" },
    supportsUserDisable: { type: "boolean" },
    instanceDisabled: { type: "boolean" }
  }
} as const;

const myModuleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "version",
    "lifecycle",
    "required",
    "supportsUserDisable",
    "instanceDisabled",
    "userDisabled",
    "active",
    "hasPreferences",
    "hasUserCredentials",
    "scope"
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    lifecycle: lifecycleEnum,
    required: { type: "boolean" },
    supportsUserDisable: { type: "boolean" },
    instanceDisabled: { type: "boolean" },
    userDisabled: { type: "boolean" },
    active: { type: "boolean" },
    hasPreferences: { type: "boolean" },
    hasUserCredentials: { type: "boolean" },
    scope: { type: "string", enum: ["you", "everyone"] }
  }
} as const;

export const adminModuleParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string" } }
} as const;

export const listAdminModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["modules"],
      properties: { modules: { type: "array", items: adminModuleSchema } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const listMyModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["modules"],
      properties: { modules: { type: "array", items: myModuleSchema } }
    },
    401: errorResponseSchema
  }
} as const;

export const patchModuleEnablementRouteSchema = {
  params: adminModuleParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["disabled"],
    properties: { disabled: { type: "boolean" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["module"],
      properties: { module: { ...myModuleSchema } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;

// #917: external-module admin surface contracts. ExternalModuleDto is field-identical to
// module-registry's ReconciledExternalModule (same 8 readonly fields) so the composition
// root can hand reconcile output straight through the injected port without a mapper.
export interface ExternalModuleDto {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly status: "discovered" | "enabled" | "disabled" | "draft";
  readonly active: boolean;
  readonly drifted: boolean;
  readonly disabledReason: string | null;
  /** #918: web contribution declaration, null when the module declares none. */
  readonly web: ModuleWebDto | null;
}

/** Web contribution surface of an external module (#918). Mirrors platform-api.ts's copy. */
export interface ModuleWebDto {
  readonly entrypoint: string;
  readonly contractVersion: number;
}

export interface ExternalModuleRejectionDto {
  readonly id: string;
  readonly reason: string;
}

export interface ListExternalModulesResponse {
  readonly enabled: boolean;
  readonly modules: readonly ExternalModuleDto[];
  readonly rejected: readonly ExternalModuleRejectionDto[];
}

export interface SetExternalModuleEnablementRequest {
  readonly enabled: boolean;
}

const moduleWebSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entrypoint", "contractVersion"],
  properties: {
    entrypoint: { type: "string" },
    contractVersion: { type: "integer" }
  }
} as const;

const externalModuleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "version",
    "publisher",
    "status",
    "active",
    "drifted",
    "disabledReason",
    "web"
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    publisher: { type: "string" },
    status: { type: "string", enum: ["discovered", "enabled", "disabled"] },
    active: { type: "boolean" },
    drifted: { type: "boolean" },
    disabledReason: { type: ["string", "null"] },
    // #918: field-identical mirror of ModuleWebDto — nullable via type array
    // (declaration is present-or-absent at the manifest level, never partial).
    web: { ...moduleWebSchema, type: ["object", "null"] }
  }
} as const;

const externalModuleRejectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "reason"],
  properties: { id: { type: "string" }, reason: { type: "string" } }
} as const;

export const listExternalModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "modules", "rejected"],
      properties: {
        enabled: { type: "boolean" },
        modules: { type: "array", items: externalModuleSchema },
        rejected: { type: "array", items: externalModuleRejectionSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const setExternalModuleEnablementRouteSchema = {
  params: adminModuleParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: { enabled: { type: "boolean" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["module"],
      properties: { module: { ...externalModuleSchema } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

// #1752: admin-triggered rescan of the modules directory on disk. No request body; the caller
// just needs to know the rescan was accepted.
export const rescanExternalModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

// #1753 Task 10: shipping only flips the database row (draft -> enabled, owner cleared).
// Making the now-enabled module visible to everyone else still needs the restart a person
// performs — restartRequired always true, mirrored back so the caller can say so plainly.
export const shipExternalModuleRouteSchema = {
  params: adminModuleParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["shipped", "restartRequired"],
      properties: {
        shipped: { type: "boolean" },
        restartRequired: { type: "boolean" }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

// #1890: throwing a draft away. One answer shape whether or not anything was on disk — the
// endpoint either deleted the caller's own draft or it 404s, and the 404 deliberately cannot be
// told apart from "that is a shipped module" or "that draft is someone else's" (see
// deleteExternalModuleDraft's doc-comment for why).
export const deleteExternalModuleDraftRouteSchema = {
  params: adminModuleParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deleted"],
      properties: { deleted: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

// #918: module-credential admin/user surface contracts. ModuleCredentialStatusDto is
// METADATA ONLY by construction — there is no field that could carry plaintext or the
// ciphertext envelope, and the strict response schema below (additionalProperties: false)
// silently strips any accidentally emitted extra field (the fast-json-stringify trap
// works FOR us here — see docs/superpowers/handoffs for the recurring gotcha).
export interface ModuleCredentialStatusDto {
  readonly credentialId: string;
  readonly displayName: string;
  readonly scope: "instance" | "user";
  readonly configured: boolean;
  readonly updatedAt: string | null;
}

export interface ListModuleCredentialsResponse {
  readonly moduleId: string;
  readonly credentials: readonly ModuleCredentialStatusDto[];
  /**
   * #1759: user surface only — true when this module also declares instance-scope slots that
   * only an admin can fill. It lets the user's own settings page say so in plain words instead
   * of leaving a silent gap where half the module's configuration lives. It is a fact about the
   * manifest, not about the instance's stored secrets: no value, and not even "configured", is
   * exposed. Absent on the admin surface.
   */
  readonly instanceManaged?: boolean;
}

export interface SetModuleCredentialRequest {
  readonly value: string;
}

const moduleCredentialStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["credentialId", "displayName", "scope", "configured", "updatedAt"],
  properties: {
    credentialId: { type: "string" },
    displayName: { type: "string" },
    scope: { type: "string", enum: ["instance", "user"] },
    configured: { type: "boolean" },
    updatedAt: { type: ["string", "null"] }
  }
} as const;

const moduleCredentialParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moduleId", "credentialId"],
  properties: {
    moduleId: { type: "string", minLength: 1, maxLength: 100 },
    credentialId: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

export const listModuleCredentialsRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: { moduleId: { type: "string", minLength: 1, maxLength: 100 } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["moduleId", "credentials"],
      properties: {
        moduleId: { type: "string" },
        credentials: { type: "array", items: moduleCredentialStatusSchema },
        // #1759: optional, not required — the admin surface omits it entirely.
        instanceManaged: { type: "boolean" }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const setModuleCredentialRouteSchema = {
  params: moduleCredentialParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string", minLength: 1, maxLength: 4096 } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credential"],
      properties: { credential: moduleCredentialStatusSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const revokeModuleCredentialRouteSchema = {
  params: moduleCredentialParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credential"],
      properties: { credential: moduleCredentialStatusSchema }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

// ── Module registry / distribution (#964) ───────────────────────────────────
// Admin surface for the pinned module registry. States mirror spec §8 exactly.

export const MODULE_REGISTRY_LIFECYCLE_STATES = [
  "not-installed",
  "pending-restart",
  "installed-enabled",
  "installed-disabled",
  "update-available",
  "update-pending-restart",
  "install-failed",
  "declared-not-present",
  "incompatible"
] as const;

export type ModuleRegistryLifecycleState = (typeof MODULE_REGISTRY_LIFECYCLE_STATES)[number];

export interface ModuleRegistryToolDto {
  readonly name: string;
  readonly risk: string;
}

/** Capability block shown in the pre-download confirm dialog (spec §8). */
export interface ModuleRegistryCapabilitiesDto {
  readonly permissions: readonly string[];
  readonly fetchHosts: readonly string[];
  readonly tools: readonly ModuleRegistryToolDto[];
  readonly ownsTables: readonly string[];
}

export interface ModuleRegistryRowDto {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: ModuleRegistryLifecycleState;
  /** Version loaded at boot (null when not installed or not yet loaded). */
  readonly installedVersion: string | null;
  /** Latest version in the registry index (null when the id is local-only). */
  readonly latestVersion: string | null;
  readonly stagedVersion: string | null;
  /** Index compat range, for the "requires Moss ≥ X" copy on incompatible rows. */
  readonly requiresCore: string | null;
  /** null when the module is not in the registry index. */
  readonly capabilities: ModuleRegistryCapabilitiesDto | null;
  readonly lastInstallError: string | null;
  /** True while a purge is pending next boot; the UI hides Download and offers Cancel. */
  readonly purgePending: boolean;
}

export interface GetModuleRegistryResponse {
  readonly enabled: boolean;
  readonly registryUnavailable: boolean;
  readonly modules: readonly ModuleRegistryRowDto[];
}

export interface DownloadExternalModuleRequest {
  readonly version?: string;
}

export interface RemoveExternalModuleRequest {
  readonly purgeData: boolean;
}

const moduleRegistryToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "risk"],
  properties: { name: { type: "string" }, risk: { type: "string" } }
} as const;

const moduleRegistryCapabilitiesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["permissions", "fetchHosts", "tools", "ownsTables"],
  properties: {
    permissions: { type: "array", items: { type: "string" } },
    fetchHosts: { type: "array", items: { type: "string" } },
    tools: { type: "array", items: moduleRegistryToolSchema },
    ownsTables: { type: "array", items: { type: "string" } }
  }
} as const;

const moduleRegistryRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "description",
    "state",
    "installedVersion",
    "latestVersion",
    "stagedVersion",
    "requiresCore",
    "capabilities",
    "lastInstallError",
    "purgePending"
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    state: { type: "string", enum: MODULE_REGISTRY_LIFECYCLE_STATES },
    installedVersion: { type: ["string", "null"] },
    latestVersion: { type: ["string", "null"] },
    stagedVersion: { type: ["string", "null"] },
    requiresCore: { type: ["string", "null"] },
    // Nullable via type array, same pattern as externalModuleSchema.web (#918).
    capabilities: { ...moduleRegistryCapabilitiesSchema, type: ["object", "null"] },
    lastInstallError: { type: ["string", "null"] },
    purgePending: { type: "boolean" }
  }
} as const;

export const getModuleRegistryRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { refresh: { type: "string", enum: ["1"] } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "registryUnavailable", "modules"],
      properties: {
        enabled: { type: "boolean" },
        registryUnavailable: { type: "boolean" },
        modules: { type: "array", items: moduleRegistryRowSchema }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

const moduleRegistryRowResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["module"],
  properties: { module: { ...moduleRegistryRowSchema } }
} as const;

export const downloadExternalModuleRouteSchema = {
  params: adminModuleParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    properties: { version: { type: "string", minLength: 1, maxLength: 100 } }
  },
  response: {
    200: moduleRegistryRowResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
    502: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export const removeExternalModuleRouteSchema = {
  params: adminModuleParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["purgeData"],
    properties: { purgeData: { type: "boolean" } }
  },
  response: {
    200: moduleRegistryRowResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const cancelExternalModulePurgeRouteSchema = {
  params: adminModuleParamsSchema,
  response: {
    200: moduleRegistryRowResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;
