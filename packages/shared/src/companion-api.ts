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
  /** Independent recording proof requested as part of this connection, never inferred. */
  readonly recordingProofHash?: string;
  readonly recordingPolicyVersion?: 1;
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
  readonly recordingPolicyVersion?: 1;
}

export interface DecidePairAttemptRequest {
  readonly code: string;
  readonly decision: "approve" | "deny";
  readonly recordingPolicyVersion?: 1;
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
  readonly recordingCapability?: { readonly policyVersion: 1; readonly revision: number };
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
  /**
   * Backtrack phase 2a (plan 2026-10-03-backtrack-phase2.md §4.4, Q7): whether this Moss stores
   * day memory and whether the person has paused it from Moss. Optional so an older Mac or an
   * older server (before Backtrack shipped) keep working — the upload response carries the same
   * shape either way.
   */
  readonly backtrack?: BacktrackState;
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
  | "focus_no_block"
  | "backtrack_unavailable"
  | "backtrack_paused"
  | "backtrack_clock";

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

/**
 * Backtrack phase 2a (plan 2026-10-03-backtrack-phase2.md §4.4): whether this Moss stores day
 * memory (the instance switch, decision 1) and whether the person has paused it (decision 6).
 * Declared ahead of {@link companionHeartbeatRouteSchema}, which carries it optionally.
 */
const BACKTRACK_STATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["storage", "paused"],
  properties: {
    storage: { type: "string", enum: ["off", "on"] },
    paused: { type: "boolean" }
  }
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
    dependencies: {
      recordingProofHash: ["recordingPolicyVersion"],
      recordingPolicyVersion: ["recordingProofHash"]
    },
    properties: {
      deviceName: DEVICE_NAME_SCHEMA,
      platform: { type: "string", enum: ["macos"] },
      appVersion: VERSION_STRING_SCHEMA,
      osVersion: VERSION_STRING_SCHEMA,
      verifierHash: BASE64URL_SHA256_SCHEMA,
      recordingProofHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      recordingPolicyVersion: { type: "integer", const: 1 }
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
        status: { type: "string", enum: ["pending", "approved", "denied"] },
        recordingPolicyVersion: { type: "integer", const: 1 }
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
      decision: { type: "string", enum: ["approve", "deny"] },
      recordingPolicyVersion: { type: "integer", const: 1 }
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
        expiresAt: { type: "string" },
        recordingCapability: {
          type: "object",
          additionalProperties: false,
          required: ["policyVersion", "revision"],
          properties: {
            policyVersion: { type: "integer", const: 1 },
            revision: { type: "integer", minimum: 1 }
          }
        }
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
        expiresAt: { type: "string" },
        backtrack: BACKTRACK_STATE_SCHEMA
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
 * whether to nudge. Nothing here carries a person id. #3067: a judge request may carry one
 * screenshot, and the context names the judge model so the Mac can show it in the consent sentence.
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
  /** #3067: the bound judge can read a screenshot directly. False when nothing is bound. */
  readonly judgeTakesImages: boolean;
  /** #3067: the judge's model and provider, e.g. "Clef-flash (Cloudflare)"; null when unbound. */
  readonly judgeName: string | null;
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
  /**
   * #3067: one JPEG of the foreground window as a data URL, for a judge that reads pictures. Sent
   * instead of `description`, never with it. Held only for the request and the one provider call.
   */
  readonly image?: string;
  readonly observedAt: string;
}

/** #3067: the longest image data URL a judge request may carry (1 MiB of text). */
export const FOCUS_IMAGE_MAX_CHARS = 1_048_576;

/** #3067: the judge route's own body limit, the image cap plus room for the rest of the body. */
export const FOCUS_JUDGE_BODY_LIMIT_BYTES = 1_310_720;

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

// A JPEG data URL only. Clef also takes PNG and WebP, but the Mac sends JPEG, and a remote URL
// would make the provider fetch something on the person's behalf.
const FOCUS_IMAGE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: FOCUS_IMAGE_MAX_CHARS,
  pattern: "^data:image/jpeg;base64,[A-Za-z0-9+/=]+$"
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
      required: ["block", "judgmentReady", "judgeTakesImages", "judgeName"],
      properties: {
        block: { ...FOCUS_BLOCK_SCHEMA, nullable: true },
        judgmentReady: { type: "boolean" },
        judgeTakesImages: { type: "boolean" },
        judgeName: { type: "string", nullable: true, maxLength: 200 }
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
      image: FOCUS_IMAGE_SCHEMA,
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
    413: errorResponseSchema,
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

/**
 * Backtrack phase 2a ingest (#2638 plan 2026-10-03-backtrack-phase2.md §4.4). One segment is a
 * contiguous run of screen text the Mac already redacted once on-device; the server redacts
 * again (decision: belt-and-suspenders, never trust the client alone with secrets-never-escape).
 * Every timestamp here is the Mac's own clock — the server never trusts it at face value
 * (decision 10: everything is shifted to server time by the request's measured skew before it is
 * compared to anything, including itself).
 */
export interface BacktrackSegmentUpload {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly appName: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly address?: string;
  readonly body: string;
}

export interface BacktrackUploadRequest {
  /** The Mac's clock when this request left (decision 10) — never reused from an earlier attempt. */
  readonly sentAt: string;
  readonly segments: readonly BacktrackSegmentUpload[];
}

/** Whether this Moss stores Backtrack day memory, and whether the person has paused it. */
export interface BacktrackState {
  readonly storage: "off" | "on";
  readonly paused: boolean;
}

export interface BacktrackUploadResponse {
  readonly accepted: number;
  readonly duplicates: number;
  /** Overlapped a deletion marker (decision 10) — never stored, whatever the Mac's clock. */
  readonly discarded: number;
  /** Outside the accepted time window after shifting to server time (decision 11). */
  readonly rejectedClock: number;
  readonly state: BacktrackState;
}

// Character pre-checks only (ajv counts JS string length, not UTF-8 bytes): the same numeric
// bound as the column's `octet_length` CHECK (packages/backtrack/sql/0282), so anything that
// could possibly be too long in bytes is already too long in characters and is rejected here,
// cheaply, before the route does the exact byte-length check on the (post-redaction) text.
const BACKTRACK_TIMESTAMP_SCHEMA = { type: "string", minLength: 1, maxLength: 40 } as const;
const BACKTRACK_APP_NAME_SCHEMA = { type: "string", minLength: 1, maxLength: 400 } as const;
const BACKTRACK_BUNDLE_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 255 } as const;
const BACKTRACK_WINDOW_TITLE_SCHEMA = { type: "string", minLength: 0, maxLength: 1000 } as const;
const BACKTRACK_ADDRESS_SCHEMA = { type: "string", minLength: 0, maxLength: 2048 } as const;
const BACKTRACK_BODY_SCHEMA = { type: "string", minLength: 0, maxLength: 8192 } as const;

const BACKTRACK_SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["startedAt", "endedAt", "appName", "bundleId", "windowTitle", "body"],
  properties: {
    startedAt: BACKTRACK_TIMESTAMP_SCHEMA,
    endedAt: BACKTRACK_TIMESTAMP_SCHEMA,
    appName: BACKTRACK_APP_NAME_SCHEMA,
    bundleId: BACKTRACK_BUNDLE_ID_SCHEMA,
    windowTitle: BACKTRACK_WINDOW_TITLE_SCHEMA,
    address: BACKTRACK_ADDRESS_SCHEMA,
    body: BACKTRACK_BODY_SCHEMA
  }
} as const;

export const backtrackUploadRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["sentAt", "segments"],
    properties: {
      sentAt: BACKTRACK_TIMESTAMP_SCHEMA,
      // Decision 13: the uploader packs at most 200 segments a request; bodyLimit (2 MiB, set on
      // the route) is the byte-size half of that same decision.
      segments: { type: "array", minItems: 1, maxItems: 200, items: BACKTRACK_SEGMENT_SCHEMA }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["accepted", "duplicates", "discarded", "rejectedClock", "state"],
      properties: {
        accepted: { type: "number" },
        duplicates: { type: "number" },
        discarded: { type: "number" },
        rejectedClock: { type: "number" },
        state: BACKTRACK_STATE_SCHEMA
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    // 409: backtrack_unavailable (the instance switch is off) or backtrack_paused (the person
    // paused recording from Moss). Nothing is stored in either case.
    409: errorResponseSchema,
    413: errorResponseSchema,
    // 422: backtrack_clock — the request's sentAt is too far from when the server received it.
    422: errorResponseSchema,
    429: errorResponseSchema
  }
} as const;

export * from "./companion-recording-api.js";
