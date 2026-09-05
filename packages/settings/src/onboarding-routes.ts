import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner, User } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  errorResponseSchema,
  getOnboardingStatusRouteSchema,
  onboardingCompleteRouteSchema,
  onboardingProviderCheckRouteSchema,
  onboardingSkipRouteSchema,
  type OnboardingProviderCheckResponse,
  type OnboardingProviderKind,
  type ProviderLoginScope,
  type ProviderInstallState
} from "@moss/shared";

import type { SettingsRepository } from "./repository.js";
import {
  parseLoginHandleBody,
  parseLoginProviderBody,
  parseLoginSubmitTokenBody,
  parseOnboardingProviderCheckBody,
  parseOnboardingProviderInstallBody
} from "./onboarding-request-parsers.js";

// ---------------------------------------------------------------------------
// §A.5 onboarding install step (#342 Phase 2). The admin-gated install route is
// the SOLE api trigger for the cli-runner `installProvider` verb (install-contract
// §A.5.1). This module (Lane C) owns the route + the A.4 transition ORDER; the
// supply-chain-sensitive pieces it ORCHESTRATES are injected ports, owned by the
// install lane (the catalog/RPC client live in @moss/chat / cli-runner, never
// imported here — settings stays free of a chat dependency for module isolation):
//
//   - {@link ProviderInstallabilityPort}  reads the server-side recipe catalog so
//     a `blocked`/absent provider (agy/google pre-spike) is rejected cleanly with
//     a 400 BEFORE any `installing` row is persisted (install-contract §A.2.3).
//   - {@link ProviderInstallClient}       drives the `installProvider` RPC over the
//     cli-runner socket and returns the TERMINAL outcome (install-contract §A.2.1).
//   - {@link ProviderInstallStateStore}   persists the A.4 transitions under the
//     ADMIN-scoped DataContextDb the route resolves (the 0103 write RLS is
//     `current_actor_is_admin()`).
//
// The cli-runner NEVER writes the table (install-contract §A.4): the api is the
// sole admin-RLS writer; the cli-runner only REPORTS the result over the socket.
// ---------------------------------------------------------------------------

/**
 * The TERMINAL install outcome the install lane reports back to the onboarding route
 * (a structural mirror of the install-contract §A.2.1 `RpcInstallProviderResult`,
 * declared here so settings does NOT import @moss/chat — module isolation). Lane B's
 * composition-root wiring maps the wire result onto this shape.
 */
export interface ProviderInstallOutcome {
  /** "installed" on success (binary present + version-verified), "error" on any failure. */
  readonly state: "installed" | "error";
  /** Installed version once verified. Present iff state === "installed". */
  readonly version?: string;
  /** Redacted (§6.4) detail on "error". Safe to persist into provider_install_state.message. */
  readonly message?: string;
  /** True when the pinned version was already installed + re-verified — a no-op (§A.3.6). */
  readonly alreadyInstalled?: boolean;
  /**
   * #1081 H2: true ONLY when this install call replaced the live binary on disk (a real
   * reinstall), false on an idempotent no-op. The composition root (module-registry) uses
   * this to decide whether to drop+relaunch that provider's live chat sessions — settings
   * itself never touches chat/cli-runner state directly (module isolation), it only
   * surfaces the field on the response for observability.
   */
  readonly binaryChanged?: boolean;
}

/** Catalog installability verdict for a provider (install-contract §A.1/§A.2.3). */
export type ProviderInstallability =
  | { readonly installable: true }
  | { readonly installable: false; readonly blockedReason: string };

/**
 * Reads the server-side recipe catalog (the supply-chain allowlist) WITHOUT persisting
 * anything. A provider whose catalog status is `blocked` (agy/google pre-spike) or that
 * is absent is `installable:false` — the route rejects it with a 400 before persisting
 * `installing`, surfacing the redacted `blockedReason` (install-contract §A.2.3).
 */
export type ProviderInstallabilityPort = (
  provider: OnboardingProviderKind
) => ProviderInstallability;

/**
 * Drives the `installProvider` RPC over the cli-runner socket (the api's
 * `ChatEngineRpcClient`, base §3.5) and returns the terminal outcome. A FAILED install
 * is a normal terminal `{ state:"error" }` outcome, NOT a thrown error (install-contract
 * §A.2.3) — a throw is reserved for an unexpected RPC/transport fault.
 */
export type ProviderInstallClient = (
  provider: OnboardingProviderKind
) => Promise<ProviderInstallOutcome>;

