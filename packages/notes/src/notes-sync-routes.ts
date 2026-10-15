import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { EmbeddingProvider } from "@moss/memory";
import { sendJob } from "@moss/jobs";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import { postNotesSyncRouteSchema, type PostNotesSyncResponse } from "@moss/shared";
import type { PreferencesRepository } from "@moss/structured-state";

import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { NOTES_SYNC_QUEUE } from "./manifest.js";
import type { NotesSyncJobPayload } from "./jobs.js";

interface NotesSyncRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: PreferencesRepository;
  readonly boss: PgBoss;
  readonly embeddingProviderFactory?: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
}

export function registerNotesSyncRoutes(
  server: FastifyInstance,
  dependencies: NotesSyncRoutesDependencies
): void {
  server.post("/api/notes/sync", { schema: postNotesSyncRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);

      const storedPath = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        dependencies.preferencesRepository.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY)
      );

      if (typeof storedPath !== "string" || storedPath.length === 0) {
        throw new HttpError(
          409,
          "No notes source configured. Set a path via PUT /api/me/notes-source first."
        );
      }

      const payload: NotesSyncJobPayload = {
        actorUserId: accessContext.actorUserId,
        sourcePath: storedPath
      };

      // Indexing runs in the worker process. Prepare the API's shared model as well, so the
      // first chat recall need not spend its 500 ms budget loading a cold model. Resolve
      // configuration in the owner's transaction, then release it before model loading.
      if (dependencies.embeddingProviderFactory) {
        void dependencies.dataContext
          .withDataContext(accessContext, dependencies.embeddingProviderFactory)
          .then((provider) => provider.embedQuery(""))
          .catch(() => {
            server.log.warn(
              { event: "notes.recall.prepare-failed" },
              "Notes recall preparation failed"
            );
          });
      }

      const jobId = await sendJob(dependencies.boss, NOTES_SYNC_QUEUE, payload, {
        singletonKey: `notes-sync:${accessContext.actorUserId}`
      });

      return reply.code(202).send({
        jobId: jobId ?? ""
      } satisfies PostNotesSyncResponse);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
}
