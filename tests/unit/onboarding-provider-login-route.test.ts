import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, User } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import type { OnboardingProviderKind, ProviderInstallState } from "@moss/shared";

import {
  registerOnboardingRoutes,
  type OnboardingLoginDependencies,
  type OnboardingRoutesDependencies,
  type ProviderLoginOutcome
} from "../../packages/settings/src/onboarding-routes.js";

// ---------------------------------------------------------------------------
// §L.5 login-route unit test. Exercises ONLY the four admin-gated login routes in
// isolation against a bare Fastify, every dependency faked — no DB, no cli-runner.
// Proves: begin persists `needs_login` BEFORE the RPC + the terminal AFTER (the §L.4
// order), the admin gate runs first, a non-loginable provider is rejected 400 before
// any persist, and the pasted token NEVER appears in any response (§L.6.3).
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = "admin-token";
const MEMBER_TOKEN = "member-token";
const ADMIN_USER_ID = "user-admin";
const SCOPED_DB = { __scoped: true } as unknown as DataContextDb;

interface CallLog {
  readonly events: string[];
}

function adminUser(): User {
  return {
    id: ADMIN_USER_ID,
    is_bootstrap_owner: true,
    is_instance_admin: true
  } as unknown as User;
}

interface BuildOptions {
  readonly loginability?: OnboardingLoginDependencies["loginability"];
  readonly loginClient?: Partial<OnboardingLoginDependencies["loginClient"]>;
  readonly omitLogin?: boolean;
}

function buildServer(options: BuildOptions = {}): { server: FastifyInstance; log: CallLog } {
  const log: CallLog = { events: [] };

  const resolveAccessContext = async (request: FastifyRequest): Promise<AccessContext> => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === ADMIN_TOKEN) return { actorUserId: ADMIN_USER_ID, requestId: "req-admin" };
    if (token === MEMBER_TOKEN) return { actorUserId: "user-member", requestId: "req-member" };
    throw new HttpError(401, "Session is missing or expired");
  };

  const assertBootstrapOwnerAdminUser = async (
    _scopedDb: DataContextDb,
    userId: string
  ): Promise<User> => {
    log.events.push("admin-gate");
    if (userId !== ADMIN_USER_ID)
      throw new HttpError(403, "Bootstrap owner permission is required");
    return adminUser();
  };

  const loginability: OnboardingLoginDependencies["loginability"] =
    options.loginability ??
    ((provider: OnboardingProviderKind) =>
      provider === "google"
        ? { loginable: false, blockedReason: "no login adapter" }
        : { loginable: true });

  const defaultOutcome = (status: ProviderLoginOutcome["status"]): ProviderLoginOutcome => ({
    loginId: "login-1",
    status,
    ...(status === "awaiting_authorization" || status === "awaiting_token"
      ? { authorizationUrl: "https://claude.ai/oauth/authorize?code=abc" }
      : {})
  });

  const loginClient: OnboardingLoginDependencies["loginClient"] = {
    begin:
      options.loginClient?.begin ??
      (async (provider) => {
        log.events.push(`begin-rpc:${provider}`);
        return defaultOutcome("awaiting_token");
      }),
    poll: options.loginClient?.poll ?? (async () => defaultOutcome("ready")),
    submitToken:
      options.loginClient?.submitToken ??
      (async () => {
        log.events.push("submit-rpc");
        return defaultOutcome("ready");
      }),
    cancel: options.loginClient?.cancel ?? (async () => undefined)
  };

  const stateStore: OnboardingLoginDependencies["stateStore"] = {
    persistNeedsLogin: async (_db, args) => {
      log.events.push(`persist-needs-login:${args.provider}`);
    },
    persistLoginTerminal: async (_db, args): Promise<ProviderInstallState> => {
      log.events.push(`persist-terminal:${args.provider}:${args.status}`);
      if (args.status === "ready") return "ready";
      if (args.status === "error") return "error";
      return "needs_login";
    },
    readState: async () => "needs_login"
  };

  const dependencies: OnboardingRoutesDependencies = {
    dataContext: {
      withDataContext: async (_ctx: AccessContext, fn: (db: DataContextDb) => Promise<unknown>) =>
        fn(SCOPED_DB)
    } as unknown as OnboardingRoutesDependencies["dataContext"],
    resolveAccessContext,
    repository: {} as unknown as OnboardingRoutesDependencies["repository"],
    requireKnownUser: async () => adminUser(),
    assertBootstrapOwnerAdminUser,
    requireRequestId: (ctx) => ctx.requestId ?? "req",
    handleRouteError: (error, reply) => handleRouteError(error, reply),
    onboardingLogin: options.omitLogin ? undefined : { loginability, loginClient, stateStore }
  };

  const server = Fastify({ logger: false });
  registerOnboardingRoutes(server, dependencies);
  return { server, log };
}

