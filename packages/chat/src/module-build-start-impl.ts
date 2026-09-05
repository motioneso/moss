import { assertDataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  createWorkshopProject,
  WorkshopAdminRequiredError,
  WorkshopInputError,
  WorkshopProjectConflictError,
  type ModuleBuildStartService
} from "@moss/workshop";

import { parseSurfaceSessionKey } from "./live/chat-surface.js";
import { ChatRepository } from "./repository.js";

const PRIVATE_HANDOFF =
  "Open /workshop/new and choose what to save. This chat cannot authorize saving a Workshop project.";

/** The legacy tool name now creates only a project; it never plans or queues a build. */
export function buildModuleBuildStartService(): ModuleBuildStartService {
  const threads = new ChatRepository();
  return {
    async start(scopedDb, input) {
      assertDataContextDb(scopedDb);
      try {
        let source;
        try {
          source = parseSurfaceSessionKey(input.chatSessionId);
        } catch {
          throw new HttpError(403, PRIVATE_HANDOFF);
        }
        if (source.actorUserId !== input.actorUserId) throw new HttpError(403, PRIVATE_HANDOFF);
        const thread = await threads.getCurrentThread(scopedDb, input.actorUserId, source.surface);
        if (!thread || thread.incognito !== false) throw new HttpError(403, PRIVATE_HANDOFF);

        // createWorkshopProject verifies the active admin from the scoped DB actor, never input.
        return await createWorkshopProject(scopedDb, {
          requestKey: input.requestKey,
          title: Array.from(input.description).slice(0, 40).join(""),
          initialRequest: input.description
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof WorkshopAdminRequiredError)
          throw new HttpError(403, "Workshop requires an active instance administrator account.");
        if (error instanceof WorkshopProjectConflictError)
          throw new HttpError(
            409,
            "This request was already saved with different content. Open /workshop/new to save a new request."
          );
        if (error instanceof WorkshopInputError)
          throw new HttpError(
            400,
            "Check the project request, then try again or open /workshop/new."
          );
        throw new HttpError(
          500,
          "Workshop could not save this request. Retry with the same request key or open /workshop/new."
        );
      }
    }
  };
}