/**
 * Persists the §A.4 install transitions under the ADMIN-scoped DataContextDb the route
 * resolves (0103 write RLS = `current_actor_is_admin()`). Owned by the install lane's
 * state-machine module; injected so onboarding-routes never reaches another module's
 * table directly.
 */
export interface ProviderInstallStateStore {
  /**
   * `* → installing` (install-contract §A.4): persisted BEFORE the RPC. A (re)install
   * may begin from ANY start state — the store upserts `installing` (clearing any prior
   * version/message) so the transition is total over the start states.
   */
  readonly persistInstalling: (
    scopedDb: DataContextDb,
    args: { readonly provider: OnboardingProviderKind; readonly requestId: string }
  ) => Promise<void>;
  /**
   * `installing → installed|error` (install-contract §A.4): persisted AFTER the RPC from
   * the terminal outcome. `message` is the redacted (§6.4) string; on "installed" the
   * verified `version` is recorded.
   */
  readonly persistTerminal: (
    scopedDb: DataContextDb,
    args: {
      readonly provider: OnboardingProviderKind;
      readonly outcome: ProviderInstallOutcome;
      readonly requestId: string;
    }
  ) => Promise<ProviderInstallState>;
}

/**
 * Reconciles + reads the persisted provider install lifecycle for the founder-status
 * resolver (§A.5 step 2 + §A.4.2). Runs INSIDE the admin-scoped DataContextDb the status
 * route resolves (the §A.4.2 correction WRITE needs the 0103 admin write RLS; the probe is
 * the cli-runner `probeProvider`). Implemented by the install lane (composition root): for
 * every persisted row it runs the §A.4.2 stale-`installing` projection over (persisted, fresh
 * probe), persists any correction under the admin actor, and returns the reconciled state per
 * provider. A provider with no row is absent from the map ⇒ `installState` is omitted on the
 * wizard (Phase-1 byte-for-byte surface). Errors are the install lane's concern (fail-soft so
 * a transient probe never breaks the status load).
 */
export type ReconcileInstallStatesPort = (
  scopedDb: DataContextDb
) => Promise<Partial<Record<OnboardingProviderKind, ProviderInstallState>>>;

/** The injected install seam (install-contract §A.5.1). Absent ⇒ the install route fails closed. */
export interface OnboardingInstallDependencies {
  readonly installability: ProviderInstallabilityPort;
  readonly installClient: ProviderInstallClient;
  readonly stateStore: ProviderInstallStateStore;
  /**
   * §A.5 step 2 / §A.4.2: surfaces the persisted (reconciled) install lifecycle on the status
   * load. Absent ⇒ the status route serves the Phase-1 presence-only surface (no `installState`).
   */
  readonly reconcileInstallStates: ReconcileInstallStatesPort;
}

export interface OnboardingProbes {
  /** Provider CLI presence (presence-only). Bounded live probe. */
  readonly cliPresent: (kind: OnboardingProviderKind) => Promise<boolean>;
  /** Explicit provider auth/connection check. Bounded live probe; never run by status. */
  readonly testProviderConnection: (
    kind: OnboardingProviderKind
  ) => Promise<OnboardingProviderCheckResponse>;
  /** Connector-account existence — a scoped read (needs the request's RLS scope). */
  readonly connectorAccountExists: (scopedDb: DataContextDb) => Promise<boolean>;
}

export interface OnboardingRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly onboardingProbes?: OnboardingProbes;
  readonly repository: SettingsRepository;
  readonly requireKnownUser: (scopedDb: DataContextDb, userId: string) => Promise<User>;
  readonly assertBootstrapOwnerAdminUser: (
    scopedDb: DataContextDb,
    userId: string
  ) => Promise<User>;
  readonly requireRequestId: (accessContext: AccessContext) => string;
  readonly handleRouteError: (error: unknown, reply: FastifyReply) => unknown;
  /**
   * The §A.5 install seam. Optional so the route mounts but FAILS CLOSED (500) when the
   * install lane is not wired — mirroring the `onboardingProbes` fail-closed posture. The
   * cli-runner is the only thing that can actually install; absent ⇒ no trigger.
   */
  readonly onboardingInstall?: OnboardingInstallDependencies;
  /**
   * The §L.5 login seam (#342 Phase 3). Optional so the routes mount but FAIL CLOSED (500) when
   * the login lane is not wired (host-dev / no socket) — mirroring `onboardingInstall`. The
   * cli-runner is the only thing that can run a provider login; absent ⇒ no trigger.
   */
  readonly onboardingLogin?: OnboardingLoginDependencies;
}

