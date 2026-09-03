import { errorResponseSchema } from "./schema-fragments.js";

// ---------------------------------------------------------------------------
// Onboarding (Phase 2 primary-user onboarding). See
// docs/superpowers/specs/2026-06-12-p2-primary-user-onboarding-design.md
// NOTE: the multiplexer onboarding STEP was removed in v0.1.3 (containerized
// deploy forces tmux, so the step was pure noise). The admin chat.multiplexer
// setting (platform-api ChatMultiplexerChoice) is a SEPARATE surface and stays.
// ---------------------------------------------------------------------------

/** Single, unambiguous onboarding lifecycle state (replaces two booleans). */
export type OnboardingState = "pending" | "completed" | "skipped";

export type OnboardingProviderKind = "anthropic" | "openai-compatible" | "google";

/**
 * Persisted provider install/login lifecycle state (#342, RPC contract §9.1/§9.2).
 *
 * ADDITIVE to this module — it does NOT modify the transient probe enum
 * {@link OnboardingProviderCheckStatus} (which stays the presence/auth probe shape so
 * existing routes + schemas are untouched). This is the persisted superset that adds the
 * lifecycle states `installing` + `installed` the presence-only probe cannot express:
 *
 *   not_installed → installing → installed → needs_login → ready   (+ error, recoverable)
 *
 * Phase 1 only freezes the enum + the optional DTO field below; the backing table
 * (app.provider_install_state) and the install/login services that write it are Phase 2/3.
 * State lives in the settings/onboarding module (module isolation), never in @moss/chat
 * or the token registry. NOTE: `multiplexer_unavailable` is intentionally ABSENT here — it
 * is a transient cli-runner-wide probe condition, not a per-provider lifecycle state, so it
 * stays only in {@link OnboardingProviderCheckStatus}.
 */
export type ProviderInstallState =
  | "not_installed"
  | "installing"
  | "installed"
  | "needs_login"
  | "ready"
  | "error";

export interface OnboardingCliProviderDto {
  readonly kind: OnboardingProviderKind;
  /** Presence-only: the binary is on PATH. NOT a claim of authentication. */
  readonly cliPresent: boolean;
  /**
   * OPTIONAL persisted install/login lifecycle state (#342, §9.2). Absent on the Phase-1
   * presence-only path (today's surface, byte-for-byte unchanged); populated once the
   * Phase-2 install/login services persist app.provider_install_state. Optional ⇒ no schema
   * break (the JSON-schema property below is non-required).
   */
  readonly installState?: ProviderInstallState;
  /**
   * #365 (additive): the provider is in the catalog `supported` install set, so the wizard offers a
   * Connect button. Absent/false ⇒ the card renders a non-blocking "not available" state (e.g. agy/
   * google = `blocked`). Optional ⇒ no schema break; present only when the install seam is wired.
   */
  readonly installable?: boolean;
}

export interface OnboardingProviderCheckRequest {
  readonly providerKind: OnboardingProviderKind;
}

export type OnboardingProviderCheckStatus =
  | "ready"
  | "needs_login"
  | "not_installed"
  | "multiplexer_unavailable"
  | "error";

