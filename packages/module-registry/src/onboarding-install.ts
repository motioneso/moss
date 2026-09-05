/**
 * §A.5 onboarding-install seam wiring (#342 Phase 2, install-contract §A.4/§A.5).
 *
 * The composition root owns the cross-module wiring of the install seam that
 * `packages/settings/src/onboarding-routes.ts` declares as injected PORTS (module isolation —
 * settings never imports @moss/chat or @moss/cli-runner). This file assembles the concrete
 * implementations from the three lanes:
 *
 *   - installability  ← the cli-runner recipe CATALOG (the supply-chain allowlist, §A.1). A
 *                       `blocked`/absent provider (agy/google pre-spike, or a §A.1.4-demoted
 *                       recipe) is rejected with a 400 BEFORE any `installing` row is persisted.
 *   - installClient   ← the ONE shared `RpcConnection.installProvider` over the cli-runner socket
 *                       (§A.2.1). A FAILED install is a normal terminal `{ state:"error" }`
 *                       outcome, NOT a throw (§A.2.3). When the socket is not configured the seam
 *                       is absent entirely (no in-process install path exists — the CLIs live in
 *                       the cli-runner container, not the api).
 *   - stateStore      ← the settings module's `SettingsRepository` provider-install-state methods,
 *                       run under the admin-scoped DataContextDb the route resolves (0103 write
 *                       RLS = `current_actor_is_admin()`; the api is the SOLE writer, §A.4).
 *   - reconcile       ← the §A.4.2 stale-`installing` projection (`reconcileInstallingRow`) for a
 *                       crash-left `installing` row, PLUS (#2232) the §L.4.2 login projection
 *                       (`reconcileProviderLifecycleRow`) for a `ready` row, so a saved login that
 *                       has since expired is caught and downgraded to `needs_login` on the status
 *                       load instead of showing "connected" forever.
 */

import type { DataContextDb } from "@moss/db";
import {
  reconcileInstallingRow,
  reconcileProviderLifecycleRow,
  type ProviderCatalog,
  type ProviderInstallStateStore as ChatInstallStateStore,
  type RpcConnection
} from "@moss/chat";
import { PROVIDER_CATALOG } from "@moss/cli-runner";
import type {
  OnboardingInstallDependencies,
  ProviderInstallabilityPort,
  ProviderInstallClient,
  ProviderInstallStateStore,
  SettingsRepository
} from "@moss/settings";
import type { OnboardingProviderKind, ProviderInstallState } from "@moss/shared";

const INSTALL_PROVIDER_KINDS: readonly OnboardingProviderKind[] = [
  "anthropic",
  "openai-compatible",
  "google"
];

/**
 * Build the §A.5 install seam from the cli-runner socket connection + the settings repository.
 *
 * `enabled` gates the WHOLE seam on the boot-time socket fork (JARVIS_CLI_RUNNER_SOCKET): there is
 * no in-process install path — the CLIs live in the cli-runner container — so on the host-dev /
 * in-process path the seam is absent, the route stays fail-closed (500), and the status route
 * serves the Phase-1 presence-only surface. The `RpcConnection` itself is resolved LAZILY at call
 * time (`getConnection`) because on the socket path the chat runtime publishes the one connection
 * AFTER routes register (the same late-binding the onboarding probes use). On the socket path the
 * seam is fully wired and the admin-gated route is the SOLE install trigger (§A.7.8).
 */