/** Response for POST /api/onboarding/provider-install — the settled persisted lifecycle state. */
export interface OnboardingProviderInstallResponse {
  readonly providerKind: OnboardingProviderKind;
  readonly installState: ProviderInstallState;
  readonly version?: string;
  readonly message?: string;
  readonly alreadyInstalled?: boolean;
  /** #1081 H2: true only on a real reinstall that replaced the binary; see ProviderInstallOutcome. */
  readonly binaryChanged?: boolean;
}

const onboardingProviderInstallRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind"],
  properties: {
    providerKind: { type: "string", enum: ["anthropic", "openai-compatible", "google"] }
  }
} as const;

const onboardingProviderInstallResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "installState"],
  properties: {
    providerKind: { type: "string", enum: ["anthropic", "openai-compatible", "google"] },
    installState: {
      type: "string",
      enum: ["not_installed", "installing", "installed", "needs_login", "ready", "error"]
    },
    version: { type: "string" },
    message: { type: "string" },
    alreadyInstalled: { type: "boolean" },
    // #1081 fast-json-stringify trap: additionalProperties:false SILENTLY DROPS any field
    // not declared here — binaryChanged (H2) must be listed or it never reaches the client.
    binaryChanged: { type: "boolean" }
  }
} as const;

const onboardingProviderInstallRouteSchema = {
  body: onboardingProviderInstallRequestSchema,
  response: {
    200: onboardingProviderInstallResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema
  }
} as const;

// ---------------------------------------------------------------------------
// §L.5 onboarding login routes (#342 Phase 3, login-contract §L.2/§L.4/§L.5).
// Mirrors the §A.5 install seam: admin-gated routes that drive the cli-runner login
// verbs over the socket and persist the needs_login/ready lifecycle (admin RLS). The
// supply-chain-adjacent pieces are injected PORTS (module isolation — settings never
// imports @moss/chat or @moss/cli-runner). The cli-runner NEVER writes the table.
// ---------------------------------------------------------------------------

/** The login FLOW status the cli-runner reports (login-contract §L.2.1). */
export type ProviderLoginFlowStatus =
  | "awaiting_authorization"
  | "awaiting_token"
  | "ready"
  | "error";

/** A login flow outcome the login lane reports to the route (structural mirror of §L.2.1). */
export interface ProviderLoginOutcome {
  readonly loginId: string;
  readonly status: ProviderLoginFlowStatus;
  /** ONLY the allowlisted authorization URL to DISPLAY (§L.6.2) — the route never LOGS it. */
  readonly authorizationUrl?: string;
  /** ONLY the allowlisted device/pairing code to DISPLAY (§L.6.2) — the route never LOGS it. */
  readonly userCode?: string;
  /** Redacted (§6.4/§L.6.3) detail on "error". Safe to log. */
  readonly message?: string;
}

/** Catalog/adapter loginability verdict for a provider (login-contract §L.1/§L.2.4). */
export type ProviderLoginability =
  | { readonly loginable: true }
  | { readonly loginable: false; readonly blockedReason: string };

/**
 * Reads the server-side login-adapter registry (the auth-flow allowlist) WITHOUT side effects. A
 * provider with no adapter (agy, or codex if its headless smoke failed) is `loginable:false` — the
 * route rejects it 400 BEFORE persisting `needs_login` (login-contract §L.2.4).
 */
export type ProviderLoginabilityPort = (provider: OnboardingProviderKind) => ProviderLoginability;

/**
 * Drives the login verbs over the cli-runner socket (the api's `RpcConnection`, base §3.5). A
 * failed login FLOW is a normal `{ status:"error" }` outcome, NOT a throw (login-contract §L.2.4) —
 * a throw is reserved for an unexpected RPC/transport fault (or a `bad_request` like a stale
 * loginId / a no-adapter provider). The pasted `token` is AUTH MATERIAL (§L.6.3): forwarded ONLY,
 * never logged/persisted/echoed.
 */
