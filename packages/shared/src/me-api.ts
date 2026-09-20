import { errorResponseSchema } from "./schema-fragments.js";
import { type UserDto, userSchema } from "./platform-api.js";

export interface ProfilePrefs {
  readonly addressed: string | null;
}

export interface MeResponse {
  readonly user: UserDto;
  readonly profilePrefs: ProfilePrefs;
  /**
   * True when the caller owns an email/password credential
   * (`app.auth_accounts` row with `provider_id = 'credential'` and a non-null
   * `password`). The client uses this to decide whether the self-delete dialog
   * must collect the current password (#239). Existence only — never the hash.
   */
  readonly hasPasswordCredential: boolean;
}

export interface PatchMeProfileRequest {
  readonly name: string;
  readonly addressed: string;
}

export type MeSessionDeviceKind = "laptop" | "desktop" | "phone" | "tablet";

/** Which kind of credential holds this session open. */
export type MeSessionSource = "browser" | "cli" | "companion";

/**
 * What a linked companion app adds to a session row. Present only when source is
 * "companion" (#2560). Carries no credential and no fingerprint of one.
 */
export interface MeSessionCompanionDto {
  readonly product: string;
  readonly displayName: string;
  readonly appVersion: string | null;
  readonly osVersion: string | null;
  readonly lastContactAt: string | null;
}

/**
 * Safe metadata for one of the current user's active sessions. NEVER carries the
 * session token, cookie value, bearer secret, or any token fingerprint (#237).
 * Covers cookie sessions (rich UA/IP metadata), legacy bearer/CLI sessions
 * (minimal metadata — UA/IP null, generic device label), and linked companion
 * devices (#2560).
 */
export interface MeSessionDto {
  readonly id: string;
  readonly isCurrent: boolean;
  readonly createdAt: string;
  /** Derived from the session row's updated_at; falls back to createdAt when absent. */
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceLabel: string;
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceKind: MeSessionDeviceKind;
  readonly source: MeSessionSource;
  /** Non-null only for a linked companion device (#2560). */
  readonly companion: MeSessionCompanionDto | null;
}

export interface ListMySessionsResponse {
  readonly sessions: readonly MeSessionDto[];
}

export interface RevokeMySessionResponse {
  readonly success: boolean;
}

export interface RevokeMyOtherSessionsResponse {
  readonly success: boolean;
  readonly count: number;
}

export interface AdminRevokeSessionsResponse {
  readonly success: boolean;
  readonly count: number;
}

export interface DeleteMyAccountRequest {
  readonly confirmEmail: string;
  readonly confirmPhrase: string;
  /** Required iff the account owns a password credential; ignored otherwise. */
  readonly password?: string;
}

export interface DeleteMyAccountResponse {
  readonly deletedUserId: string;
}

/**
 * The exact, case-sensitive phrase the caller must type to confirm self-delete.
 * Shown verbatim in the Danger-zone dialog. The route compares with strict
 * equality — no normalization (#239 §Locked decision 3).
 */
export const DELETE_MY_ACCOUNT_PHRASE = "DELETE MY ACCOUNT";

export const meRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["user", "profilePrefs", "hasPasswordCredential"],
      properties: {
        user: userSchema,
        profilePrefs: {
          type: "object",
          additionalProperties: false,
          required: ["addressed"],
          properties: {
            addressed: { type: ["string", "null"] }
          }
        },
        hasPasswordCredential: { type: "boolean" }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const patchMeProfileRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["name", "addressed"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      addressed: { type: "string", maxLength: 100 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["user", "profilePrefs"],
      properties: {
        user: userSchema,
        profilePrefs: {
          type: "object",
          additionalProperties: false,
          required: ["addressed"],
          properties: {
            addressed: { type: ["string", "null"] }
          }
        }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

const meSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "isCurrent",
    "createdAt",
    "lastSeenAt",
    "expiresAt",
    "ipAddress",
    "userAgent",
    "deviceLabel",
    "browser",
    "os",
    "deviceKind",
    "source",
    "companion"
  ],
  properties: {
    id: { type: "string" },
    isCurrent: { type: "boolean" },
    createdAt: { type: "string" },
    lastSeenAt: { type: "string" },
    expiresAt: { type: "string" },
    ipAddress: { type: ["string", "null"] },
    userAgent: { type: ["string", "null"] },
    deviceLabel: { type: "string" },
    browser: { type: ["string", "null"] },
    os: { type: ["string", "null"] },
    deviceKind: { type: "string", enum: ["laptop", "desktop", "phone", "tablet"] },
    source: { type: "string", enum: ["browser", "cli", "companion"] },
    companion: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["product", "displayName", "appVersion", "osVersion", "lastContactAt"],
      properties: {
        product: { type: "string" },
        displayName: { type: "string" },
        appVersion: { type: ["string", "null"] },
        osVersion: { type: ["string", "null"] },
        lastContactAt: { type: ["string", "null"] }
      }
    }
  }
} as const;

export const listMySessionsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["sessions"],
      properties: {
        sessions: { type: "array", items: meSessionSchema }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const revokeMySessionRouteSchema = {
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
      required: ["success"],
      properties: { success: { type: "boolean" } }
    },
    401: errorResponseSchema,
    // 404: unknown / cross-user-guessed session id (no existence leak).
    404: errorResponseSchema,
    // 422: refusing to revoke the request's own current session via this surface.
    422: errorResponseSchema
  }
} as const;

export const revokeMyOtherSessionsRouteSchema = {
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
    401: errorResponseSchema
  }
} as const;

/**
 * Self-service account deletion route schema (#239). Two independent
 * confirmation factors (typed email + fixed phrase) plus the current password
 * when the account owns a password credential. Every confirmation failure
 * returns a single generic 400 (no per-factor detail, to avoid aiding a
 * session-hijacking attacker probing which factor is wrong).
 */
export const deleteMyAccountRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["confirmEmail", "confirmPhrase"],
    properties: {
      confirmEmail: { type: "string", minLength: 1, maxLength: 320 },
      confirmPhrase: { type: "string", minLength: 1, maxLength: 100 },
      password: { type: "string", maxLength: 1024 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deletedUserId"],
      properties: {
        deletedUserId: { type: "string" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", enum: ["bootstrap_owner", "last_admin"] }
      }
    },
    429: errorResponseSchema
  }
} as const;