export function buildOnboardingInstall(deps: {
  readonly enabled: boolean;
  readonly getConnection: () => RpcConnection | undefined;
  readonly repository: SettingsRepository;
  readonly catalog?: ProviderCatalog;
  readonly logger?: { warn: (obj: unknown, msg: string) => void };
  /**
   * #1081 H2: drop+relaunch every live chat session bound to `provider` after this route's
   * install call REPLACED the binary (`binaryChanged:true`). Best-effort — a failure here
   * must never fail the install response, since the install itself already succeeded.
   * Absent on a build with no chat session manager wired (e.g. a future headless install
   * consumer); the seam then just skips the drop.
   */
  readonly dropSessionsForProvider?: (provider: OnboardingProviderKind) => Promise<void>;
}): OnboardingInstallDependencies | undefined {
  if (!deps.enabled) return undefined;
  const catalog = deps.catalog ?? PROVIDER_CATALOG;
  const repository = deps.repository;

  const installability: ProviderInstallabilityPort = (provider) => {
    const entry = catalog[provider];
    if (!entry || entry.status === "blocked" || !entry.recipe) {
      return {
        installable: false,
        blockedReason: entry?.blockedReason ?? "provider not in install catalog"
      };
    }
    return { installable: true };
  };

  const installClient: ProviderInstallClient = async (provider) => {
    // The seam is only built WITH a connection; re-resolve at call time so a connection
    // re-established after a drop is used. A throw here (RpcErr bad_request/internal, or a
    // closed socket) bubbles to handleRouteError — a FAILED install is a resolved
    // { state:"error" } outcome (§A.2.3), not a throw.
    const conn = deps.getConnection();
    if (!conn) {
      throw new Error("cli-runner connection unavailable for install");
    }
    const result = await conn.installProvider({ provider });

    // #1081 H2: a real reinstall REPLACED the live binary — any running engine process for
    // this provider still has the STALE binary in its exec image. Drop those sessions
    // best-effort (kill+drop, conversation preserved — see ChatSessionManager's
    // dropSessionsForProvider) BEFORE returning the outcome; a drop failure must not turn
    // an otherwise-successful install into an error response.
    if (result.binaryChanged === true) {
      try {
        await deps.dropSessionsForProvider?.(provider);
      } catch (err) {
        deps.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), provider },
          "#1081 H2: dropSessionsForProvider failed after a binary-changing reinstall"
        );
      }
    }

    return {
      state: result.state,
      ...(result.version !== undefined ? { version: result.version } : {}),
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.alreadyInstalled !== undefined
        ? { alreadyInstalled: result.alreadyInstalled }
        : {}),
      ...(result.binaryChanged !== undefined ? { binaryChanged: result.binaryChanged } : {})
    };
  };

  const stateStore: ProviderInstallStateStore = {
    persistInstalling: async (scopedDb, { provider }) => {
      await repository.upsertProviderInstallState(scopedDb, { provider, state: "installing" });
    },
    persistTerminal: async (scopedDb, { provider, outcome }) =>
      repository.upsertProviderInstallState(scopedDb, {
        provider,
        state: outcome.state,
        ...(outcome.version !== undefined ? { version: outcome.version } : {}),
        ...(outcome.message !== undefined ? { message: outcome.message } : {})
      })
  };

  // §A.5 step 2 / §A.4.2: the store port the reconcile projection drives. It is the SAME
  // admin-scoped DataContextDb the status route opened — every read/write here is admin-RLS-safe.
  const reconcileStoreFor = (scopedDb: DataContextDb): ChatInstallStateStore => ({
    read: async (provider) => {
      const row = await repository.readProviderInstallState(scopedDb, provider);
      if (!row) return undefined;
      return {
        provider: row.provider,
        state: row.state,
        ...(row.version !== undefined ? { version: row.version } : {}),
        ...(row.message !== undefined ? { message: row.message } : {})
      };
    },
    write: async (input) => {
      await repository.upsertProviderInstallState(scopedDb, {
        provider: input.provider,
        state: input.state,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.message !== undefined ? { message: input.message } : {})
      });
    }
  });

  return {
    installability,
    installClient,
    stateStore,
    reconcileInstallStates: async (scopedDb) => {
      const out: Partial<Record<OnboardingProviderKind, ProviderInstallState>> = {};
      const rows = await repository.readAllProviderInstallStates(scopedDb);
      if (rows.length === 0) return out;
      const store = reconcileStoreFor(scopedDb);
      for (const row of rows) {
        if (!INSTALL_PROVIDER_KINDS.includes(row.provider)) continue;
        if (row.state !== "installing" && row.state !== "ready") {
          // Not stale, and not a "ready" row that could be hiding an expired login — surface the
          // persisted state directly (no probe, no write).
          out[row.provider] = row.state;
          continue;
        }
        // A persisted `installing` row may be STALE (api crashed mid-install). A persisted `ready`
        // row may be LYING (#2242: the saved login token expired, but nothing has re-checked it
        // since). Either way, probe + reconcile. Fail-soft: a probe/socket fault leaves the row
        // unchanged (the projection treats an untrusted probe as no-op) — never break the status
        // load on a transient probe. #2242: a "ready" row demands a REAL check (forceFresh) here,
        // not a saved answer — this reconcile is the one place that revisits a saved success on
        // its own, without anyone pressing Log in, so it must not just repeat the same stale
        // success back for up to five minutes. An "installing" row keeps the plain check.
        try {
          const conn = deps.getConnection();
          const probe = conn
            ? await conn.probeProvider({
                provider: row.provider,
                ...(row.state === "ready" ? { forceFresh: true } : {})
              })
            : ({ status: "error" } as const);
          const corrected =
            row.state === "installing"
              ? await reconcileInstallingRow(row.provider, store, probe)
              : await reconcileProviderLifecycleRow(row.provider, store, probe);
          out[row.provider] = corrected ?? row.state;
        } catch (err) {
          deps.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), provider: row.provider },
            "provider-install reconcile probe failed; leaving persisted state"
          );
          out[row.provider] = row.state;
        }
      }
      return out;
    }
  };
}
