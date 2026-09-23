import { errorResponseSchema } from "./schema-fragments.js";

/**
 * Contracts for the Trail Marker Mac companion (#2560). The companion credential
 * minted here is NOT a browser or CLI session: it is accepted only by
 * `/api/companion/*` and authorizes account identity plus this device's own
 * connection. Never widen these contracts to carry task, chat, file or admin data.
 */
export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_CREDENTIAL_PREFIX = "tm1_" as const;

/** Product name Moss shows for a linked Mac. */
export const COMPANION_PRODUCT_NAME = "Trail Marker for Mac" as const;

/** Browser path the app opens for explicit account approval. */
export const COMPANION_APPROVAL_PATH = "/link/trail-marker" as const;

/** A pairing attempt is redeemable for ten minutes, then it is deleted. */
export const COMPANION_PAIR_ATTEMPT_TTL_SECONDS = 600;

/** How often the app polls redeem while the browser decides. */
export const COMPANION_PAIR_POLL_INTERVAL_SECONDS = 3;

export interface CompanionProtocolResponse {
  readonly product: "moss";
  readonly companionProtocol: 1;
}

export interface CreatePairAttemptRequest {
  readonly deviceName: string;
  readonly platform: "macos";
  readonly appVersion: string;
  readonly osVersion: string;
  /** base64url sha256 of the app's verifier; the raw verifier never leaves the Mac until redeem. */
  readonly verifierHash: string;
}

export interface CreatePairAttemptResponse {
  readonly attemptId: string;
  readonly approvalPath: string;
  readonly pollIntervalSeconds: number;
  readonly expiresAt: string;
}

export interface PairAttemptSummaryResponse {
  readonly deviceName: string;
  readonly status: "pending" | "approved" | "denied";
}

export interface DecidePairAttemptRequest {
  readonly code: string;
  readonly decision: "approve" | "deny";
}

export interface DecidePairAttemptResponse {
  readonly status: "approved" | "denied";
}

export interface RedeemPairAttemptRequest {
  readonly attemptId: string;
  readonly verifier: string;
}

export interface RedeemPairAttemptResponse {
  /** Returned exactly once, in this response body, over TLS. The server keeps only its hash. */
  readonly credential: string;
  readonly device: { readonly id: string; readonly displayName: string };
  readonly account: { readonly name: string; readonly email: string };
  readonly expiresAt: string;
}

/**
 * Every non-issuing redeem outcome. `unknown` covers both a nonexistent attempt
 * and a wrong verifier, so a leaked public attempt id reveals nothing.
 */
export type RedeemPairAttemptStatus = "pending" | "denied" | "expired" | "redeemed" | "unknown";

export interface RedeemPairAttemptPending {
  readonly status: RedeemPairAttemptStatus;
}

export interface CompanionHeartbeatRequest {
  readonly appVersion: string;
  readonly osVersion: string;
}

export interface CompanionHeartbeatResponse {
  readonly device: { readonly id: string; readonly displayName: string };
  readonly account: { readonly name: string; readonly email: string };
  readonly serverTime: string;
  readonly expiresAt: string;
}

export interface RenameCompanionDeviceRequest {
  readonly displayName: string;
}

export interface RenameCompanionDeviceResponse {
  readonly device: { readonly id: string; readonly displayName: string };
}

export type CompanionErrorCode =
  | "companion_credential_invalid"
  | "account_pending_approval"
  | "account_deactivated"
  | "pair_attempt_not_pending"
  | "invalid_origin"
  | "focus_not_ready"
  | "focus_no_block";

const DEVICE_NAME_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  // Plain text only. Control characters would corrupt the Active sessions list and any
  // diagnostic output that echoes a device name.
  pattern: "^[^\\u0000-\\u001f\\u007f]+$"
} as const;

const VERSION_STRING_SCHEMA = { type: "string", minLength: 1, maxLength: 32 } as const;

