import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import {
  deleteMyAccountRouteSchema,
  DELETE_MY_ACCOUNT_PHRASE,
  type DeleteMyAccountRequest
} from "@moss/shared";

import { deleteUserData, LastActiveAdminError } from "../../../scripts/delete-user-data.js";
import { HttpRepositoryError, type SettingsRepository } from "./repository.js";
import { handleSettingsRouteError } from "./route-error.js";

/**
 * Auth-owned password re-verification port for self-delete (#239). Mirrors the
 * `MossAuthRuntime.verifySelfPassword` signature so the composition root can
 * wire the runtime method directly. Returns a boolean only — never the hash.
 * Optional: when absent, a password-bearing account still fails closed —
 * `verifySelfPassword?.(...)` resolves to `undefined`, and the `=== true` check
 * turns that into a generic 400 "Confirmation does not match".
 */
export interface VerifySelfPasswordPort {
  (input: { readonly actorUserId: string; readonly password: string }): Promise<boolean>;
}

/**
 * Auth-owned existence probe: does the actor own a password credential? Lives
 * behind an auth port because migration 0045 revoked `jarvis_app_runtime`
 * SELECT on `app.auth_accounts` (password hashes live there). The settings
 * route layer cannot read that table; this port runs on the auth pool.
 * REQUIRED for the self-delete path: when absent the route cannot distinguish a
 * password-bearing account from an OAuth-only one, so it fails CLOSED with a
 * 500 (see readHasPasswordCredential) rather than silently skipping the
 * password factor — skipping would be a fail-open topology leak (#239 R2).
 */
export interface HasPasswordCredentialPort {
  (actorUserId: string): Promise<boolean>;
}

export interface MeAccountRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository: SettingsRepository;
  readonly bootstrapConnectionString?: string;
  readonly verifySelfPassword?: VerifySelfPasswordPort;
  readonly hasPasswordCredential?: HasPasswordCredentialPort;
  /** See SettingsRoutesDependencies.moduleDeletionTables (#801 Phase A). */
  readonly moduleDeletionTables: readonly { table: string; countPredicate: string }[];
  readonly reconcileExternalModuleJobs?: (change: {
    readonly kind: "user";
    readonly userId: string;
  }) => Promise<void>;
}

/**
 * Internal sentinel unwound to a 409 `{ code: "bootstrap_owner" }`. Distinct type
 * so the catch can map it without inspecting messages; the bootstrap-owner block
 * is a hard product rule (spec §Locked decision 4) and must never read through.
 */
class BootstrapOwnerSelfDeleteError extends Error {
  constructor() {
    super("The bootstrap owner cannot be deleted");
  }
}

/**
 * Internal sentinel unwound to a 409 `{ code: "last_admin" }`. Raised only when
 * `deleteUserData`'s authoritative advisory-lock re-assert throws
 * `LastActiveAdminError` — the fast-path pre-check's HttpRepositoryError 409 is
 * mapped directly in the catch without going through this class.
 */
class LastAdminSelfDeleteError extends Error {
  constructor() {
    super("Cannot remove the last active admin");
  }
}

/**
 * Existence-only probe exported for GET /api/me to reuse the same definition.
 * Delegates to the injected auth port — the settings layer cannot read
 * `app.auth_accounts` directly (migration 0045 RLS hardening).
 *
 * FAIL CLOSED: when the auth port is absent the self-delete route MUST reject
 * (500) rather than fall back to `false`. Returning `false` would make the
 * route treat the account as OAuth-only and skip the password factor — a
 * fail-open topology leak a hijacker could exploit (#239 R2, Gemini). The
 * generic GET /api/me path does not call this helper; it falls back to `false`
 * directly because that surface is a UI hint, not a security gate.
 */
export async function readHasPasswordCredential(
  hasPasswordCredential: HasPasswordCredentialPort | undefined,
  actorUserId: string
): Promise<boolean> {
  if (!hasPasswordCredential) {
    throw new HttpError(500, "password-credential probe not configured");
  }
  return hasPasswordCredential(actorUserId);
}

