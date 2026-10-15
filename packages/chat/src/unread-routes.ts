import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  getChatUnreadRouteSchema,
  readChatMessagesRouteSchema,
  type ReadChatMessagesRequest
} from "@moss/shared";
import { ChatRepository } from "./repository.js";
import { handleRouteError } from "./route-errors.js";
import { ChatUnreadRepository } from "./unread-repository.js";

export function registerChatUnreadRoutes(
  server: FastifyInstance,
  deps: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly dataContext: DataContextRunner;
  }
) {
  const unread = new ChatUnreadRepository();
  const chat = new ChatRepository();
  server.get("/api/chat/unread", { schema: getChatUnreadRouteSchema }, async (request, reply) => {
    try {
      const access = await deps.resolveAccessContext(request);
      return await deps.dataContext.withDataContext(access, (db) => unread.counts(db));
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
  server.post<{ Params: { id: string }; Body: ReadChatMessagesRequest }>(
    "/api/chat/threads/:id/read",
    { schema: readChatMessagesRouteSchema },
    async (request, reply) => {
      try {
        const access = await deps.resolveAccessContext(request);
        const found = await deps.dataContext.withDataContext(access, async (db) => {
          const thread = await chat.getOwnedThreadById(db, access.actorUserId, request.params.id);
          if (!thread || thread.incognito || thread.surface !== "drawer") return false;
          await unread.markRead(db, thread.id, request.body.messageIds);
          return true;
        });
        if (!found) return reply.code(404).send({ error: "Chat thread not found" });
        return { ok: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