export interface ProviderLoginClient {
  readonly begin: (
    provider: OnboardingProviderKind,
    scope?: ProviderLoginScope
  ) => Promise<ProviderLoginOutcome>;
  readonly poll: (
    provider: OnboardingProviderKind,
    loginId: string,
    scope?: ProviderLoginScope
  ) => Promise<ProviderLoginOutcome>;
  readonly submitToken: (
    provider: OnboardingProviderKind,
    loginId: string,
    token: string,
    scope?: ProviderLoginScope
  ) => Promise<ProviderLoginOutcome>;
  readonly cancel: (
    provider: OnboardingProviderKind,
    loginId: string,
    scope?: ProviderLoginScope
  ) => Promise<void>;
}

/** Persists the §L.4 login transitions under the ADMIN-scoped DataContextDb the route resolves. */
export interface ProviderLoginStateStore {
  /**
   * `* → needs_login` (login-contract §L.4.1): persisted BEFORE the begin RPC (collapse — the
   * provider is now actively in login). A no-op if already `needs_login`.
   */
  readonly persistNeedsLogin: (
    scopedDb: DataContextDb,
    args: { readonly provider: OnboardingProviderKind; readonly requestId: string }
  ) => Promise<void>;
  /**
   * `needs_login → ready|error` (login-contract §L.4.1): persisted AFTER a SETTLED flow status.
   * An `awaiting_*` status persists NOTHING (returns the unchanged `needs_login`). Returns the
   * resulting persisted lifecycle state for the response surface. `message` is the redacted (§6.4)
   * detail; NEVER the pasted token (§L.6.3).
   */
  readonly persistLoginTerminal: (
    scopedDb: DataContextDb,
    args: {
      readonly provider: OnboardingProviderKind;
      readonly status: ProviderLoginFlowStatus;
      readonly message?: string;
      readonly requestId: string;
      /** #2205: the Settings row the founder clicked "Log in" on; absent from the onboarding wizard. */
      readonly providerConfigId?: string;
    }
  ) => Promise<ProviderInstallState>;
  /** Read the persisted lifecycle state for the cancel response (no row ⇒ `not_installed`). */
  readonly readState: (
    scopedDb: DataContextDb,
    provider: OnboardingProviderKind
  ) => Promise<ProviderInstallState>;
}

/** The injected login seam (login-contract §L.5). Absent ⇒ the login routes fail closed (500). */
export interface OnboardingLoginDependencies {
  readonly assertProviderConfig?: (
    scopedDb: DataContextDb,
    provider: OnboardingProviderKind,
    scope: ProviderLoginScope
  ) => Promise<void>;
  readonly loginability: ProviderLoginabilityPort;
  readonly loginClient: ProviderLoginClient;
  readonly stateStore: ProviderLoginStateStore;
}

async function verifiedLoginScope(
  login: OnboardingLoginDependencies,
  scopedDb: DataContextDb,
  provider: OnboardingProviderKind,
  actorUserId: string,
  providerConfigId?: string
): Promise<ProviderLoginScope | undefined> {
  if (providerConfigId === undefined) return undefined;
  if (!login.assertProviderConfig)
    throw new HttpError(503, "Provider login is currently unavailable.");
  const scope = { actorUserId, providerConfigId };
  await login.assertProviderConfig(scopedDb, provider, scope);
  return scope;
}

/** Response for the begin/poll/submit-token login routes — the flow status + persisted lifecycle. */
export interface OnboardingProviderLoginResponse {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  readonly status: ProviderLoginFlowStatus;
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly installState: ProviderInstallState;
  readonly message?: string;
}

/** Response for the cancel login route. */
export interface OnboardingProviderLoginCancelResponse {
  readonly providerKind: OnboardingProviderKind;
  readonly ok: true;
  readonly installState: ProviderInstallState;
}

const PROVIDER_KIND_ENUM = ["anthropic", "openai-compatible", "google"] as const;
const INSTALL_STATE_ENUM = [
  "not_installed",
  "installing",
  "installed",
  "needs_login",
  "ready",
  "error"
] as const;
const LOGIN_FLOW_STATUS_ENUM = [
  "awaiting_authorization",
  "awaiting_token",
  "ready",
  "error"
] as const;

const onboardingLoginBeginRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind"],
  properties: {
    providerKind: { type: "string", enum: PROVIDER_KIND_ENUM },
    // #2205: optional — the Settings → AI provider row the founder clicked "Log in" on.
    providerConfigId: { type: "string", minLength: 1, maxLength: 64 }
  }
} as const;

const onboardingLoginPollRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "loginId"],
  properties: {
    providerKind: { type: "string", enum: PROVIDER_KIND_ENUM },
    loginId: { type: "string", minLength: 1, maxLength: 200 },
    // #2205: optional — the Settings → AI provider row the founder clicked "Log in" on.
    providerConfigId: { type: "string", minLength: 1, maxLength: 64 }
  }
} as const;

const onboardingLoginSubmitTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "loginId", "token"],
  properties: {
    providerKind: { type: "string", enum: PROVIDER_KIND_ENUM },
    loginId: { type: "string", minLength: 1, maxLength: 200 },
    // The pasted authorization code — AUTH MATERIAL (§L.6.3). Bounded; NEVER logged/persisted/echoed.
    token: { type: "string", minLength: 1, maxLength: 4096 },
    // #2205: optional — the Settings → AI provider row the founder clicked "Log in" on.
    providerConfigId: { type: "string", minLength: 1, maxLength: 64 }
  }
} as const;

const onboardingLoginCancelRequestSchema = onboardingLoginPollRequestSchema;

const onboardingLoginResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "loginId", "status", "installState"],
  properties: {
    providerKind: { type: "string", enum: PROVIDER_KIND_ENUM },
    loginId: { type: "string" },
    status: { type: "string", enum: LOGIN_FLOW_STATUS_ENUM },
    authorizationUrl: { type: "string" },
    userCode: { type: "string" },
    installState: { type: "string", enum: INSTALL_STATE_ENUM },
    message: { type: "string" }
  }
} as const;

const onboardingLoginCancelResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerKind", "ok", "installState"],
  properties: {
    providerKind: { type: "string", enum: PROVIDER_KIND_ENUM },
    ok: { type: "boolean", enum: [true] },
    installState: { type: "string", enum: INSTALL_STATE_ENUM }
  }
} as const;

const onboardingLoginRouteSchema = {
  body: onboardingLoginBeginRequestSchema,
  response: {
    200: onboardingLoginResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema,
    500: errorResponseSchema
  }
} as const;

const onboardingLoginPollRouteSchema = {
  body: onboardingLoginPollRequestSchema,
  response: {
    200: onboardingLoginResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema,
    500: errorResponseSchema
  }
} as const;

const onboardingLoginSubmitTokenRouteSchema = {
  body: onboardingLoginSubmitTokenRequestSchema,
  response: {
    200: onboardingLoginResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema,
    500: errorResponseSchema
  }
} as const;

const onboardingLoginCancelRouteSchema = {
  body: onboardingLoginCancelRequestSchema,
  response: {
    200: onboardingLoginCancelResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    503: errorResponseSchema,
    500: errorResponseSchema
  }
} as const;

