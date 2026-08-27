import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, User } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import type { OnboardingProviderKind, ProviderInstallState } from "@moss/shared";

import {
  registerOnboardingRoutes,
  type OnboardingInstallDependencies,
  type OnboardingRoutesDependencies,
  type ProviderInstallOutcome
} from "../../packages/settings/src/onboarding-routes.js";

// ---------------------------------------------------------------------------
// Lane C unit test (install-contract §A.5 + §A.7 item 8). Exercises ONLY the
// admin-gated POST /api/onboarding/provider-install route in isolation against a
// bare Fastify, with every injected dependency faked — no DB, no cli-runner. It
// proves: the route triggers installProvider + persists `installing` BEFORE and
// the terminal state AFTER (the §A.4 ORDER), the admin gate is enforced BEFORE any
// state write, and a provider the catalog marks blocked is rejected cleanly with a
// 400 before any `installing` row is persisted. (The blocked provider here is a
// FIXTURE, not a claim about the real catalog: #2026 made google installable.)
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = "admin-token";
const MEMBER_TOKEN = "member-token";
const ADMIN_USER_ID = "user-admin";
const MEMBER_USER_ID = "user-member";

// A sentinel scoped-db handle: the route never reads it (all DB I/O is faked), it
// only flows it through to the faked state store, where we assert it was passed.
const SCOPED_DB = { __scoped: true } as unknown as DataContextDb;

interface CallLog {
  readonly events: string[];
  /** The scoped-db handle the state store received on each persist call. */
  readonly scopedDbs: unknown[];
}

function adminUser(): User {
  return {
    id: ADMIN_USER_ID,
    is_bootstrap_owner: true,
    is_instance_admin: true
  } as unknown as User;
}

interface BuildOptions {
  readonly installability?: OnboardingInstallDependencies["installability"];
  readonly installClient?: OnboardingInstallDependencies["installClient"];
  /** Omit the whole install seam to assert the fail-closed 500. */
  readonly omitInstall?: boolean;
}

function buildServer(options: BuildOptions = {}): {
  server: FastifyInstance;
  log: CallLog;
} {
  const log: CallLog = { events: [], scopedDbs: [] };

  const resolveAccessContext = async (request: FastifyRequest): Promise<AccessContext> => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === ADMIN_TOKEN) return { actorUserId: ADMIN_USER_ID, requestId: "req-admin" };
    if (token === MEMBER_TOKEN) return { actorUserId: MEMBER_USER_ID, requestId: "req-member" };
    throw new HttpError(401, "Session is missing or expired");
  };

  // The admin gate: records that it ran (so we can assert it runs BEFORE any state
  // write) and throws 403 for a non-admin actor — exactly the production
  // assertBootstrapOwnerAdminUser contract.
  const assertBootstrapOwnerAdminUser = async (
    _scopedDb: DataContextDb,
    userId: string
  ): Promise<User> => {
    log.events.push("admin-gate");
    if (userId !== ADMIN_USER_ID) {
      throw new HttpError(403, "Bootstrap owner permission is required");
    }
    return adminUser();
  };

  const installability: OnboardingInstallDependencies["installability"] =
    options.installability ??
    ((provider: OnboardingProviderKind) =>
      provider === "google"
        ? { installable: false, blockedReason: "fixture: no pinned recipe for this provider" }
        : { installable: true });

  const installClient: OnboardingInstallDependencies["installClient"] =
    options.installClient ??
    (async (provider: OnboardingProviderKind): Promise<ProviderInstallOutcome> => {
      log.events.push(`install-rpc:${provider}`);
      return { state: "installed", version: "1.2.3" };
    });

  const stateStore: OnboardingInstallDependencies["stateStore"] = {
    persistInstalling: async (scopedDb, args) => {
      log.events.push(`persist-installing:${args.provider}`);
      log.scopedDbs.push(scopedDb);
    },
    persistTerminal: async (scopedDb, args): Promise<ProviderInstallState> => {
      log.events.push(`persist-terminal:${args.provider}:${args.outcome.state}`);
      log.scopedDbs.push(scopedDb);
      return args.outcome.state;
    }
  };

  const dependencies: OnboardingRoutesDependencies = {
    // withDataContext just runs the callback with the sentinel scoped db — the route's
    // persistence + admin gate all run inside this single transaction (one actor scope).
    dataContext: {
      withDataContext: async (_ctx: AccessContext, fn: (db: DataContextDb) => Promise<unknown>) =>
        fn(SCOPED_DB)
    } as unknown as OnboardingRoutesDependencies["dataContext"],
    resolveAccessContext,
    repository: {} as unknown as OnboardingRoutesDependencies["repository"],
    requireKnownUser: async (_db, _id) => adminUser(),
    assertBootstrapOwnerAdminUser,
    requireRequestId: (ctx) => {
      if (!ctx.requestId) throw new HttpError(500, "Request id is missing");
      return ctx.requestId;
    },
    handleRouteError: (error, reply) => handleRouteError(error, reply),
    onboardingInstall: options.omitInstall
      ? undefined
      : {
          installability,
          installClient,
          stateStore,
          // The status-load reconcile port (§A.5 step 2). Not exercised by these install-route
          // tests (they POST the install verb); a no-op fake satisfies the seam contract.
          reconcileInstallStates: async () => ({})
        }
  };

  const server = Fastify({ logger: false });
  registerOnboardingRoutes(server, dependencies);
  return { server, log };
}

