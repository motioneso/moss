import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import {
  SCRATCHPAD_MAX_CHARS,
  isValidShortcut,
  type AppendScratchpadRequest,
  type AppendScratchpadResponse,
  type PatchScratchpadSettingsRequest,
  type PatchScratchpadSettingsResponse,
  type PutScratchpadRequest,
  type PutScratchpadResponse,
  type ScratchpadConflictResponse,
  type ScratchpadResponse
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { ScratchpadRepository, ScratchpadTooLargeError } from "./repository.js";

export interface ScratchpadRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: ScratchpadRepository;
  readonly preferencesRepository?: PreferencesRepository;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be an object");
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, `${field} must be a non-negative integer`);
  }
  return value;
}

function sendTooLarge(reply: FastifyReply): unknown {
  return reply.code(413).send({ code: "scratchpad_too_large", maxChars: SCRATCHPAD_MAX_CHARS });
}

export function registerScratchpadRoutes(
  server: FastifyInstance,
  dependencies: ScratchpadRoutesDependencies
): void {
  const repository = dependencies.repository ?? new ScratchpadRepository();
  const preferences = dependencies.preferencesRepository ?? new PreferencesRepository();

  server.get("/api/scratchpad", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const response = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb): Promise<ScratchpadResponse> => {
          const state = await repository.get(scopedDb);
          const source = await preferences.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY);
          const notesFolderConfigured = typeof source === "string" && source.length > 0;
          return {
            body: state.body,
            revision: state.revision,
            updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
            maxChars: SCRATCHPAD_MAX_CHARS,
            syncToNotes: state.syncToNotes,
            notesFolderConfigured,
            shortcut: state.shortcut
          };
        }
      );
      return response;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.put("/api/scratchpad", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const parsed = requireObject(request.body) as unknown as PutScratchpadRequest;
      const body = requiredString(parsed.body, "body");
      const revision = requiredNumber(parsed.revision, "revision");

      if (body.length > SCRATCHPAD_MAX_CHARS) {
        return sendTooLarge(reply);
      }

      const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.put(scopedDb, { body, revision })
      );

      if (!result.ok) {
        const conflict: ScratchpadConflictResponse = {
          error: "scratchpad_conflict",
          body: result.current.body,
          revision: result.current.revision,
          updatedAt: result.current.updatedAt ? result.current.updatedAt.toISOString() : ""
        };
        return reply.code(409).send(conflict);
      }

      const response: PutScratchpadResponse = {
        revision: result.revision,
        updatedAt: result.updatedAt.toISOString()
      };
      return response;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.post("/api/scratchpad/append", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const parsed = requireObject(request.body) as unknown as AppendScratchpadRequest;
      const text = requiredString(parsed.text, "text").trim();

      if (text.length === 0) {
        throw new HttpError(400, "text must not be empty");
      }
      if (text.length > SCRATCHPAD_MAX_CHARS) {
        return sendTooLarge(reply);
      }

      let result;
      try {
        result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.append(scopedDb, text)
        );
      } catch (error) {
        if (error instanceof ScratchpadTooLargeError) {
          return sendTooLarge(reply);
        }
        throw error;
      }

      const response: AppendScratchpadResponse = {
        revision: result.revision,
        updatedAt: result.updatedAt.toISOString(),
        appended: result.appended
      };
      return response;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch("/api/scratchpad/settings", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const parsed = requireObject(request.body) as unknown as PatchScratchpadSettingsRequest;

      if (parsed.syncToNotes !== undefined && typeof parsed.syncToNotes !== "boolean") {
        throw new HttpError(400, "syncToNotes must be a boolean");
      }
      if (parsed.shortcut !== undefined) {
        if (typeof parsed.shortcut !== "string" || !isValidShortcut(parsed.shortcut)) {
          return reply.code(400).send({ code: "scratchpad_shortcut_invalid" });
        }
      }

      const result = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          if (parsed.syncToNotes === true) {
            const source = await preferences.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY);
            const notesFolderConfigured = typeof source === "string" && source.length > 0;
            if (!notesFolderConfigured) {
              return { conflict: true as const };
            }
          }
          const updated = await repository.patchSettings(scopedDb, {
            syncToNotes: parsed.syncToNotes,
            shortcut: parsed.shortcut
          });
          return { conflict: false as const, updated };
        }
      );

      if (result.conflict) {
        return reply.code(409).send({ code: "scratchpad_notes_folder_missing" });
      }

      const response: PatchScratchpadSettingsResponse = {
        syncToNotes: result.updated.syncToNotes,
        shortcut: result.updated.shortcut
      };
      return response;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
}