/** base64url sha256 digest: 43 characters, no padding. */
const BASE64URL_SHA256_SCHEMA = {
  type: "string",
  pattern: "^[A-Za-z0-9_-]{43}$"
} as const;

const UUID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
} as const;

const APPROVAL_CODE_SCHEMA = { type: "string", minLength: 16, maxLength: 64 } as const;

const DEVICE_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "displayName"],
  properties: { id: { type: "string" }, displayName: { type: "string" } }
} as const;

const ACCOUNT_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "email"],
  properties: { name: { type: "string" }, email: { type: "string" } }
} as const;

export const companionProtocolRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["product", "companionProtocol"],
      properties: {
        product: { type: "string", enum: ["moss"] },
        companionProtocol: { type: "number", enum: [COMPANION_PROTOCOL_VERSION] }
      }
    }
  }
} as const;

export const createPairAttemptRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["deviceName", "platform", "appVersion", "osVersion", "verifierHash"],
    properties: {
      deviceName: DEVICE_NAME_SCHEMA,
      platform: { type: "string", enum: ["macos"] },
      appVersion: VERSION_STRING_SCHEMA,
      osVersion: VERSION_STRING_SCHEMA,
      verifierHash: BASE64URL_SHA256_SCHEMA
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["attemptId", "approvalPath", "pollIntervalSeconds", "expiresAt"],
      properties: {
        attemptId: { type: "string" },
        approvalPath: { type: "string" },
        pollIntervalSeconds: { type: "number" },
        expiresAt: { type: "string" }
      }
    },
    400: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export const getPairAttemptRouteSchema = {
  // The code travels in the body, never the URL. Fastify logs every request URL, so a
  // query parameter would write a live approval secret into ordinary server logs.
  body: {
    type: "object",
    additionalProperties: false,
    required: ["code"],
    properties: { code: APPROVAL_CODE_SCHEMA }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deviceName", "status"],
      properties: {
        deviceName: { type: "string" },
        status: { type: "string", enum: ["pending", "approved", "denied"] }
      }
    },
    401: errorResponseSchema,
    // 404: unknown or expired code. Indistinguishable on purpose.
    404: errorResponseSchema
  }
} as const;

export const decidePairAttemptRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["code", "decision"],
    properties: {
      code: APPROVAL_CODE_SCHEMA,
      decision: { type: "string", enum: ["approve", "deny"] }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["approved", "denied"] } }
    },
    401: errorResponseSchema,
    // 403: missing or foreign Origin header (cross-site request forgery guard).
    403: errorResponseSchema,
    404: errorResponseSchema,
    // 409: the attempt was already decided or redeemed.
    409: errorResponseSchema
  }
} as const;