const post = (server: FastifyInstance, url: string, token: string | undefined, body: unknown) =>
  server.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    payload: body as Record<string, unknown>
  });

describe("onboarding provider-login routes (§L.5)", () => {
  let server: FastifyInstance;
  let log: CallLog;

  beforeEach(async () => {
    ({ server, log } = buildServer());
    await server.ready();
  });

  it("begin: admin gate → persist needs_login → begin RPC → persist terminal (§L.4 order)", async () => {
    const res = await post(server, "/api/onboarding/provider-login/begin", ADMIN_TOKEN, {
      providerKind: "anthropic"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      providerKind: "anthropic",
      loginId: "login-1",
      status: "awaiting_token",
      installState: "needs_login",
      authorizationUrl: "https://claude.ai/oauth/authorize?code=abc"
    });
    expect(log.events).toEqual([
      "admin-gate",
      "persist-needs-login:anthropic",
      "begin-rpc:anthropic",
      "persist-terminal:anthropic:awaiting_token"
    ]);
  });

  it("poll: settles ready and persists ready", async () => {
    const res = await post(server, "/api/onboarding/provider-login/poll", ADMIN_TOKEN, {
      providerKind: "anthropic",
      loginId: "login-1"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", installState: "ready" });
  });

  it("submit-token: NEVER echoes the pasted token in the response (§L.6.3)", async () => {
    const SECRET = "PASTED-OAUTH-CODE-7766";
    const res = await post(server, "/api/onboarding/provider-login/submit-token", ADMIN_TOKEN, {
      providerKind: "anthropic",
      loginId: "login-1",
      token: SECRET
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toMatch(/token|secret|password|credential/i);
  });

  // #2027: google IS loginable now. This test still uses it, but only against its OWN stub whose
  // loginable set excludes it — the behaviour under test is the route's rejection path, not any
  // real claim about google. Named accordingly so the name stops asserting something untrue.
  it("rejects a provider the loginable set excludes, with 400 and persists NOTHING", async () => {
    const res = await post(server, "/api/onboarding/provider-login/begin", ADMIN_TOKEN, {
      providerKind: "google"
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not loginable/i);
    expect(log.events.some((e) => e.startsWith("persist-"))).toBe(false);
  });

  it("enforces the admin gate before any write (member ⇒ 403)", async () => {
    const res = await post(server, "/api/onboarding/provider-login/begin", MEMBER_TOKEN, {
      providerKind: "anthropic"
    });
    expect([401, 403]).toContain(res.statusCode);
    expect(log.events).toEqual(["admin-gate"]);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await post(server, "/api/onboarding/provider-login/begin", undefined, {
      providerKind: "anthropic"
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing loginId on poll with 400", async () => {
    const res = await post(server, "/api/onboarding/provider-login/poll", ADMIN_TOKEN, {
      providerKind: "anthropic"
    });
    expect(res.statusCode).toBe(400);
  });

  it("cancel returns ok + the persisted lifecycle", async () => {
    const res = await post(server, "/api/onboarding/provider-login/cancel", ADMIN_TOKEN, {
      providerKind: "anthropic",
      loginId: "login-1"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerKind: "anthropic",
      ok: true,
      installState: "needs_login"
    });
  });

  it("fails closed with 500 when the login seam is not wired", async () => {
    ({ server } = buildServer({ omitLogin: true }));
    await server.ready();
    const res = await post(server, "/api/onboarding/provider-login/begin", ADMIN_TOKEN, {
      providerKind: "anthropic"
    });
    expect(res.statusCode).toBe(500);
  });
});
