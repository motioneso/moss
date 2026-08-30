import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  getMossDatabaseUrls,
  resolveMossEnv,
  resolveTrustProxy,
  type AccessContext,
  type DataContextRunner,
  type MossDatabase
} from "@moss/db";
import {
  recordAuditEvent as settingsRecordAuditEvent,
  recordBootstrapOwnerAuditEvent as settingsRecordBootstrapOwnerAuditEvent
} from "@moss/settings";
import type { AuthProviderStatusDto } from "@moss/shared";

import { readBearerToken, toWebHeaders } from "./headers.js";
import { resolveAuthOriginConfig } from "./runtime-config.js";
import { createMeSessionsService, type MeSessionsRuntimeService } from "./session-service.js";

const { Pool } = pg;

// Re-exported so root-level callers (e.g. tests/uat/seed) can hash a credential
// password without taking a direct root devDependency on better-auth — pnpm's
// strict node_modules means only packages that declare the dependency (this one)
// can resolve "better-auth/crypto" directly (#1025).
export { hashPassword };

export interface AuthenticatedPrincipal {
  readonly userId: string;
}

export interface RequestAccessContextInput {
  readonly id?: string;
  readonly headers: Headers | IncomingHttpHeaders;
}

export class AccountPendingApprovalError extends Error {
  readonly code = "account_pending_approval";
  constructor() {
    super("Account is pending approval");
  }
}

export class AccountDeactivatedError extends Error {
  readonly code = "account_deactivated";
  constructor() {
    super("Account has been deactivated");
  }
}

export interface MossAuthRuntime {
  readonly auth: ReturnType<typeof betterAuth>;
  readonly resolveAccessContext: (request: RequestAccessContextInput) => Promise<AccessContext>;
  readonly listConfiguredProviders: () => readonly AuthProviderStatusDto[];
  readonly revokeUserSessions: (userId: string) => Promise<number>;
  /** Current-user session list/revoke (#237) — owns all session-table access for this surface. */
  readonly meSessions: MeSessionsRuntimeService;
  /**
   * Verifies the actor's own email/password credential for self-service destructive
   * confirmation (#239). Scoped to the actor's `auth_accounts` row
   * (`provider_id = 'credential'` AND non-null `password`); uses better-auth's
   * constant-time `verifyPassword` so no sign-in/session machinery runs and no
   * session row is created. Returns a boolean only — never the hash, never a
   * structured error (the route decides the HTTP code). Absent credential or
   * mismatched password both return false.
   */
  readonly verifySelfPassword: (input: {
    readonly actorUserId: string;
    readonly password: string;
  }) => Promise<boolean>;
  /**
   * Existence-only probe: does the actor own an email/password credential
   * (`app.auth_accounts` row with `provider_id = 'credential'` and a non-null
   * `password`)? Runs on the auth pool because migration 0045 REVOKED
   * `jarvis_app_runtime` SELECT on `app.auth_accounts` (it holds password hashes
   * + OAuth tokens) — the settings route layer cannot read that table directly.
   * Returns a boolean only; NEVER selects the password hash (#239).
   */
  readonly hasPasswordCredential: (actorUserId: string) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

/**
 * Minimal structured-log sink for security-relevant auth events. Shaped like a pino
 * logger's `info(mergeObject, msg)` so the Fastify request logger satisfies it directly,
 * without dragging a Fastify type dependency into the auth package. Optional: when absent
 * (e.g. tests that inject their own runtime) the events are simply not emitted.
 */
export interface AuthLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  /**
   * Warn-level sink for degraded-mode observability (e.g. a best-effort audit
   * write failing on the reject path, or an ephemeral auth secret fallback).
   * Optional — omitted sinks degrade quietly (observability spec: no console.*
   * in production).
   */
  warn?(obj: Record<string, unknown>, msg: string): void;
}

export interface CreateMossAuthRuntimeOptions {
  readonly appDb: Kysely<MossDatabase>;
  readonly runner: DataContextRunner;
  readonly connectionString?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Structured-log sink for the legacy session-bearer observability event (#113).
   * Pass the Fastify `server.log` here; omit to suppress the event.
   */
  readonly logger?: AuthLogger;
  /** Test-only: override the settings dependency injected into bootstrap hooks. */
  readonly _settingsOverride?: BootstrapSettings;
}

interface BetterAuthUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
}