export interface OnboardingProviderCheckResponse {
  readonly status: OnboardingProviderCheckStatus;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// #365 provider-connect: the request/response contract the WEB CLIENT uses to drive the
// existing install/login routes (the routes own their own response schemas in
// packages/settings/src/onboarding-routes.ts; these mirror those shapes for the browser,
// which validates nothing — only the request schemas below are exported for completeness).
// ---------------------------------------------------------------------------

export interface OnboardingProviderInstallRequest {
  readonly providerKind: OnboardingProviderKind;
}

export interface OnboardingProviderInstallResponse {
  readonly providerKind: OnboardingProviderKind;
  readonly installState: ProviderInstallState;
  readonly version?: string;
  readonly message?: string;
  readonly alreadyInstalled?: boolean;
}

/** The login FLOW status the cli-runner reports (login-contract §L.2.1). */
export type ProviderLoginFlowStatus =
  | "awaiting_authorization"
  | "awaiting_token"
  | "ready"
  | "error";

export interface OnboardingProviderLoginBeginRequest {
  readonly providerKind: OnboardingProviderKind;
  /**
   * #2205: the Settings → AI provider row the user clicked "Log in" on. On `ready` the server
   * reuses (and reactivates, if disabled) THAT config instead of creating a duplicate. Absent from
   * the onboarding wizard, which has no row yet.
   */
  readonly providerConfigId?: string;
}

export interface OnboardingProviderLoginPollRequest {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  /** #2205: see {@link OnboardingProviderLoginBeginRequest.providerConfigId}. */
  readonly providerConfigId?: string;
}

export interface OnboardingProviderLoginSubmitTokenRequest {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  /** The pasted authorization code — AUTH MATERIAL: forwarded only, never logged/echoed. */
  readonly token: string;
  /** #2205: see {@link OnboardingProviderLoginBeginRequest.providerConfigId}. */
  readonly providerConfigId?: string;
}

export interface OnboardingProviderLoginResponse {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  readonly status: ProviderLoginFlowStatus;
  /** Only the allowlisted authorization URL to DISPLAY (never logged). */
  readonly authorizationUrl?: string;
  /** Only the allowlisted device/pairing code to DISPLAY (never logged). */
  readonly userCode?: string;
  readonly installState: ProviderInstallState;
  readonly message?: string;
}

export interface OnboardingCliAuthStepDto {
  /** Documented floor: done ⇔ at least one provider CLI is PRESENT (presence ≠ authed). */
  readonly done: boolean;
  readonly providers: readonly OnboardingCliProviderDto[];
}

export interface OnboardingConnectorStepDto {
  readonly done: boolean;
}

export interface OnboardingStepsDto {
  readonly cliAuth: OnboardingCliAuthStepDto;
  readonly connectors: OnboardingConnectorStepDto;
}

// --- Phase 4: role-tagged onboarding status. The "founder" variant is the Phase-2
//     shape (instance-global provisioning, keyed on the OnboardingState lifecycle); the
//     "member" variant is per-user (one row in app.member_onboarding). Consumers narrow on
//     `role` before touching variant-specific fields. ---

export interface OnboardingFounderStatus {
  readonly role: "founder";
  readonly state: OnboardingState;
  readonly steps: OnboardingStepsDto;
}

/**
 * Member step flags are DERIVED CLIENT-SIDE from the connectors / AI modules' own public
 * endpoints (module isolation — packages/settings never reads another module's tables).
 * The server returns neutral `false` defaults; the member wizard fills them in.
 */
export interface OnboardingMemberStepFlags {
  readonly apiKeyOptOut: { readonly done: boolean };
  readonly connectors: { readonly done: boolean };
}

export interface OnboardingMemberStatus {
  readonly role: "member";
  readonly completed: boolean;
  readonly steps: OnboardingMemberStepFlags;
}

export type OnboardingStatusResponse = OnboardingFounderStatus | OnboardingMemberStatus;

export interface OnboardingStateResponse {
  readonly state: OnboardingState;
}

/**
 * Phase 4: the member complete/skip response. A member's onboarding has no separate
 * "skipped" lifecycle (skip == terminal "onboarded"), so the response carries a single
 * `completed` boolean — distinct from the founder's instance-global `{ state }` shape.
 */
export interface OnboardingMemberCompleteResponse {
  readonly completed: boolean;
}

export type OnboardingCompleteResponse = OnboardingStateResponse | OnboardingMemberCompleteResponse;

// Phase 4: the founder branch is the unchanged Phase-2 shape with a `role` discriminant.
const onboardingFounderStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role", "state", "steps"],
  properties: {
    role: { type: "string", enum: ["founder"] },
    state: { type: "string", enum: ["pending", "completed", "skipped"] },
    steps: {
      type: "object",
      additionalProperties: false,
      required: ["cliAuth", "connectors"],
      properties: {
        cliAuth: {
          type: "object",
          additionalProperties: false,
          required: ["done", "providers"],
          properties: {
            done: { type: "boolean" },
            providers: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "cliPresent"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["anthropic", "openai-compatible", "google"]
                  },
                  cliPresent: { type: "boolean" },
                  // #342 §9.2: optional persisted install/login lifecycle state.
                  // Non-required ⇒ additionalProperties:false stays safe (the field is
                  // declared, so a present value validates; an absent value is fine).
                  installState: {
                    type: "string",
                    enum: [
                      "not_installed",
                      "installing",
                      "installed",
                      "needs_login",
                      "ready",
                      "error"
                    ]
                  },
                  // #365: optional catalog installability (the `supported` set). Additive,
                  // non-required — the wizard offers Connect only for installable providers.
                  installable: { type: "boolean" }
                }
              }
            }
          }
        },
        connectors: {
          type: "object",
          additionalProperties: false,
          required: ["done"],
          properties: { done: { type: "boolean" } }
        }
      }
    }
  }
} as const;