export const redeemPairAttemptRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["attemptId", "verifier"],
    properties: { attemptId: UUID_SCHEMA, verifier: BASE64URL_SHA256_SCHEMA }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credential", "device", "account", "expiresAt"],
      properties: {
        credential: { type: "string" },
        device: DEVICE_SUMMARY_SCHEMA,
        account: ACCOUNT_SUMMARY_SCHEMA,
        expiresAt: { type: "string" }
      }
    },
    202: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["pending"] } }
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    410: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export const cancelPairAttemptRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["attemptId", "verifier"],
    properties: { attemptId: UUID_SCHEMA, verifier: BASE64URL_SHA256_SCHEMA }
  },
  response: {
    204: { type: "null" },
    400: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export const companionHeartbeatRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["appVersion", "osVersion"],
    properties: { appVersion: VERSION_STRING_SCHEMA, osVersion: VERSION_STRING_SCHEMA }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["device", "account", "serverTime", "expiresAt"],
      properties: {
        device: DEVICE_SUMMARY_SCHEMA,
        account: ACCOUNT_SUMMARY_SCHEMA,
        serverTime: { type: "string" },
        expiresAt: { type: "string" }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const renameCompanionDeviceRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["displayName"],
    properties: { displayName: DEVICE_NAME_SCHEMA }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["device"],
      properties: { device: DEVICE_SUMMARY_SCHEMA }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const companionLogoutRouteSchema = {
  response: {
    204: { type: "null" },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

/**
 * Focus judgment (#2570). While a Moss-created calendar block is on, the Mac reports which app is
 * in front and a short, already-redacted window title. Moss judges it against the block and says
 * whether to nudge. Nothing here carries an image, a person id, or a model or provider name.
 */
export type FocusLabel = "focused" | "necessary_detour" | "distracted" | "insufficient_evidence";

export const FOCUS_LABELS = [
  "focused",
  "necessary_detour",
  "distracted",
  "insufficient_evidence"
] as const satisfies readonly FocusLabel[];

/** Longest reason Moss will store or return. The reason is the one free-text field that is kept. */
export const FOCUS_REASON_MAX_LENGTH = 140;

export interface FocusContextResponse {
  /** The person's current Moss-created calendar block, or null when there is none. */
  readonly block: {
    readonly id: string;
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
  } | null;
  /** An admin has explicitly bound the Trail Marker judgment model. Never defaulted. */
  readonly judgmentReady: boolean;
}

export interface FocusJudgeRequest {
  readonly blockId: string;
  readonly appName: string;
  /** Already shortened and redacted by the Mac. May be empty. */
  readonly windowTitle: string;
  /**
   * Rung 3 (#2570 slice 2): a one- or two-sentence vision description of the foreground window,
   * sent only when the title alone came back insufficient_evidence and the person allowed a
   * capture. Absent otherwise, and absent means exactly what slice 1 always meant.
   */
  readonly description?: string;
  readonly observedAt: string;
}

export interface FocusJudgeResponse {
  readonly judgmentId: string;
  readonly label: FocusLabel;
  readonly reason: string;
  readonly nudge: boolean;
}

export interface FocusCorrectRequest {
  readonly judgmentId: string;
  readonly verdict: "right" | "wrong";
}

// Plain text only: a control character in an app name or window title would corrupt logs and any
// diagnostic output that echoes it.
const FOCUS_APP_NAME_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$"
} as const;

const FOCUS_WINDOW_TITLE_SCHEMA = {
  type: "string",
  minLength: 0,
  maxLength: 200,
  pattern: "^[^\\u0000-\\u001f\\u007f]*$"
} as const;

const FOCUS_DESCRIPTION_SCHEMA = {
  type: "string",
  minLength: 0,
  maxLength: 280,
  pattern: "^[^\\u0000-\\u001f\\u007f]*$"
} as const;

const FOCUS_BLOCK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "startsAt", "endsAt"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    startsAt: { type: "string" },
    endsAt: { type: "string" }
  }
} as const;

export const focusContextRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["block", "judgmentReady"],
      properties: {
        block: { ...FOCUS_BLOCK_SCHEMA, nullable: true },
        judgmentReady: { type: "boolean" }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export const focusJudgeRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["blockId", "appName", "windowTitle", "observedAt"],
    properties: {
      blockId: UUID_SCHEMA,
      appName: FOCUS_APP_NAME_SCHEMA,
      windowTitle: FOCUS_WINDOW_TITLE_SCHEMA,
      description: FOCUS_DESCRIPTION_SCHEMA,
      observedAt: { type: "string", minLength: 1, maxLength: 40 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["judgmentId", "label", "reason", "nudge"],
      properties: {
        judgmentId: { type: "string" },
        label: { type: "string", enum: [...FOCUS_LABELS] },
        reason: { type: "string", maxLength: FOCUS_REASON_MAX_LENGTH },
        nudge: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    // 409: focus_not_ready (no judgment model bound) or focus_no_block (not the person's
    // current Moss block). Nothing is stored in either case.
    409: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export const focusCorrectRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["judgmentId", "verdict"],
    properties: {
      judgmentId: UUID_SCHEMA,
      verdict: { type: "string", enum: ["right", "wrong"] }
    }
  },
  response: {
    204: { type: "null" },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    // 404: no such judgment for this person. Absent and someone else's are indistinguishable.
    404: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;