// The slice of the @moss/settings public API that auth depends on. Auth records
// admin audit events exclusively through this public API, never through the settings
// repository class or by writing the settings-owned audit table directly (#101).
export type BootstrapSettings = {
  readonly recordBootstrapOwnerAuditEvent: typeof settingsRecordBootstrapOwnerAuditEvent;
  readonly recordAuditEvent: typeof settingsRecordAuditEvent;
};

export function createMossAuthRuntime(options: CreateMossAuthRuntimeOptions): MossAuthRuntime {
  const env = options.env ?? process.env;
  const pool = new Pool({
    connectionString: options.connectionString ?? getMossDatabaseUrls(env).auth,
    max: Number(resolveMossEnv(env, "JARVIS_AUTH_DB_POOL_SIZE") ?? 4),
    options: "-c search_path=app,public"
  });
  const legacySessions = new AuthSessionResolver(options.appDb);
  const settings: BootstrapSettings = options._settingsOverride ?? {
    recordBootstrapOwnerAuditEvent: settingsRecordBootstrapOwnerAuditEvent,
    recordAuditEvent: settingsRecordAuditEvent
  };
  const auth = betterAuth(
    createBetterAuthOptions(pool, options.appDb, env, options.runner, settings, options.logger)
  );

  return {
    auth,
    resolveAccessContext: (request) =>
      resolveRequestAccessContext({
        request,
        auth,
        legacySessions,
        appDb: options.appDb,
        logger: options.logger
      }),
    listConfiguredProviders: () => listConfiguredAuthProviders(env),
    revokeUserSessions: async (userId: string) => {
      const result = await pool.query("DELETE FROM app.better_auth_sessions WHERE user_id = $1", [
        userId
      ]);
      return result.rowCount ?? 0;
    },
    meSessions: createMeSessionsService({ pool, auth }),
    verifySelfPassword: async ({ actorUserId, password }) => {
      // Scope strictly to the actor's own credential row. provider_id='credential'
      // AND a non-null password define "this account owns a password credential"
      // (the same existence check GET /api/me exposes as hasPasswordCredential).
      const result = await pool.query<{ password: string }>(
        `SELECT password FROM app.auth_accounts
         WHERE user_id = $1::uuid AND provider_id = 'credential' AND password IS NOT NULL`,
        [actorUserId]
      );
      const hash = result.rows[0]?.password;
      if (!hash) return false;
      return verifyPassword({ hash, password });
    },
    hasPasswordCredential: async (actorUserId) => {
      // Existence only — never select the hash. Runs on the auth pool because
      // jarvis_app_runtime's SELECT on auth_accounts was revoked (0045).
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM app.auth_accounts
           WHERE user_id = $1::uuid AND provider_id = 'credential' AND password IS NOT NULL
         ) AS exists`,
        [actorUserId]
      );
      return result.rows[0]?.exists ?? false;
    },
    close: () => pool.end()
  };
}

export function listConfiguredAuthProviders(
  env: NodeJS.ProcessEnv = process.env
): readonly AuthProviderStatusDto[] {
  return [
    {
      id: "email-password",
      displayName: "Email and password",
      providerType: "local",
      enabled: true
    },
    {
      id: "google",
      displayName: "Google",
      providerType: "oauth",
      enabled: hasCredentialPair(
        env,
        "JARVIS_AUTH_GOOGLE_CLIENT_ID",
        "JARVIS_AUTH_GOOGLE_CLIENT_SECRET"
      )
    },
    {
      id: "github",
      displayName: "GitHub",
      providerType: "oauth",
      enabled: hasCredentialPair(
        env,
        "JARVIS_AUTH_GITHUB_CLIENT_ID",
        "JARVIS_AUTH_GITHUB_CLIENT_SECRET"
      )
    },
    {
      id: "microsoft",
      displayName: "Microsoft",
      providerType: "oauth",
      enabled: hasCredentialPair(
        env,
        "JARVIS_AUTH_MICROSOFT_CLIENT_ID",
        "JARVIS_AUTH_MICROSOFT_CLIENT_SECRET"
      )
    },
    {
      id: readString(env, "JARVIS_AUTH_OIDC_PROVIDER_ID") ?? "oidc",
      displayName: readString(env, "JARVIS_AUTH_OIDC_DISPLAY_NAME") ?? "Generic OIDC",
      providerType: "oidc",
      enabled: hasOidcProviderConfig(env)
    }
  ];
}

/** Exported for unit testing only (#1505) — not part of the package's runtime API surface. */
export function createBetterAuthOptions(
  pool: pg.Pool,
  appDb: Kysely<MossDatabase>,
  env: NodeJS.ProcessEnv,
  runner: DataContextRunner,
  settings: BootstrapSettings,
  logger?: AuthLogger
): BetterAuthOptions {
  const socialProviders = readSocialProviders(env);
  const plugins = readAuthPlugins(env);
  const originConfig = resolveAuthOriginConfig(env);

  return {
    appName: "Jarv1s",
    basePath: "/api/auth",
    baseURL: originConfig.baseURL,
    secret: readAuthSecret(env, logger),
    database: pool,
    emailAndPassword: {
      enabled: true
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at"
      },
      additionalFields: {
        isInstanceAdmin: {
          type: "boolean",
          fieldName: "is_instance_admin",
          required: true,
          input: false,
          defaultValue: false
        }
      }
    },
    session: {
      modelName: "better_auth_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id"
      }
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    advanced: {
      // Force Secure / __Secure- cookies once a TLS-terminating reverse proxy is in
      // front (same JARVIS_TRUST_PROXY signal apps/api uses for XFF trust and HSTS —
      // see apps/api/src/server.ts). Without this, turning TLS on does not stop the
      // login cookie from also working over plain HTTP (#1505).
      useSecureCookies: resolveTrustProxy(resolveMossEnv(env, "JARVIS_TRUST_PROXY")) !== false,
      database: {
        generateId: "uuid"
      }
    },
    databaseHooks: {
      user: {
        create: {
          before: (user) => registrationGate(appDb, user),
          after: (user) =>
            bootstrapFirstMossUser(pool, runner, settings, user as BetterAuthUser, logger)
        }
      }
    },
    trustedOrigins: originConfig.trustedOrigins,
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
    ...(plugins.length > 0 ? { plugins } : {})
  };
}

async function resolveRequestAccessContext(options: {
  readonly request: RequestAccessContextInput;
  readonly auth: ReturnType<typeof betterAuth>;
  readonly legacySessions: AuthSessionResolver;
  readonly appDb: Kysely<MossDatabase>;
  readonly logger?: AuthLogger;
}): Promise<AccessContext> {
  const requestId = options.request.id ?? randomUUID();
  const headers = toWebHeaders(options.request.headers);
  const bearerToken = readBearerToken(headers);

  let actorUserId: string;

  if (bearerToken) {
    // LEGACY SESSION-BEARER PATH (#113 — hardened, do not weaken).
    //
    // This is the programmatic/headless auth used by the Jarv1s CLI bridge and the
    // integration suite. The bearer token IS a Better Auth session UUID — there is no
    // separate API-key table; the session id is the only secret. The following
    // invariants make this path safe to keep and MUST hold:
    //   1. expires_at is enforced *server-side*: `app.resolve_auth_session` filters
    //      `WHERE id = $1 AND expires_at > now()` (migration 0046). An expired session
    //      id cannot authenticate here — do not move that check into application code.
    //   2. The `::uuid` cast in the resolver rejects any non-UUID token (no SQL
    //      injection surface); `readBearerToken` already rejects malformed schemes.
    //   3. Use is observable: every successful bearer auth emits the structured event
    //      below so this weaker-than-cookie path is never silent.
    //   4. Use is throttled: bearer-authed routes carry the global rate-limit class
    //      keyed on the auth principal (apps/api/src/server.ts), not just IP.
    // The raw token is a session secret and MUST NEVER be logged (hard invariant —
    // session tokens never reach logs); only a one-way fingerprint is emitted.
    const ctx = await options.legacySessions.resolveAccessContext(bearerToken, requestId);
    actorUserId = ctx.actorUserId;
    options.logger?.info(
      {
        event: "auth.bearer_session",
        actorUserId,
        requestId,
        tokenFingerprint: fingerprintToken(bearerToken)
      },
      "Authenticated via legacy session-bearer token"
    );
  } else {
    const session = await options.auth.api.getSession({ headers });
    if (!session) {
      throw new Error("Session is missing or expired");
    }
    actorUserId = session.user.id;
  }

  const rows = await sql<{ status: string }>`
    SELECT status FROM app.get_user_by_id(${actorUserId}::uuid)
  `.execute(options.appDb);

  const userRow = rows.rows[0];
  if (!userRow) {
    throw new Error("Session is missing or expired");
  }
  if (userRow.status === "pending") {
    throw new AccountPendingApprovalError();
  }
  if (userRow.status === "deactivated") {
    throw new AccountDeactivatedError();
  }

  return { actorUserId, requestId };
}

async function registrationGate(appDb: Kysely<MossDatabase>, _user: BetterAuthUser): Promise<void> {
  if (!(await bootstrapOwnerExists(appDb))) return;

  const enabled = await readBooleanSetting(appDb, "registration.enabled", true);
  if (!enabled) {
    throw new APIError("FORBIDDEN", {
      message: "Registration is disabled",
      code: "registration_disabled"
    });
  }
}

/**
 * Allowlist of NON-SECRET instance-config keys this pre-auth helper may read via the
 * raw appDb handle with no actor GUC (the documented "pre-auth non-secret
 * instance-config reads" exemption — see DEVELOPMENT_STANDARDS.md). Mechanically
 * bounds the exemption so the helper can never be repurposed to read an arbitrary
 * (possibly sensitive) setting key; mirrors PREAUTH_READABLE_SETTING_KEYS in
 * module-registry's chat-multiplexer boot reader. Secrets never live in
 * instance_settings (they are AES-256-GCM in the credential store), so this list
 * must only ever contain non-secret config keys.
 */
const PREAUTH_READABLE_SETTING_KEYS = new Set<string>([
  "registration.enabled",
  "registration.requires_approval"
]);

async function readBooleanSetting(
  appDb: Kysely<MossDatabase>,
  key: string,
  defaultValue: boolean
): Promise<boolean> {
  if (!PREAUTH_READABLE_SETTING_KEYS.has(key)) {
    throw new Error(`pre-auth instance-setting read not allowed for key "${key}"`);
  }
  const row = await appDb
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();

  if (!row) return defaultValue;
  const parsed = row.value as Record<string, unknown>;
  return typeof parsed.value === "boolean" ? parsed.value : defaultValue;
}

async function bootstrapOwnerExists(appDb: Kysely<MossDatabase>): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM app.list_all_users()
      WHERE is_bootstrap_owner = true
    ) AS "exists"
  `.execute(appDb);

  return result.rows[0]?.exists ?? false;
}

async function bootstrapFirstMossUser(
  authPool: pg.Pool,
  runner: DataContextRunner,
  settings: BootstrapSettings,
  user: BetterAuthUser,
  logger?: AuthLogger
): Promise<void> {
  // withDataContext is the sole transaction boundary: it opens one transaction and
  // sets app.actor_user_id / app.request_id GUCs for its lifetime. No raw appDb DML
  // and no manual set_config here (#127).
  let registrationRejected = false;
  try {
    await runner.withDataContext(
      { actorUserId: user.id, requestId: `bootstrap:${user.id}` },
      async (scopedDb) => {
        // Advisory transaction-level lock — prevents two concurrent sign-ups from both
        // seeing isFirstUser = true. Must run inside the same transaction.
        await sql`SELECT pg_advisory_xact_lock(hashtext('jarv1s:first-user-bootstrap'))`.execute(
          scopedDb.db
        );

        // Use the existing SECURITY DEFINER all-users read helper here. A direct
        // app.users query under app_runtime would be RLS-scoped to the signup's own row
        // and would miss an existing bootstrap owner.
        const shouldBootstrapOwner = !(await bootstrapOwnerExists(scopedDb.db));

        let status: "active" | "pending" = "active";
        if (!shouldBootstrapOwner) {
          const registrationEnabled = await readBooleanSetting(
            scopedDb.db,
            "registration.enabled",
            true
          );
          if (!registrationEnabled) {
            registrationRejected = true;
            throw new APIError("FORBIDDEN", {
              message: "Registration is disabled",
              code: "registration_disabled"
            });
          }

          const requiresApproval = await readBooleanSetting(
            scopedDb.db,
            "registration.requires_approval",
            true
          );
          if (requiresApproval) status = "pending";
        }

        await scopedDb.db
          .updateTable("app.users")
          .set({
            name: user.name ?? "",
            email: user.email,
            is_instance_admin: shouldBootstrapOwner,
            is_bootstrap_owner: shouldBootstrapOwner,
            status,
            updated_at: new Date()
          })
          .where("id", "=", user.id)
          .execute();

        if (!shouldBootstrapOwner) {
          return;
        }

        // Auth must not write the settings-owned audit table directly. Record the
        // bootstrap event through the @moss/settings SECURITY DEFINER helper (#122).
        await settings.recordBootstrapOwnerAuditEvent(scopedDb, {
          actorUserId: user.id,
          targetUserId: user.id,
          requestId: `bootstrap:${user.id}`
        });
      }
    );
  } catch (err) {
    // better-auth commits the app.users row (and any auth_accounts/session rows)
    // on its OWN connection before this after-hook runs, so this transaction
    // rolling back does NOT undo that insert. ANY hook failure — registration
    // disabled, the 0055 admin-flag guard denying a stale-admin race, a
    // transient audit-write error, anything — must compensate by deleting the
    // row here, or the email is permanently bricked: USER_ALREADY_EXISTS on
    // every retry with no way to complete setup (#853).
    if (registrationRejected) {
      try {
        await recordRegistrationRejectedAudit(runner, settings, user.id);
      } catch {
        // Audit is best-effort on the reject path — do not mask the original error.
        logger?.warn?.(
          { userId: user.id, requestId: `bootstrap-reject:${user.id}` },
          "[auth] registration-rejected audit write failed"
        );
      }
    }
    try {
      await deleteOrphanedBootstrapUser(authPool, user.id);
    } catch {
      // Best-effort compensation — do not mask the original error with a
      // cleanup failure; the original `err` below is what the caller sees.
      logger?.warn?.(
        { userId: user.id, requestId: `bootstrap:${user.id}` },
        "[auth] failed to delete orphaned better-auth user after bootstrap hook failure"
      );
    }
    throw err;
  }
}

async function recordRegistrationRejectedAudit(
  runner: DataContextRunner,
  settings: BootstrapSettings,
  userId: string
): Promise<void> {
  const requestId = `bootstrap-reject:${userId}`;
  await runner.withDataContext({ actorUserId: userId, requestId }, async (scopedDb) => {
    await settings.recordAuditEvent(scopedDb, {
      actorUserId: userId,
      action: "user.registration_rejected",
      targetType: "user",
      targetId: userId,
      metadata: { reason: "registration_disabled" },
      requestId
    });
  });
}

// Compensating delete for any bootstrap after-hook failure (#853). app.auth_accounts
// and app.better_auth_sessions both FK user_id ON DELETE CASCADE
// (0004_auth_workspaces_settings.sql), so deleting the app.users row alone fully
// removes the credential + session rows better-auth committed for this signup —
// no separate auth_accounts delete is needed.
async function deleteOrphanedBootstrapUser(authPool: pg.Pool, userId: string): Promise<void> {
  await authPool.query("DELETE FROM app.users WHERE id = $1", [userId]);
}

// One-way fingerprint of a bearer/session token for observability. Returns a short
// SHA-256 prefix so a security log can correlate repeated use of the *same* token
// without ever recording the token itself (session tokens must never reach logs).
function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

// Fixed secret used ONLY under the test runner so suites that don't set
// BETTER_AUTH_SECRET get a stable signing key within and across runs. Gated
// strictly behind an explicit test signal — never behind "not production" —
// so it can never sign a real session.
const TEST_AUTH_SECRET = "jarv1s-test-better-auth-secret";

function isTestRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

// Resolves the better-auth session-signing secret. A known/hardcoded constant
// must NEVER sign a real session, so the resolution order is:
//   1. BETTER_AUTH_SECRET / AUTH_SECRET from the environment — always preferred.
//   2. Test runner (VITEST / NODE_ENV=test) — a fixed test secret, gated behind
//      an explicit test signal only.
//   3. Production — FAIL FAST. A real deployment must provide its own secret.
//   4. Otherwise (local dev) — a strong, ephemeral per-process secret generated
//      at boot. This keeps headless LAN dev frictionless (no required env var to
//      start) while ensuring sessions are signed with a cryptographically-random
//      key, not a publicly-known constant. The trade-off is that sessions do not
//      survive a process restart in dev, which is acceptable; set
//      BETTER_AUTH_SECRET to make dev sessions durable.
function readAuthSecret(env: NodeJS.ProcessEnv, logger?: AuthLogger): string {
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET;

  if (secret) {
    return secret;
  }

  if (isTestRuntime(env)) {
    return TEST_AUTH_SECRET;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  const ephemeralSecret = randomBytes(32).toString("hex");
  logger?.warn?.(
    {
      event: "auth_ephemeral_secret"
    },
    "[auth] BETTER_AUTH_SECRET is not set. Generated a strong EPHEMERAL " +
      "session-signing secret for this process. All sessions will be invalidated " +
      "when the process restarts. Set BETTER_AUTH_SECRET to persist sessions."
  );
  return ephemeralSecret;
}

function readSocialProviders(
  env: NodeJS.ProcessEnv
): NonNullable<BetterAuthOptions["socialProviders"]> {
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  const google = readCredentialPair(
    env,
    "JARVIS_AUTH_GOOGLE_CLIENT_ID",
    "JARVIS_AUTH_GOOGLE_CLIENT_SECRET"
  );
  const github = readCredentialPair(
    env,
    "JARVIS_AUTH_GITHUB_CLIENT_ID",
    "JARVIS_AUTH_GITHUB_CLIENT_SECRET"
  );
  const microsoft = readCredentialPair(
    env,
    "JARVIS_AUTH_MICROSOFT_CLIENT_ID",
    "JARVIS_AUTH_MICROSOFT_CLIENT_SECRET"
  );

  if (google) {
    socialProviders.google = {
      clientId: google.clientId,
      clientSecret: google.clientSecret
    };
  }
  if (github) {
    socialProviders.github = {
      clientId: github.clientId,
      clientSecret: github.clientSecret
    };
  }
  if (microsoft) {
    socialProviders.microsoft = {
      clientId: microsoft.clientId,
      clientSecret: microsoft.clientSecret,
      tenantId: readString(env, "JARVIS_AUTH_MICROSOFT_TENANT_ID") ?? "common",
      authority: readString(env, "JARVIS_AUTH_MICROSOFT_AUTHORITY")
    };
  }

  return socialProviders;
}

function readAuthPlugins(env: NodeJS.ProcessEnv): NonNullable<BetterAuthOptions["plugins"]> {
  const oidcConfig = readOidcProviderConfig(env);

  return oidcConfig ? [genericOAuth({ config: [oidcConfig] })] : [];
}

function readOidcProviderConfig(env: NodeJS.ProcessEnv): GenericOAuthConfig | undefined {
  const credentials = readCredentialPair(
    env,
    "JARVIS_AUTH_OIDC_CLIENT_ID",
    "JARVIS_AUTH_OIDC_CLIENT_SECRET"
  );
  const discoveryUrl = readString(env, "JARVIS_AUTH_OIDC_DISCOVERY_URL");

  if (!credentials && !discoveryUrl) {
    return undefined;
  }
  if (!credentials || !discoveryUrl) {
    throw new Error(
      "JARVIS_AUTH_OIDC_CLIENT_ID, JARVIS_AUTH_OIDC_CLIENT_SECRET, and JARVIS_AUTH_OIDC_DISCOVERY_URL must be configured together"
    );
  }

  return {
    providerId: readString(env, "JARVIS_AUTH_OIDC_PROVIDER_ID") ?? "oidc",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    discoveryUrl,
    issuer: readString(env, "JARVIS_AUTH_OIDC_ISSUER"),
    requireIssuerValidation: readBoolean(env, "JARVIS_AUTH_OIDC_REQUIRE_ISSUER_VALIDATION"),
    scopes: ["openid", "email", "profile"],
    pkce: true
  };
}

function hasOidcProviderConfig(env: NodeJS.ProcessEnv): boolean {
  return (
    hasCredentialPair(env, "JARVIS_AUTH_OIDC_CLIENT_ID", "JARVIS_AUTH_OIDC_CLIENT_SECRET") &&
    readString(env, "JARVIS_AUTH_OIDC_DISCOVERY_URL") !== undefined
  );
}

function readCredentialPair(
  env: NodeJS.ProcessEnv,
  clientIdKey: string,
  clientSecretKey: string
): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = readString(env, clientIdKey);
  const clientSecret = readString(env, clientSecretKey);

  if (!clientId && !clientSecret) {
    return undefined;
  }
  if (!clientId || !clientSecret) {
    throw new Error(`${clientIdKey} and ${clientSecretKey} must be configured together`);
  }

  return { clientId, clientSecret };
}

function hasCredentialPair(
  env: NodeJS.ProcessEnv,
  clientIdKey: string,
  clientSecretKey: string
): boolean {
  return readCredentialPair(env, clientIdKey, clientSecretKey) !== undefined;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = resolveMossEnv(env, key)?.trim();

  return value || undefined;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = readString(env, key);

  if (value === undefined) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`${key} must be a boolean value`);
}
