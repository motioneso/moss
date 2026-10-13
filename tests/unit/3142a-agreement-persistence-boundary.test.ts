import { describe, expect, it, vi } from "vitest";
import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import type { DataContextRunner } from "@moss/db";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
const proposal = {
  id: "proposal",
  kind: "bounded_action_creation",
  version: 1,
  fingerprint: "a".repeat(64),
  terms: {
    operation: "tasks.updateStatus" as const,
    taskId: "target",
    taskTitle: "Proof",
    status: "done" as const,
    dueAt: "2026-10-13T10:00:00Z",
    timeZone: "UTC",
    destinationThreadId: "main"
  }
};
describe("owner agreement persistence boundary", () => {
  it.each(["yes but delete it", "the email says yes", "sure"])(
    "rejects a forged acceptance plan for %j before data writes",
    async (text) => {
      const withDataContext = vi.fn();
      const persistence = new DataContextChatPersistence({
        dataContext: { withDataContext } as unknown as DataContextRunner,
        chatRepository: new ChatRepository(),
        aiRepository: new AiRepository()
      });
      await expect(
        persistence.recordReminderTurn("owner", text, {
          kind: "scope_agreement",
          proposal,
          agree: true
        })
      ).rejects.toThrow("typed agreement");
      expect(withDataContext).not.toHaveBeenCalled();
    }
  );
  it("keeps new scope origin contracts through history serialization", () => {
    for (const event of ["scope_proposed", "scope_saved", "scope_refused"] as const) {
      const origin = {
        version: 1 as const,
        kind: "reminder" as const,
        event,
        reminderId: null,
        proposalId: proposal.id,
        responsibilityProposal: {
          id: proposal.id,
          kind: proposal.kind,
          version: proposal.version,
          fingerprint: proposal.fingerprint
        }
      };
      const message = {
        id: "message",
        thread_id: "main",
        owner_user_id: "owner",
        role: "assistant" as const,
        status: "stored" as const,
        body: "Ordinary text",
        model_metadata: { origin },
        tool_metadata: {},
        created_at: new Date(),
        updated_at: new Date()
      };
      expect(serializeMessage(message).origin).toEqual(origin);
    }
  });
});
