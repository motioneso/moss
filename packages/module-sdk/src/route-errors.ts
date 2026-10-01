import type { FastifyReply } from "fastify";

/**
 * Canonical HTTP error for module route handlers. Throwing this from a route or
 * repository carries an explicit status code through to the response.
 *
 * Consolidated here (was copied into five module route files) so that
 * `handleRouteError`'s `error instanceof HttpError` check works across every
 * module — a per-module class copy would fail a cross-module `instanceof` and
 * silently fall through to a 500.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Module-specific error mapper. Returns the sent reply when it handles the error,
 * or `undefined` to fall through to the next mapper / the shared handling below.
 * Use for module-local error classes (e.g. a connector or tool-validation error).
 */
export type RouteErrorMapper = (error: unknown, reply: FastifyReply) => unknown;

export interface HandleRouteErrorOptions {
  /**
   * Module-specific mappers, tried in order BEFORE the shared HttpError / auth /
   * DB-constraint branches. The first mapper to return a non-`undefined` value
   * wins.
   */
  readonly mappers?: readonly RouteErrorMapper[];
  /**
   * When set, database-constraint violations (foreign key, RLS policy, duplicate
   * key) are reported as 400 with this message instead of surfacing as 500. Omit
   * to let such errors propagate to the framework's default 500 handler.
   */
  readonly invalidRequestMessage?: string;
}

/**
 * The ONLY error message that maps to 401. A route is unauthenticated only
 * when session resolution itself failed — never as a catch-all.
 */
const AUTH_401_MESSAGES = new Set(["Session is missing or expired"]);

/**
 * Account-state failures thrown by session resolution. Mapped to 403 with a fixed message so the
 * thrown error's own text never reaches the client.
 */
const ACCOUNT_STATE_403: Readonly<Record<string, string>> = {
  account_pending_approval: "Account is pending approval",
  account_deactivated: "Account has been deactivated"
};

const DB_CONSTRAINT_FRAGMENTS = [
  "foreign key",
  "violates row-level security policy",
  "duplicate key"
] as const;

/**
 * Canonical route-error handler shared by every module REST route.
 *
 * This replaces nine per-module copies that drifted apart — several collapsed
 * *every* error (including RLS-denied reads that should be 404 and unexpected
 * failures that should be 500) into a generic 401, masking authz outcomes and
 * making failures undiagnosable. Status mapping, in order:
 *
 *  1. module-specific `mappers` (if provided)
 *  2. `HttpError` -> its own status code
 *  3. account pending approval / deactivated -> 403 with a fixed message
 *  4. genuine auth failures -> 401 (ONLY the message above)
 *  5. DB-constraint violations -> 400 (only when `invalidRequestMessage` is set)
 *  6. anything else -> a SCRUBBED 500: the original error is logged server-side
 *     but never echoed to the client, so internal details (stack fragments, SQL,
 *     library internals) cannot leak. Several per-module copies previously fell
 *     through to the framework's default handler, which echoes `error.message`.
 *
 * Not-found / authz-denied outcomes are handled by the routes themselves (an
 * explicit 404 before any throw); this handler never invents a 401 for them.
 */
export function handleRouteError(
  error: unknown,
  reply: FastifyReply,
  options: HandleRouteErrorOptions = {}
): unknown {
  for (const mapper of options.mappers ?? []) {
    const handled = mapper(error, reply);
    if (handled !== undefined) {
      return handled;
    }
  }

  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(ACCOUNT_STATE_403, code)) {
      return reply.code(403).send({ error: ACCOUNT_STATE_403[code], code });
    }
    if (AUTH_401_MESSAGES.has(error.message)) {
      return reply.code(401).send({ error: error.message });
    }
    if (
      options.invalidRequestMessage !== undefined &&
      DB_CONSTRAINT_FRAGMENTS.some((fragment) => error.message.includes(fragment))
    ) {
      return reply.code(400).send({ error: options.invalidRequestMessage });
    }
  }

  reply.log.error(error, "Unhandled route error");
  return reply.code(500).send({ error: "Internal server error" });
}
