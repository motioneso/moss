import type { AiRepository, AssistantToolGateway } from "@moss/ai";
import type { MossDatabase } from "@moss/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

/** Keep recovery timers and admitted notifications within the server lifecycle. */
export function registerActionNotificationLifecycle(
  server: FastifyInstance,
  deps: {
    readonly gateway?: AssistantToolGateway;
    readonly repository?: AiRepository;
    readonly rootDb: Kysely<MossDatabase>;
    readonly shutdown: () => void;
    readonly flush: () => Promise<void>;
  }
): void {
  server.addHook("onClose", async () => {
    deps.gateway?.disposeActionRecovery();
    deps.shutdown();
    await deps.flush();
  });
  server.addHook("onReady", async () => {
    if (!deps.repository) return;
    try {
      // Only legacy requests without durable deadlines use this existing cleanup.
      const count = await deps.repository.cancelStalePendingAssistantActions(deps.rootDb, {
        olderThan: new Date(Date.now() - 5 * 60_000)
      });
      if (count > 0) server.log.info({ count }, "cancelled stale assistant action requests");
    } catch (err) {
      server.log.warn({ err }, "stale assistant action cleanup failed");
    }
  });
}
