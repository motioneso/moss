/**
 * §L.5 onboarding-login seam wiring (#342 Phase 3, login-contract §L.2/§L.4/§L.5).
 *
 * The composition root assembles the login seam that `packages/settings/src/onboarding-routes.ts`
 * declares as injected PORTS (module isolation — settings never imports @moss/chat or
 * @moss/cli-runner). Mirrors `buildOnboardingInstall` (§A.5):
 *
 *   - loginability ← the cli-runner LOGIN-ADAPTER registry (the auth-flow allowlist, §L.1). A
 *                    provider with no adapter (agy, or codex if its headless smoke failed) is
 *                    `loginable:false` — the route rejects it 400 BEFORE persisting `needs_login`.
 *   - loginClient  ← the ONE shared `RpcConnection` login verbs over the cli-runner socket (§L.2).
 *                    A failed login FLOW is a normal `{ status:"error" }` outcome, not a throw.
 *   - stateStore   ← the settings `SettingsRepository` provider-install-state methods under the
 *                    admin-scoped DataContextDb the route resolves (0103 admin write RLS). The api
 *                    is the SOLE writer; the cli-runner never reaches the DB (§L.4).
 *
 * The whole seam is gated on the boot-time socket fork (there is no in-process login path — the
 * CLIs live in the cli-runner container); absent ⇒ the login routes fail closed (500).
 */

import type { AiAutoRegisterPort, CliModelLister } from "@moss/ai";
import { CliChatUnavailableError, type RpcConnection } from "@moss/chat";
import { LOGIN_ADAPTERS } from "@moss/cli-runner";
import type { AiProviderKind } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type {
  OnboardingLoginDependencies,
  ProviderLoginabilityPort,
  ProviderLoginClient,
  ProviderLoginOutcome,
  ProviderLoginStateStore,
  SettingsRepository
} from "@moss/settings";
import type { OnboardingProviderKind } from "@moss/shared";

const UNAVAILABLE_MESSAGE = "Provider login is currently unavailable. Please try again.";

/**
 * #2208: the model-list port `ModelDiscoveryService` calls for `auth_method = "cli"` providers.
 * Same socket, same lazy connection, same unavailable → 503 mapping as the login seam. Every
 * non-ok outcome (not logged in / unsupported / vendor error) is a normal result the discovery
 * service turns into a `reason`; only a MISSING or DOWN runner throws (HTTP 503, retryable).
 * `undefined` when the socket fork is off (host-dev / in-process) ⇒ discovery reports `unavailable`.
 */
export function buildCliModelLister(deps: {
  readonly enabled: boolean;
  readonly getConnection: () => RpcConnection | undefined;
}): CliModelLister | undefined {
  if (!deps.enabled) return undefined;
  return async (provider) => {
    const conn = deps.getConnection();
    if (!conn) throw new HttpError(503, UNAVAILABLE_MESSAGE);
    try {
      // AiProviderKind is a superset (ollama/custom) of the wire kind; the runner rejects the
      // extras with bad_request, and no CLI provider of those kinds can exist (routes gate them).
      return await conn.listProviderModels({ provider: provider as OnboardingProviderKind });
    } catch (error) {
      if (error instanceof CliChatUnavailableError) throw new HttpError(503, UNAVAILABLE_MESSAGE);
      throw error;
    }
  };
}

/** Map an RPC login result onto the route's outcome shape (omit absent optionals). */
function mapOutcome(r: {
  readonly loginId: string;
  readonly status: ProviderLoginOutcome["status"];
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly message?: string;
}): ProviderLoginOutcome {
  return {
    loginId: r.loginId,
    status: r.status,
    ...(r.authorizationUrl !== undefined ? { authorizationUrl: r.authorizationUrl } : {}),
    ...(r.userCode !== undefined ? { userCode: r.userCode } : {}),
    ...(r.message !== undefined ? { message: r.message } : {})
  };
}

/**
 * Build the §L.5 login seam from the cli-runner socket connection + the settings repository.
 * `enabled` gates the WHOLE seam on the socket fork; the `RpcConnection` is resolved LAZILY at
 * call time (the chat runtime publishes it after routes register).
 */