export function registerMeAccountRoutes(
  server: FastifyInstance,
  dependencies: MeAccountRoutesDependencies
): void {
  const repository = dependencies.repository;

  server.delete(
    "/api/me/account",
    {
      schema: deleteMyAccountRouteSchema,
      // Defense against a hijacked session brute-forcing the typed phrase or
      // password: strict per-principal cap, overriding the global throttle
      // (spec §Locked decision 10). Mirrors the persona-preview route's pattern.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          keyGenerator: sessionRateLimitKey
        }
      }
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const actorUserId = accessContext.actorUserId;
        const body = request.body as DeleteMyAccountRequest;

        // ALL pre-checks inside one data-context transaction so the email read,
        // guards, and confirmation share a single snapshot (spec §Hard invariants).
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const user = await repository.getUserById(scopedDb, actorUserId);
          // 404 is idempotent-friendly: a vanished row is "already deleted".
          if (!user) throw new HttpError(404, "User not found");

          // Confirmation factors FIRST (#239 R2, Codex). A hijacker with a bogus
          // body MUST prove they know the email + phrase + password BEFORE the
          // route evaluates any topology guard — otherwise a 409 bootstrap_owner /
          // last_admin leaks "this victim is the bootstrap owner / sole admin"
          // without any factor proof. The generic 400 below deliberately reveals
          // NO per-factor detail. Password-bearing accounts require verifySelfPassword
          // === true; OAuth-only accounts skip the password factor (email + phrase
          // is the floor, spec §Locked decision 3). hasPasswordCredential absent is
          // a hard 500 (readHasPasswordCredential fails closed — never silent skip).
          const hasPasswordCredential = await readHasPasswordCredential(
            dependencies.hasPasswordCredential,
            actorUserId
          );
          const emailMatch =
            body.confirmEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
          const phraseMatch = body.confirmPhrase === DELETE_MY_ACCOUNT_PHRASE;
          const passwordOk = hasPasswordCredential
            ? typeof body.password === "string" &&
              body.password.length > 0 &&
              (await dependencies.verifySelfPassword?.({
                actorUserId,
                password: body.password
              })) === true
            : true;
          if (!emailMatch || !phraseMatch || !passwordOk) {
            throw new HttpError(400, "Confirmation does not match");
          }

          // Topology guards run ONLY after the caller has proven all factors.
          // Bootstrap owner is never self-deletable (recovery is #260's path).
          if (user.is_bootstrap_owner) throw new BootstrapOwnerSelfDeleteError();

          // Last-active-admin fast-path pre-check. deleteUserData re-asserts
          // authoritatively under its advisory lock; this just short-circuits
          // the common case before the expensive teardown (spec §Locked decision 5).
          if (user.is_instance_admin) {
            await repository.assertNotLastActiveAdmin(scopedDb, actorUserId);
          }
        });

        // Outside withDataContext: deleteUserData opens its own bootstrap transaction,
        // re-asserts the last-admin guard under the advisory lock, writes the audit
        // row, deletes the user (cascade removes sessions + every owner-scoped row),
        // commits, then removes the vault subtree. auditAction discriminates the
        // self-service surface from the admin one in the audit log (spec Q4).
        try {
          await deleteUserData({
            userId: actorUserId,
            confirmUserId: actorUserId,
            actorUserId,
            requestId: accessContext.requestId,
            bootstrapConnectionString: dependencies.bootstrapConnectionString,
            dryRun: false,
            auditAction: "user.delete.self",
            moduleDeletionTables: dependencies.moduleDeletionTables
          });
        } catch (error) {
          if (error instanceof LastActiveAdminError) {
            throw new LastAdminSelfDeleteError();
          }
          throw error;
        }

        try {
          await dependencies.reconcileExternalModuleJobs?.({ kind: "user", userId: actorUserId });
        } catch (error) {
          request.log.warn(
            { userId: actorUserId, errorName: (error as Error).name },
            "external module user schedule reconcile failed"
          );
        }

        // The caller's own session was cascade-deleted by the user-row delete;
        // a 200 means "you are signed out everywhere" (spec §Locked decision 8).
        return { deletedUserId: actorUserId };
      } catch (error) {
        // Coded 409s carry a stable discriminator the client maps to guidance.
        if (error instanceof BootstrapOwnerSelfDeleteError) {
          return reply.code(409).send({ code: "bootstrap_owner" });
        }
        if (error instanceof LastAdminSelfDeleteError) {
          return reply.code(409).send({ code: "last_admin" });
        }
        // Fast-path last-admin guard (repository HttpRepositoryError 409) — same
        // discriminator as the authoritative re-assert; the two are indistinguishable
        // to the client by design.
        if (error instanceof HttpRepositoryError && error.statusCode === 409) {
          return reply.code(409).send({ code: "last_admin" });
        }
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