async function postInstall(server: FastifyInstance, token: string | undefined, body: unknown) {
  return server.inject({
    method: "POST",
    url: "/api/onboarding/provider-install",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    payload: body as Record<string, unknown>
  });
}

describe("onboarding provider-install route (§A.5)", () => {
  let server: FastifyInstance;
  let log: CallLog;

  beforeEach(async () => {
    ({ server, log } = buildServer());
    await server.ready();
  });

  it("triggers installProvider, persisting `installing` BEFORE the RPC and the terminal state AFTER", async () => {
    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerKind: "anthropic",
      installState: "installed",
      version: "1.2.3"
    });

    // The §A.4 ORDER: admin gate → persist `installing` → install RPC → persist terminal.
    expect(log.events).toEqual([
      "admin-gate",
      "persist-installing:anthropic",
      "install-rpc:anthropic",
      "persist-terminal:anthropic:installed"
    ]);
  });

  it("persists both transitions under the SAME admin-scoped DataContextDb (0103 admin write RLS)", async () => {
    await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });
    // Both persist calls received the SAME scoped handle the route's withDataContext opened
    // under the admin actor — so the admin gate and the writes share one actor scope.
    expect(log.scopedDbs).toHaveLength(2);
    expect(log.scopedDbs[0]).toBe(SCOPED_DB);
    expect(log.scopedDbs[1]).toBe(SCOPED_DB);
  });

  it("persists `error` (NOT a throw) when the install settles to a terminal error outcome", async () => {
    ({ server, log } = buildServer({
      installClient: async () => ({ state: "error", message: "verify failed: sha512 mismatch" })
    }));
    await server.ready();

    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });
    // A failed install is a NORMAL terminal outcome (§A.2.3): 200 with installState=error,
    // never a transport-level 5xx.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      providerKind: "anthropic",
      installState: "error",
      message: "verify failed: sha512 mismatch"
    });
    expect(log.events).toContain("persist-terminal:anthropic:error");
  });

  it("surfaces alreadyInstalled on an idempotent no-op re-verify", async () => {
    ({ server } = buildServer({
      installClient: async () => ({ state: "installed", version: "1.2.3", alreadyInstalled: true })
    }));
    await server.ready();

    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerKind: "anthropic",
      installState: "installed",
      version: "1.2.3",
      alreadyInstalled: true
    });
  });

  it("rejects a provider the catalog marks blocked, cleanly with 400 and persists NOTHING", async () => {
    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "google" });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not installable/i);
    // No `installing` row, no RPC, no terminal write for a known-uninstallable provider.
    expect(log.events).not.toContain("persist-installing:google");
    expect(log.events).not.toContain("install-rpc:google");
    expect(log.events.some((e) => e.startsWith("persist-"))).toBe(false);
  });

  it("enforces the admin gate BEFORE any state write (non-admin ⇒ 403, nothing persisted)", async () => {
    const res = await postInstall(server, MEMBER_TOKEN, { providerKind: "anthropic" });

    expect([401, 403]).toContain(res.statusCode);
    // The gate ran, but no persistence/RPC happened — the admin check precedes every write.
    expect(log.events).toEqual(["admin-gate"]);
  });

  it("rejects an unauthenticated caller (no session) with 401", async () => {
    const res = await postInstall(server, undefined, { providerKind: "anthropic" });
    expect(res.statusCode).toBe(401);
    expect(log.events).toEqual([]);
  });

  it("rejects an unknown providerKind with 400 (schema/parse guard)", async () => {
    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "gemini" });
    expect(res.statusCode).toBe(400);
    expect(log.events.some((e) => e.startsWith("persist-"))).toBe(false);
  });

  it("fails closed with 500 when the install seam is not wired", async () => {
    ({ server } = buildServer({ omitInstall: true }));
    await server.ready();

    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });
    expect(res.statusCode).toBe(500);
  });

  it("never leaks a secret-shaped field in the response", async () => {
    const res = await postInstall(server, ADMIN_TOKEN, { providerKind: "anthropic" });
    expect(res.body).not.toMatch(/token|secret|password|credential/i);
  });
});
