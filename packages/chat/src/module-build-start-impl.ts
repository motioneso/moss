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
          title: deriveProjectTitle(input.description),
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

const TITLE_MAX_CHARACTERS = 60;

/**
 * A readable name for the project list, taken from the request the person typed.
 *
 * The first cut was a hard 40-character slice, which on a real request produced
 * "Garden watering reminders — reminds me w" (2026-09-05 live check). Prefer the first sentence,
 * then fall back to a word boundary, and only ever cut mid-word if a single word is longer than
 * the whole budget. The full request is always kept verbatim in initialRequest, so nothing said
 * here is lost.
 */
export function deriveProjectTitle(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  const firstSentence = collapsed.split(/(?<=[.!?])\s/)[0]?.trim() ?? collapsed;
  const candidate = firstSentence.length > 0 ? firstSentence : collapsed;
  const characters = Array.from(candidate);
  if (characters.length <= TITLE_MAX_CHARACTERS) return candidate;

  const clipped = characters.slice(0, TITLE_MAX_CHARACTERS).join("");
  const lastSpace = clipped.lastIndexOf(" ");
  // A word boundary is only useful if it leaves a real title behind, not one or two letters.
  const trimmed = lastSpace > TITLE_MAX_CHARACTERS / 3 ? clipped.slice(0, lastSpace) : clipped;
  return `${trimmed.replace(/[\s\u2013\u2014-]+$/, "")}…`;
}