// Phase 4: the member branch — per-user completion + client-derived step flags.
const onboardingMemberStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role", "completed", "steps"],
  properties: {
    role: { type: "string", enum: ["member"] },
    completed: { type: "boolean" },
    steps: {
      type: "object",
      additionalProperties: false,
      required: ["apiKeyOptOut", "connectors"],
      properties: {
        apiKeyOptOut: {
          type: "object",
          additionalProperties: false,
          required: ["done"],
          properties: { done: { type: "boolean" } }
        },
        connectors: {
          type: "object",
          additionalProperties: false,
          required: ["done"],
          properties: { done: { type: "boolean" } }
        }
      }
    }
  }
} as const;

const onboardingStatusResponseSchema = {
  oneOf: [onboardingFounderStatusSchema, onboardingMemberStatusSchema]
} as const;

const onboardingProviderCheckRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind"],
  properties: {
    providerKind: {
      type: "string",
      enum: ["anthropic", "openai-compatible", "google"]
    }
  }
} as const;

// #365: request schemas for the install/login routes. The web client does not validate
// responses; these are exported so the contract has a single canonical declaration. The
// provider enum + bounds mirror packages/settings/src/onboarding-routes.ts exactly.
const ONBOARDING_PROVIDER_KIND_ENUM = ["anthropic", "openai-compatible", "google"] as const;

export const onboardingProviderInstallRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind"],
  properties: {
    providerKind: { type: "string", enum: ONBOARDING_PROVIDER_KIND_ENUM }
  }
} as const;

export const onboardingProviderLoginBeginRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind"],
  properties: {
    providerKind: { type: "string", enum: ONBOARDING_PROVIDER_KIND_ENUM }
  }
} as const;

export const onboardingProviderLoginPollRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "loginId"],
  properties: {
    providerKind: { type: "string", enum: ONBOARDING_PROVIDER_KIND_ENUM },
    loginId: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

export const onboardingProviderLoginSubmitTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "loginId", "token"],
  properties: {
    providerKind: { type: "string", enum: ONBOARDING_PROVIDER_KIND_ENUM },
    loginId: { type: "string", minLength: 1, maxLength: 200 },
    // AUTH MATERIAL: bounded; never logged/persisted/echoed.
    token: { type: "string", minLength: 1, maxLength: 4096 }
  }
} as const;

const onboardingProviderCheckResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["ready", "needs_login", "not_installed", "multiplexer_unavailable", "error"]
    },
    message: { type: "string" }
  }
} as const;

const onboardingStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { type: "string", enum: ["pending", "completed", "skipped"] }
  }
} as const;

// Phase 4: the member complete/skip response — a single `completed` boolean.
const onboardingMemberCompleteResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["completed"],
  properties: {
    completed: { type: "boolean" }
  }
} as const;

// Phase 4: complete/skip now serve BOTH the founder `{ state }` shape and the member
// `{ completed }` shape, branched on role inside the handler. The response is validated
// against this role-tagged-by-shape union (each variant keeps additionalProperties:false).
const onboardingCompleteResponseSchema = {
  oneOf: [onboardingStateResponseSchema, onboardingMemberCompleteResponseSchema]
} as const;

export const getOnboardingStatusRouteSchema = {
  response: {
    200: onboardingStatusResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const onboardingProviderCheckRouteSchema = {
  body: onboardingProviderCheckRequestSchema,
  response: {
    200: onboardingProviderCheckResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const onboardingCompleteRouteSchema = {
  response: {
    200: onboardingCompleteResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const onboardingSkipRouteSchema = {
  response: {
    200: onboardingCompleteResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