export function buildOnboardingLogin(deps: {
  readonly enabled: boolean;
  readonly getConnection: () => RpcConnection | undefined;
  readonly repository: SettingsRepository;
  /**
   * #367: on login `ready`, idempotently register a default chat-capable model so chat works with
   * zero manual entry. Optional — absent ⇒ `ready` persists exactly as before (no registration).
   */
  readonly autoRegister?: AiAutoRegisterPort;
  /** Logger for the best-effort auto-register path (a failure is logged, never thrown into login). */
  readonly logger?: { readonly warn: (obj: unknown, msg: string) => void };
}): OnboardingLoginDependencies | undefined {
  if (!deps.enabled) return undefined;
  const repository = deps.repository;

  const loginability: ProviderLoginabilityPort = (provider) => {
    // The LOGIN-ADAPTER registry IS the login allowlist (§L.1). A provider absent (no adapter) is
    // not login-supported — agy always; codex if its headless smoke removed its adapter (§L.9.2).
    if (LOGIN_ADAPTERS[provider]) return { loginable: true };
    return {
      loginable: false,
      blockedReason: "no login adapter — provider is not login-supported on this build"
    };
  };

  const requireConn = (): RpcConnection => {
    const conn = deps.getConnection();
    if (!conn) {
      throw new HttpError(503, "Provider login is currently unavailable. Please try again.");
    }
    return conn;
  };

  // The Settings module deliberately does not depend on @moss/chat, so its shared route
  // mapper cannot recognize CliChatUnavailableError directly. Translate runner transport/busy
  // failures at this composition seam into the canonical route error before they cross the
  // module boundary; otherwise a retryable runner outage is exposed as a misleading 500.
  const runLoginRpc = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CliChatUnavailableError) {
        throw new HttpError(503, "Provider login is currently unavailable. Please try again.");
      }
      throw error;
    }
  };

  const loginClient: ProviderLoginClient = {
    begin: async (provider) =>
      mapOutcome(await runLoginRpc(() => requireConn().beginLogin({ provider }))),
    poll: async (provider, loginId) =>
      mapOutcome(await runLoginRpc(() => requireConn().pollLogin({ provider, loginId }))),
    submitToken: async (provider, loginId, token) =>
      mapOutcome(
        await runLoginRpc(() => requireConn().submitLoginToken({ provider, loginId, token }))
      ),
    cancel: async (provider, loginId) => {
      await runLoginRpc(() => requireConn().cancelLogin({ provider, loginId }));
    }
  };

  const stateStore: ProviderLoginStateStore = {
    // `* → needs_login` collapse before the begin RPC (§L.4.1).
    persistNeedsLogin: async (scopedDb, { provider }) => {
      await repository.upsertProviderInstallState(scopedDb, { provider, state: "needs_login" });
    },
    // `needs_login → ready|error` on a SETTLED status; an `awaiting_*` status persists nothing and
    // returns the current lifecycle (begin already set `needs_login`).
    persistLoginTerminal: async (scopedDb, { provider, status, message, providerConfigId }) => {
      if (status === "ready") {
        const state = await repository.upsertProviderInstallState(scopedDb, {
          provider,
          state: "ready"
        });
        // #367: best-effort default-model registration so chat works with zero manual entry. A
        // failure here MUST NOT fail the login — auth already succeeded (the persisted token is the
        // real "logged in"); the user-facing dead-end is covered by #369's empty-chat explainer.
        // Log at WARN with providerKind + reason; never a token/secret (the cause carries neither).
        if (deps.autoRegister) {
          try {
            await deps.autoRegister.ensureDefaultChatModel(
              scopedDb,
              provider as AiProviderKind,
              providerConfigId !== undefined ? { providerConfigId } : undefined
            );
          } catch (err) {
            deps.logger?.warn(
              { provider, reason: err instanceof Error ? err.message : String(err) },
              "auto-register default chat model failed after login ready"
            );
          }
        }
        return state;
      }
      if (status === "error") {
        return repository.upsertProviderInstallState(scopedDb, {
          provider,
          state: "error",
          ...(message !== undefined ? { message } : {})
        });
      }
      const row = await repository.readProviderInstallState(scopedDb, provider);
      return row?.state ?? "needs_login";
    },
    readState: async (scopedDb, provider: OnboardingProviderKind) => {
      const row = await repository.readProviderInstallState(scopedDb, provider);
      return row?.state ?? "not_installed";
    }
  };

  return { loginability, loginClient, stateStore };
}
