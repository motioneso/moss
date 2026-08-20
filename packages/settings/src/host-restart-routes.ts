import { constants as fsConstants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner, User } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  getHostRestartRouteSchema,
  postHostRestartRouteSchema,
  type HostRestartResultDto,
  type HostRestartStatusDto
} from "@moss/shared";

import type { SettingsRepository } from "./repository.js";

/**
 * #1748 — admin "Restart app" button.
 *
 * The app does NOT restart anything. It creates a zero-byte sentinel in a bind-mounted
 * control directory; a systemd path unit on the host sees the file and runs the actual
 * `docker restart`. Mounting the Docker socket into this container was considered and
 * rejected: the socket is root-equivalent on the host, so any code execution inside the
 * app would become full host root — a permanent, unbounded blast radius bought for one
 * convenience button. See docs/superpowers/specs/2026-08-19-admin-restart-app-button.md.
 *
 * The consequence for this file is that there is nothing here to inject into. No request
 * value reaches a command, a path, or a filename: REQUEST_FILENAME and ALIVE_FILENAME are
 * constants, and the sentinel is written empty because the host unit never reads it.
 */

/** The sentinel the host unit watches for. Fixed — never derived from a request. */
const REQUEST_FILENAME = "restart-requested";
/** Touched by the host unit's installer and on every run, so the API can tell it exists. */
const ALIVE_FILENAME = "watcher-alive";

export interface HostRestartDependencies {
  /**
   * Absolute path to the bind-mounted control directory (`/data/control` in the shipped
   * compose file). Absent ⇒ the route fails closed with 503, matching the Herdr install
   * route's behaviour when its executor port is not wired.
   */
  readonly controlDir: string;
}

export interface HostRestartRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  readonly hostRestart?: HostRestartDependencies;
  readonly assertAdminUser: (scopedDb: DataContextDb, userId: string) => Promise<User>;
  readonly requireRequestId: (accessContext: AccessContext) => string;
  readonly handleRouteError: (error: unknown, reply: FastifyReply) => unknown;
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const readRequestedAt = async (path: string): Promise<string | null> => {
  try {
    const stats = await stat(path);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
};

export function registerHostRestartRoutes(
  server: FastifyInstance,
  dependencies: HostRestartRoutesDependencies
): void {
  /**
   * Authorize first, then surface the missing-port 503 — the same ordering as
   * host-install-routes.ts, so a non-admin cannot distinguish "not configured" from
   * "not allowed" and learn something about the deployment from a 403 vs a 503.
   */
  const authorize = async (request: FastifyRequest): Promise<AccessContext> => {
    const accessContext = await dependencies.resolveAccessContext(request);
    await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
      await dependencies.assertAdminUser(scopedDb, accessContext.actorUserId);
    });
    if (!dependencies.hostRestart) {
      throw new HttpError(503, "Restart is not available on this deployment");
    }
    return accessContext;
  };

  server.get(
    "/api/admin/host/restart",
    { schema: getHostRestartRouteSchema },
    async (request, reply) => {
      try {
        await authorize(request);
        const controlDir = (dependencies.hostRestart as HostRestartDependencies).controlDir;
        const body: HostRestartStatusDto = {
          hostWatcherInstalled: await fileExists(join(controlDir, ALIVE_FILENAME)),
          lastRequestedAt: await readRequestedAt(join(controlDir, REQUEST_FILENAME))
        };
        return body;
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/admin/host/restart",
    { schema: postHostRestartRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await authorize(request);
        const requestId = dependencies.requireRequestId(accessContext);
        const controlDir = (dependencies.hostRestart as HostRestartDependencies).controlDir;

        // If no host unit has ever been installed, nothing will act on the sentinel.
        // Report that instead of writing a file and claiming success — a button that
        // reports success and does nothing is worse than one that reports the truth.
        if (!(await fileExists(join(controlDir, ALIVE_FILENAME)))) {
          const rejected: HostRestartResultDto = {
            accepted: false,
            reason: "host-watcher-absent"
          };
          return rejected;
        }

        // Filesystem I/O deliberately OUTSIDE any open DB context (spec 993's 3-phase
        // ordering: exec/fs work never inside a transaction). Empty body on purpose —
        // the host unit never reads the file, so there is no parsed value to attack.
        await writeFile(join(controlDir, REQUEST_FILENAME), "", "utf8");

        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.repository.insertAuditEvent(scopedDb, {
            actorUserId: accessContext.actorUserId,
            action: "host.restart_requested",
            targetType: "host",
            targetId: null,
            metadata: {},
            requestId
          });
        });

        const accepted: HostRestartResultDto = { accepted: true };
        return accepted;
      } catch (error) {
        return dependencies.handleRouteError(error, reply);
      }
    }
  );
}
