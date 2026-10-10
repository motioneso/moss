import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  getQuietHoursSettingsRouteSchema,
  putQuietHoursSettingsRouteSchema,
  resolveQuietHoursConflictRouteSchema,
  type PutQuietHoursSettingsRequest,
  type ResolveQuietHoursConflictRequest
} from "@moss/shared";
import { PreferenceRevisionConflictError } from "@moss/structured-state";

import type { QuietHoursPreferencesPort } from "./preferences-port.js";
import { QUIET_HOURS_PREFERENCE_KEY } from "./quiet-hours-application.js";
import { readQuietHoursAuthority, type QuietHoursAuthorityRead } from "./quiet-hours-authority.js";
import { planQuietHoursResolution } from "./quiet-hours-resolution.js";
import {
  displayedQuietHours,
  quietHoursAuthorityDto,
  quietHoursAuthorityVersion,
  readQuietHoursForWrite,
  saveQuietHours
} from "./quiet-hours-writer.js";
import { handleSettingsRouteError } from "./route-error.js";

export const QUIET_HOURS_CONFLICT_MESSAGE =
  "Quiet hours changed somewhere else. Reload to see the latest schedule, then try again.";

interface QuietHoursRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: QuietHoursPreferencesPort;
}

export function registerQuietHoursRoutes(
  server: FastifyInstance,
  dependencies: QuietHoursRoutesDependencies
): void {
  server.get(
    "/api/me/quiet-hours",
    { schema: getQuietHoursSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);

        // Read-only: classification never materializes a carried schedule.
        const read = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          readQuietHoursAuthority(scopedDb)
        );
        return quietHoursResponse(read);
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/me/quiet-hours",
    { schema: putQuietHoursSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PutQuietHoursSettingsRequest;
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const before = await readQuietHoursForWrite(scopedDb);

          // The caller's full schedule was built from the version it read; any other version means
          // a newer save (or an undo) landed in between and this payload would overwrite it.
          if (quietHoursAuthorityVersion(before) !== body.expectedVersion) {
            throw new PreferenceRevisionConflictError(QUIET_HOURS_PREFERENCE_KEY);
          }

          const saved = await saveQuietHours(
            scopedDb,
            dependencies.preferencesRepository,
            before,
            body.quietHours
          );
          const after = saved.changed ? await readQuietHoursAuthority(scopedDb) : before;
          return quietHoursResponse(after);
        });
      } catch (error) {
        if (error instanceof PreferenceRevisionConflictError) {
          return reply.code(409).send({ error: QUIET_HOURS_CONFLICT_MESSAGE });
        }
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/me/quiet-hours/resolution",
    { schema: resolveQuietHoursConflictRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as ResolveQuietHoursConflictRequest;
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const before = await readQuietHoursForWrite(scopedDb);
          const plan = planQuietHoursResolution(before, quietHoursAuthorityVersion(before), body);
          if (plan.kind === "stale") {
            throw new PreferenceRevisionConflictError(QUIET_HOURS_PREFERENCE_KEY);
          }
          if (plan.kind === "unchanged") return quietHoursResponse(before);

          // The Profile row exists for every conflict, so this updates it in place under the lock.
          await dependencies.preferencesRepository.upsertWithRevision(
            scopedDb,
            QUIET_HOURS_PREFERENCE_KEY,
            plan.value,
            before.profileRow?.revision ?? null
          );
          return quietHoursResponse(await readQuietHoursAuthority(scopedDb));
        });
      } catch (error) {
        if (error instanceof PreferenceRevisionConflictError) {
          return reply.code(409).send({ error: QUIET_HOURS_CONFLICT_MESSAGE });
        }
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

function quietHoursResponse(read: QuietHoursAuthorityRead) {
  return {
    quietHours: displayedQuietHours(read),
    authority: quietHoursAuthorityDto(read),
    version: quietHoursAuthorityVersion(read)
  };
}
