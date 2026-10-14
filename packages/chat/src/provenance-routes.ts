import type { FastifyInstance } from "fastify";
import type { AnswerSourceSupportCard } from "@moss/shared";
import type { ChatRoutesDependencies } from "./routes.js";
import type { ChatRepository } from "./repository.js";
import { readStoredProvenance, provenanceCards } from "./live/answer-provenance.js";
import { readMeetingChatContext } from "./live/meeting-chat-runtime.js";
import { dereferenceMeetingCitation, isMeetingEvidenceAvailable } from "./meeting-chat-boundary.js";
import { asRecord } from "./route-serializers.js";
import { handleRouteError } from "./route-errors.js";

export function registerChatProvenanceRoutes(
  server: FastifyInstance,
  dependencies: Pick<ChatRoutesDependencies, "resolveAccessContext" | "dataContext">,
  repository: ChatRepository,
  meetingChat: Parameters<typeof dereferenceMeetingCitation>[0] | undefined
): void {
  // ── Answer provenance ──────────────────────────────────────────────────────

  server.get<{ Params: { messageId: string } }>(
    "/api/chat/messages/:messageId/provenance",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const message = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.getMessageById(scopedDb, request.params.messageId)
        );
        if (!message || message.owner_user_id !== access.actorUserId) {
          return reply.code(404).send({ error: "Message not found" });
        }
        const toolMetadata = asRecord(message.tool_metadata);
        const meetingBinding = readMeetingChatContext(toolMetadata);
        if (!(await isMeetingEvidenceAvailable(meetingChat, access, meetingBinding)))
          return reply.code(404).send({ error: "Meeting evidence unavailable" });
        const stored = readStoredProvenance(toolMetadata);
        const cards: AnswerSourceSupportCard[] = stored != null ? provenanceCards(stored) : [];
        return { cards };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: { messageId: string; supportId: string } }>(
    "/api/chat/messages/:messageId/provenance/:supportId/dereference",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const message = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.getMessageById(scopedDb, request.params.messageId)
        );
        if (!message || message.owner_user_id !== access.actorUserId) {
          return reply.code(404).send({ error: "Message not found" });
        }
        const toolMetadata = asRecord(message.tool_metadata);
        const meetingBinding = readMeetingChatContext(toolMetadata);
        if (!(await isMeetingEvidenceAvailable(meetingChat, access, meetingBinding)))
          return reply.code(404).send({ error: "Meeting evidence unavailable" });
        const stored = readStoredProvenance(toolMetadata);
        if (!stored) return reply.code(404).send({ error: "No provenance for this message" });

        const supportItem = stored.supportItems.find(
          (item) => item.supportId === request.params.supportId
        );
        if (!supportItem) return reply.code(404).send({ error: "Support item not found" });

        if (meetingBinding && meetingChat)
          return dereferenceMeetingCitation(
            meetingChat,
            access,
            meetingBinding,
            request.params.supportId
          );
        // Other source providers are not registered yet.
        return {
          unavailableReason: "source_unavailable" as const,
          sourceLabel: supportItem.sourceLabel,
          title: supportItem.title
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
