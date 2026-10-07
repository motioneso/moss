import type { DataContextRunner } from "@moss/db";

import { ConversationProvenanceStore } from "../../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../../packages/chat/src/repository.js";

/** Create once per test: outside admission is sticky for every token sharing an owner thread. */
export async function createCleanConversationFixture(
  runner: DataContextRunner,
  actorUserIds: readonly string[]
) {
  const repository = new ChatRepository();
  const threads = new Map<string, string>();
  for (const actorUserId of actorUserIds) {
    const thread = await runner.withDataContext({ actorUserId }, (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Gateway policy fixture" })
    );
    threads.set(actorUserId, thread.id);
  }
  return {
    gatewayDependencies: { runner, provenance: new ConversationProvenanceStore(runner) },
    bindingFor(actorUserId: string) {
      const threadId = threads.get(actorUserId);
      if (!threadId) throw new Error("No owned conversation was seeded for this fixture actor");
      return { actorUserId, threadId };
    }
  };
}
