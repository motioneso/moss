import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  getChatArchiveSettingsRouteSchema,
  putChatArchiveSettingsRouteSchema,
  validateChatArchiveFolder,
  type ChatArchiveSettingsResponse,
  type PutChatArchiveSettingsRequest
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import type { ProfilePreferencesPort } from "./preferences-port.js";
import { handleSettingsRouteError } from "./route-error.js";

export const CHAT_ARCHIVE_ENABLED_PREF_KEY = "chat-archive.enabled";
export const CHAT_ARCHIVE_FOLDER_PREF_KEY = "chat-archive.folder";
export const CHAT_ARCHIVE_DEFAULT_FOLDER = "Moss/Chats";

interface ChatArchiveRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: ProfilePreferencesPort;
}

export function registerChatArchiveRoutes(
  server: FastifyInstance,
  dependencies: ChatArchiveRoutesDependencies
): void {
  server.get(
    "/api/me/chat-archive",
    { schema: getChatArchiveSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          readCurrent(scopedDb, dependencies.preferencesRepository)
        );
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/me/chat-archive",
    { schema: putChatArchiveSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PutChatArchiveSettingsRequest;
        let folder: string;
        try {
          folder = validateChatArchiveFolder(body.folder);
        } catch (validationError) {
          throw new HttpError(400, (validationError as Error).message);
        }
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await dependencies.preferencesRepository.upsert(
            scopedDb,
            CHAT_ARCHIVE_ENABLED_PREF_KEY,
            body.enabled
          );
          await dependencies.preferencesRepository.upsert(
            scopedDb,
            CHAT_ARCHIVE_FOLDER_PREF_KEY,
            folder
          );
          return readCurrent(scopedDb, dependencies.preferencesRepository);
        });
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

async function readCurrent(
  scopedDb: Parameters<ProfilePreferencesPort["get"]>[0],
  preferencesRepository: ProfilePreferencesPort
): Promise<ChatArchiveSettingsResponse> {
  const enabled = await preferencesRepository.get(scopedDb, CHAT_ARCHIVE_ENABLED_PREF_KEY);
  const folder = await preferencesRepository.get(scopedDb, CHAT_ARCHIVE_FOLDER_PREF_KEY);
  return {
    enabled: enabled === true,
    folder: typeof folder === "string" && folder.length > 0 ? folder : CHAT_ARCHIVE_DEFAULT_FOLDER
  };
}
