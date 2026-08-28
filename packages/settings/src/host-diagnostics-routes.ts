import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner, User } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { getHostDiagnosticsRouteSchema } from "@moss/shared";

import { collectHostDiagnostics } from "./host-diagnostics-collect.js";
import type { HostDiagnosticsProvider } from "./host-diagnostics.js";
import type { SettingsRepository } from "./repository.js";
import type { GetChatMultiplexerStatus } from "./routes.js";

export interface HostDiagnosticsRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  readonly getChatMultiplexerStatus?: GetChatMultiplexerStatus;
  /** Runtime-facts provider; injected by the composition root. Absent → 503. */
  readonly hostDiagnostics?: HostDiagnosticsProvider;
  readonly assertAdminUser: (scopedDb: DataContextDb, userId: string) => Promise<User>;
  readonly handleRouteError: (error: unknown, reply: FastifyReply) => unknown;
}

/**
 * GET /api/admin/host/diagnostics — admin-only, read-only, secret-safe (#255).
 *
 * The admin check and the DB connectivity probe share ONE transaction (the
 * established settings pattern). The response is built only from explicit,
 * allowlisted, non-secret fields by buildHostDiagnostics — no env/config/process
 * dump — and that builder also runs assertDiagnosticsSafe as a final guard.
 */
export function registerHostDiagnosticsRoutes(
  server: FastifyInstance,
  dependencies: HostDiagnosticsRoutesDependencies
): void {
  server.get(
    "/api/admin/host/diagnostics",
    { schema: getHostDiagnosticsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.assertAdminUser(scopedDb, accessContext.actorUserId);
          // Authorization passed — only now is it safe to surface the 503 if the
          // provider is missing, so a non-admin can never distinguish the states.
          if (!dependencies.hostDiagnostics) {
            throw new HttpError(503, "Host diagnostics are not available");
          }
          return collectHostDiagnostics(
            {
              repository: dependencies.repository,
              hostDiagnostics: dependencies.hostDiagnostics,
              getChatMultiplexerStatus: dependencies.getChatMultiplexerStatus
            },
            scopedDb
          );
        });
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );
}
