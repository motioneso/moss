import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  getQuietHoursSettingsRouteSchema,
  putQuietHoursSettingsRouteSchema,
  type PutQuietHoursSettingsRequest
} from "@moss/shared";
import { PreferenceRevisionConflictError } from "@moss/structured-state";

import type { QuietHoursPreferencesPort } from "./preferences-port.js";
import {
  applyQuietHoursEdit,
  normalizeQuietHours,
  QUIET_HOURS_PREFERENCE_KEY,
  quietHoursVersion
} from "./quiet-hours-application.js";
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
        const row = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.preferencesRepository.getVersioned(scopedDb, QUIET_HOURS_PREFERENCE_KEY)
        );
        return { quietHours: normalizeQuietHours(row?.value), version: quietHoursVersion(row) };
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
          const repository = dependencies.preferencesRepository;
          const row = await repository.getVersioned(scopedDb, QUIET_HOURS_PREFERENCE_KEY, {
            forUpdate: true
          });

          // The caller's full schedule was built from the version it read; any other version means
          // a newer save (or an undo) landed in between and this payload would overwrite it.
          if (quietHoursVersion(row) !== body.expectedVersion) {
            throw new PreferenceRevisionConflictError(QUIET_HOURS_PREFERENCE_KEY);
          }

          const edit = applyQuietHoursEdit(row?.value, body.quietHours, row !== null);
          if (!edit.changed) {
            return { quietHours: edit.effective, version: quietHoursVersion(row) };
          }

          await repository.upsertWithRevision(
            scopedDb,
            QUIET_HOURS_PREFERENCE_KEY,
            edit.next,
            row?.revision ?? null
          );
          const saved = await repository.getVersioned(scopedDb, QUIET_HOURS_PREFERENCE_KEY);
          return { quietHours: edit.effective, version: quietHoursVersion(saved) };
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
