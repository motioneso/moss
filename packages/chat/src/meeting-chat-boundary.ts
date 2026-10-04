import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertDataContextDb, type AccessContext, type DataContextDb } from "@moss/db";
import {
  meetingChatSurface,
  meetingIdFromChatSurface,
  normalizeChatSurface,
  type StoredMeetingChatContext
} from "@moss/shared";
import { MeetingChatError, meetingSourceCards } from "./live/meeting-chat-service.js";
import { MeetingContextUnavailableError } from "./live/meeting-context.js";
import type { MeetingChatRuntime } from "./live/meeting-chat-runtime.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function meetingChatFailure(error: unknown, reply: FastifyReply) {
  if (error instanceof MeetingContextUnavailableError)
    return reply.code(404).send({ code: "meeting_context_unavailable", error: error.message });
  if (error instanceof MeetingChatError)
    return reply
      .code(
        error.code === "meeting_chat_unsupported"
          ? 422
          : error.code === "meeting_chat_changed"
            ? 409
            : 503
      )
      .send({ code: error.code, error: error.message });
  return reply.code(503).send({
    code: "meeting_chat_failed",
    error: "Meeting questions are unavailable. Please try again."
  });
}

/** Reserved surfaces never reach a general tool-capable engine, including stream pre-launch/seed. */
export function registerMeetingChatBoundary(
  server: FastifyInstance,
  deps: {
    resolveAccessContext(request: FastifyRequest): Promise<AccessContext>;
    readonly runtime?: MeetingChatRuntime;
  }
) {
  server.get("/api/chat/meeting-context", async (_request, reply) =>
    reply.code(400).send({ error: "Select a meeting." })
  );
  server.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/chat/")) return;
    const body = object(request.body);
    const query = object(request.query);
    const rawSurface = body.surface ?? query.surface;
    const selection = object(body.meetingContext);
    const reserved = [body.surface, query.surface].some(
      (value) => typeof value === "string" && value.startsWith("mtg-")
    );
    if (!reserved && body.meetingContext === undefined) return;
    let meetingId: string | null;
    let surface;
    try {
      surface = normalizeChatSurface(rawSurface);
      meetingId = meetingIdFromChatSurface(surface);
      if (
        !meetingId ||
        (body.surface !== undefined &&
          query.surface !== undefined &&
          body.surface !== query.surface)
      )
        throw new Error("surface");
    } catch {
      return reply.code(400).send({ error: "Invalid meeting chat selection." });
    }
    let access: AccessContext;
    try {
      access = await deps.resolveAccessContext(request);
    } catch {
      return reply.code(401).send({ error: "Session is missing or expired" });
    }
    const runtime = deps.runtime;
    try {
      if (!runtime || !(await runtime.source.isAvailable(access, meetingId)))
        throw new MeetingContextUnavailableError();
      if (request.method === "GET" && path === "/api/chat/meeting-context")
        return reply.send({ available: true });
      if (request.method === "GET" && path === "/api/chat/privacy")
        return reply.send({ incognito: false });
      if (request.method === "POST" && path === "/api/chat/turn/cancel") {
        runtime.service.cancel(access.actorUserId, surface);
        return reply.send({ ok: true });
      }
      if (request.method === "POST" && path === "/api/chat/clear") {
        if (query.surface !== surface)
          return reply.code(400).send({ error: "Meeting surface must be supplied in the query." });
        if (query.incognito === "true" || query.incognito === "1")
          return reply.code(400).send({ error: "Private meeting chat is unavailable." });
        runtime.service.cancel(access.actorUserId, surface);
        return;
      }
      if (
        request.method === "GET" &&
        (path === "/api/chat/threads" || /^\/api\/chat\/threads\/[^/]+\/messages$/.test(path))
      ) {
        if (query.surface !== surface)
          return reply.code(400).send({ error: "Meeting surface must be supplied in the query." });
        return;
      }
      if (request.method !== "POST" || path !== "/api/chat/turn")
        return reply
          .code(400)
          .send({ error: "This operation is unavailable in meeting questions." });
      if (
        selection.meetingId !== meetingId ||
        typeof selection.selectionId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(selection.selectionId) ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 32_000 ||
        body.controlContext !== undefined ||
        body.attachmentIds !== undefined
      )
        return reply
          .code(400)
          .send({ error: "Invalid meeting question. Attachments and actions are unavailable." });
      const result = await runtime.service.submit(
        access,
        surface,
        { meetingId, selectionId: selection.selectionId },
        body.text.trim()
      );
      // Revalidate browser session as well as resource authorization before release.
      const currentAccess = await deps.resolveAccessContext(request);
      if (
        currentAccess.actorUserId !== access.actorUserId ||
        !(await runtime.source.isAvailable(currentAccess, meetingId))
      )
        throw new MeetingContextUnavailableError();
      return reply.send(result);
    } catch (error) {
      return meetingChatFailure(error, reply);
    }
  });
  server.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode >= 400 || !request.url.startsWith("/api/chat/")) return payload;
    const raw = object(request.body).surface ?? object(request.query).surface;
    if (typeof raw !== "string" || !raw.startsWith("mtg-")) return payload;
    try {
      const meetingId = meetingIdFromChatSurface(raw);
      const access = await deps.resolveAccessContext(request);
      if (
        !meetingId ||
        !deps.runtime ||
        !(await deps.runtime.source.isAvailable(access, meetingId))
      )
        throw new MeetingContextUnavailableError();
      return payload;
    } catch {
      reply.code(404).type("application/json");
      return JSON.stringify({
        code: "meeting_context_unavailable",
        error: "Meeting context is unavailable."
      });
    }
  });
}

/** Public cleanup seam called by Meetings under the same authorized deletion transaction. */
export async function deleteMeetingChatThreads(
  db: DataContextDb,
  meetingId: string
): Promise<void> {
  assertDataContextDb(db);
  await db.db
    .deleteFrom("app.chat_threads")
    .where("surface", "=", meetingChatSurface(meetingId))
    .execute();
}

export async function dereferenceMeetingCitation(
  runtime: MeetingChatRuntime,
  access: AccessContext,
  binding: StoredMeetingChatContext,
  supportId: string
) {
  const result = await runtime.context.dereference(access, binding, supportId);
  if (!result.available)
    return {
      unavailableReason: "source_unavailable" as const,
      sourceLabel: "Meeting evidence",
      title: "Unavailable"
    };
  const card = meetingSourceCards(binding).find((item) => item.supportId === supportId)!;
  const { citation } = result;
  const query = new URLSearchParams({
    id: citation.meetingId,
    segmentId: citation.segmentId,
    segmentRevision: String(citation.segmentRevision),
    startCharacter: String(citation.startCharacter),
    endCharacter: String(citation.endCharacter)
  });
  return {
    sourceLabel: card.sourceLabel,
    title: card.title,
    snippet: result.excerpt,
    deepLinkPath: `/meetings?${query}`
  };
}