export function registerOnboardingRoutes(
  server: FastifyInstance,
  dependencies: OnboardingRoutesDependencies
): void {
  const repository = dependencies.repository;
  const CLI_PROBE_TTL_MS = 10_000;
  const cliProbeCache = new Map<
    string,
    { anthropic: boolean; "openai-compatible": boolean; google: boolean; ts: number }
  >();

  server.get(
    "/api/onboarding/status",
    { schema: getOnboardingStatusRouteSchema },
    async (request, reply) => {
      try {
        const probes = dependencies.onboardingProbes;
        if (!probes) {
          request.log.error("onboarding routes mounted without onboardingProbes — failing closed");
          throw new HttpError(500, "onboarding probes not configured");
        }
        const accessContext = await dependencies.resolveAccessContext(request);

        const memberStatus = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const user = await dependencies.requireKnownUser(scopedDb, accessContext.actorUserId);
            if (user.is_bootstrap_owner) {
              return null;
            }
            const state = await repository.getMemberOnboardingState(scopedDb);
            return {
              role: "member" as const,
              completed: state.completedAt !== null,
              steps: {
                apiKeyOptOut: { done: false },
                connectors: { done: false }
              }
            };
          }
        );
        if (memberStatus) {
          return memberStatus;
        }

        const install = dependencies.onboardingInstall;
        const dbPart = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
            const [state, connectorAccountExists] = await Promise.all([
              repository.readOnboardingState(scopedDb),
              probes.connectorAccountExists(scopedDb)
            ]);
            // §A.5 step 2 / §A.4.2: read the persisted install lifecycle, correcting any stale
            // `installing` row left by an api crash mid-install (the projection runs + persists
            // under THIS admin-scoped handle, so the correction WRITE satisfies the 0103 admin
            // write RLS). The reconcile MUST come after the admin gate above. Absent seam ⇒ the
            // Phase-1 presence-only surface (no installState).
            const installStateByKind = install
              ? await install.reconcileInstallStates(scopedDb)
              : undefined;
            // #365: derive per-provider catalog installability (the `supported` set) from the
            // install seam's PURE installability port, so the wizard offers Connect data-drivenly
            // (no provider hardcoded in the UI control flow). Absent seam ⇒ omitted (phase-1
            // presence surface). The port is side-effect-free — safe to call inline here.
            const installableByKind = install
              ? {
                  anthropic: install.installability("anthropic").installable,
                  "openai-compatible": install.installability("openai-compatible").installable,
                  google: install.installability("google").installable
                }
              : undefined;
            return {
              state,
              connectorAccountExists,
              installStateByKind,
              installableByKind
            };
          }
        );

        const actorId = accessContext.actorUserId;
        const now = Date.now();
        const hit = cliProbeCache.get(actorId);
        let anthropic: boolean;
        let openaiCompatible: boolean;
        let google: boolean;
        if (hit && now - hit.ts < CLI_PROBE_TTL_MS) {
          anthropic = hit.anthropic;
          openaiCompatible = hit["openai-compatible"];
          google = hit.google;
        } else {
          [anthropic, openaiCompatible, google] = await Promise.all([
            probes.cliPresent("anthropic"),
            probes.cliPresent("openai-compatible"),
            probes.cliPresent("google")
          ]);
          cliProbeCache.set(actorId, {
            anthropic,
            "openai-compatible": openaiCompatible,
            google,
            ts: now
          });
        }

        return repository.assembleOnboardingStatus({
          state: dbPart.state,
          cliPresentByKind: { anthropic, "openai-compatible": openaiCompatible, google },
          connectorAccountExists: dbPart.connectorAccountExists,
          ...(dbPart.installStateByKind !== undefined
            ? { installStateByKind: dbPart.installStateByKind }
            : {}),
          ...(dbPart.installableByKind !== undefined
            ? { installableByKind: dbPart.installableByKind }
            : {})
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/onboarding/provider-check",
    { schema: onboardingProviderCheckRouteSchema },
    async (request, reply) => {
      try {
        const probes = dependencies.onboardingProbes;
        if (!probes) {
          request.log.error("onboarding provider-check route mounted without onboardingProbes");
          throw new HttpError(500, "onboarding probes not configured");
        }

        const body = parseOnboardingProviderCheckBody(request.body);
        const accessContext = await dependencies.resolveAccessContext(request);
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
        });

        return await probes.testProviderConnection(body.providerKind);
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  // §A.5.1: the SOLE admin-gated api trigger for the cli-runner `installProvider` verb.
  // Orchestrates the §A.4 transition ORDER: reject-blocked → persist `installing` →
  // drive the install RPC → persist the terminal `installed`/`error`. Persistence runs
  // INSIDE the admin-scoped DataContextDb (the 0103 write RLS is current_actor_is_admin()),
  // so the admin gate AND the RLS write-authority are the SAME actor (no privilege
  // mismatch). `cliPresent` is re-derived by the install service's own probe and surfaced
  // by the next GET /api/onboarding/status load (§A.5 step 3) — this route returns the
  // settled lifecycle state, the status route reflects presence.
  server.post(
    "/api/onboarding/provider-install",
    { schema: onboardingProviderInstallRouteSchema },
    async (request, reply) => {
      try {
        const install = dependencies.onboardingInstall;
        if (!install) {
          request.log.error(
            "onboarding provider-install route mounted without onboardingInstall — failing closed"
          );
          throw new HttpError(500, "onboarding install service not configured");
        }

        const { providerKind } = parseOnboardingProviderInstallBody(request.body);
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = dependencies.requireRequestId(accessContext);

        // Reject a `blocked`/absent provider (agy/google pre-spike) CLEANLY — a 400 surfaced
        // from the catalog's blockedReason, BEFORE any `installing` row is persisted (so a
        // known-uninstallable provider never pollutes provider_install_state). The catalog is
        // the supply-chain allowlist (install-contract §A.1/§A.2.3).
        const installability = install.installability(providerKind);
        if (!installability.installable) {
          throw new HttpError(400, `provider not installable: ${installability.blockedReason}`);
        }

        // §A.4: persist `installing` BEFORE the RPC, then the terminal state AFTER — both
        // under the SAME admin-scoped DataContextDb so the 0103 admin write RLS is satisfied.
        const response = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            // Admin gate (founder/owner-admin): the same actor whose scope authorizes the
            // 0103 admin-only writes. Throws 401/403 on a non-admin BEFORE any state write.
            await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);

            await install.stateStore.persistInstalling(scopedDb, {
              provider: providerKind,
              requestId
            });

            // Drive the install over the cli-runner socket. A FAILED install is a normal
            // terminal `{ state:"error" }` outcome (§A.2.3) — persisted as `error`, NOT a
            // throw; a throw here is an unexpected RPC fault and bubbles to handleRouteError.
            const outcome = await install.installClient(providerKind);

            const installState = await install.stateStore.persistTerminal(scopedDb, {
              provider: providerKind,
              outcome,
              requestId
            });

            const result: OnboardingProviderInstallResponse = {
              providerKind,
              installState,
              ...(outcome.version !== undefined ? { version: outcome.version } : {}),
              ...terminalExtras(outcome)
            };
            return result;
          }
        );

        return response;
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  // §L.5: the admin-gated login routes — the SOLE api triggers for the cli-runner login verbs.
  // Each resolves an admin AccessContext, persists the §L.4 lifecycle INSIDE that admin-scoped
  // DataContextDb (so the admin gate AND the 0103 write RLS are the SAME actor), and surfaces ONLY
  // the allowlisted URL/code (§L.6.2 — never logged). The pasted token (submit-token) is forwarded
  // to the cli-runner and NEVER logged/persisted/echoed (§L.6.3).
  server.post(
    "/api/onboarding/provider-login/begin",
    { schema: onboardingLoginRouteSchema },
    async (request, reply) => {
      try {
        const login = dependencies.onboardingLogin;
        if (!login) {
          request.log.error("onboarding provider-login route mounted without onboardingLogin");
          throw new HttpError(500, "onboarding login service not configured");
        }
        const { providerKind, providerConfigId } = parseLoginProviderBody(request.body);
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = dependencies.requireRequestId(accessContext);
        // Reject a non-loginable provider (no adapter — agy, or codex if its headless smoke failed)
        // CLEANLY with a 400 BEFORE any `needs_login` row is persisted (login-contract §L.2.4).
        const loginability = login.loginability(providerKind);
        if (!loginability.loginable) {
          throw new HttpError(400, `provider not loginable: ${loginability.blockedReason}`);
        }
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
          const scope = await verifiedLoginScope(
            login,
            scopedDb,
            providerKind,
            accessContext.actorUserId,
            providerConfigId
          );
          await login.stateStore.persistNeedsLogin(scopedDb, { provider: providerKind, requestId });
          const outcome = await login.loginClient.begin(providerKind, scope);
          const installState = await login.stateStore.persistLoginTerminal(scopedDb, {
            provider: providerKind,
            status: outcome.status,
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            requestId,
            ...(providerConfigId !== undefined ? { providerConfigId } : {})
          });
          return buildLoginResponse(providerKind, outcome, installState);
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/onboarding/provider-login/poll",
    { schema: onboardingLoginPollRouteSchema },
    async (request, reply) => {
      try {
        const login = dependencies.onboardingLogin;
        if (!login) {
          request.log.error("onboarding provider-login/poll route mounted without onboardingLogin");
          throw new HttpError(500, "onboarding login service not configured");
        }
        const { providerKind, loginId, providerConfigId } = parseLoginHandleBody(request.body);
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = dependencies.requireRequestId(accessContext);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
          const scope = await verifiedLoginScope(
            login,
            scopedDb,
            providerKind,
            accessContext.actorUserId,
            providerConfigId
          );
          const outcome = await login.loginClient.poll(providerKind, loginId, scope);
          const installState = await login.stateStore.persistLoginTerminal(scopedDb, {
            provider: providerKind,
            status: outcome.status,
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            requestId,
            ...(providerConfigId !== undefined ? { providerConfigId } : {})
          });
          return buildLoginResponse(providerKind, outcome, installState);
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/onboarding/provider-login/submit-token",
    { schema: onboardingLoginSubmitTokenRouteSchema },
    async (request, reply) => {
      try {
        const login = dependencies.onboardingLogin;
        if (!login) {
          request.log.error(
            "onboarding provider-login/submit-token mounted without onboardingLogin"
          );
          throw new HttpError(500, "onboarding login service not configured");
        }
        // The token is AUTH MATERIAL (§L.6.3): parsed for presence, forwarded to the cli-runner,
        // and NEVER logged (we never log the body) / persisted / echoed in the response.
        const { providerKind, loginId, token, providerConfigId } = parseLoginSubmitTokenBody(
          request.body
        );
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = dependencies.requireRequestId(accessContext);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
          const scope = await verifiedLoginScope(
            login,
            scopedDb,
            providerKind,
            accessContext.actorUserId,
            providerConfigId
          );
          const outcome = await login.loginClient.submitToken(providerKind, loginId, token, scope);
          const installState = await login.stateStore.persistLoginTerminal(scopedDb, {
            provider: providerKind,
            status: outcome.status,
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            requestId,
            ...(providerConfigId !== undefined ? { providerConfigId } : {})
          });
          return buildLoginResponse(providerKind, outcome, installState);
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/onboarding/provider-login/cancel",
    { schema: onboardingLoginCancelRouteSchema },
    async (request, reply) => {
      try {
        const login = dependencies.onboardingLogin;
        if (!login) {
          request.log.error("onboarding provider-login/cancel mounted without onboardingLogin");
          throw new HttpError(500, "onboarding login service not configured");
        }
        const { providerKind, loginId, providerConfigId } = parseLoginHandleBody(request.body);
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertBootstrapOwnerAdminUser(scopedDb, accessContext.actorUserId);
          const scope = await verifiedLoginScope(
            login,
            scopedDb,
            providerKind,
            accessContext.actorUserId,
            providerConfigId
          );
          await login.loginClient.cancel(providerKind, loginId, scope);
          const installState = await login.stateStore.readState(scopedDb, providerKind);
          const result: OnboardingProviderLoginCancelResponse = {
            providerKind,
            ok: true,
            installState
          };
          return result;
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  const onboardingStateAction = (verb: "complete" | "skip", state: "completed" | "skipped") =>
    server.post(
      `/api/onboarding/${verb}`,
      { schema: verb === "complete" ? onboardingCompleteRouteSchema : onboardingSkipRouteSchema },
      async (request, reply) => {
        try {
          const accessContext = await dependencies.resolveAccessContext(request);
          const result = await dependencies.dataContext.withDataContext(
            accessContext,
            async (scopedDb) => {
              const user = await dependencies.requireKnownUser(scopedDb, accessContext.actorUserId);
              if (user.is_bootstrap_owner) {
                await dependencies.assertBootstrapOwnerAdminUser(
                  scopedDb,
                  accessContext.actorUserId
                );
                const newState = await repository.setOnboardingState(scopedDb, {
                  state,
                  actorUserId: accessContext.actorUserId,
                  requestId: dependencies.requireRequestId(accessContext)
                });
                return { state: newState };
              }
              const memberState = await repository.setMemberOnboardingComplete(scopedDb, {
                actorUserId: accessContext.actorUserId,
                requestId: dependencies.requireRequestId(accessContext)
              });
              return { completed: memberState.completedAt !== null };
            }
          );
          return result;
        } catch (error) {
          return dependencies.handleRouteError(error, reply);
        }
      }
    );

  onboardingStateAction("complete", "completed");
  onboardingStateAction("skip", "skipped");
}

/** Assemble the login response, surfacing only the optional display fields that are present. */
function buildLoginResponse(
  providerKind: OnboardingProviderKind,
  outcome: ProviderLoginOutcome,
  installState: ProviderInstallState
): OnboardingProviderLoginResponse {
  return {
    providerKind,
    loginId: outcome.loginId,
    status: outcome.status,
    installState,
    ...(outcome.authorizationUrl !== undefined
      ? { authorizationUrl: outcome.authorizationUrl }
      : {}),
    ...(outcome.userCode !== undefined ? { userCode: outcome.userCode } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {})
  };
}

/** Surfaces only the optional terminal-outcome fields that are actually present (no `undefined` keys). */
function terminalExtras(outcome: ProviderInstallOutcome): {
  message?: string;
  alreadyInstalled?: boolean;
  binaryChanged?: boolean;
} {
  const extras: { message?: string; alreadyInstalled?: boolean; binaryChanged?: boolean } = {};
  if (outcome.message !== undefined) {
    extras.message = outcome.message;
  }
  if (outcome.alreadyInstalled !== undefined) {
    extras.alreadyInstalled = outcome.alreadyInstalled;
  }
  // #1081 H2: surface binaryChanged so the response (and the composition root that
  // reads THIS outcome, not the response) can act on a real reinstall.
  if (outcome.binaryChanged !== undefined) {
    extras.binaryChanged = outcome.binaryChanged;
  }
  return extras;
}
