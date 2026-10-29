import type { FastifyInstance } from "fastify";
import type { ChatSessionManager } from "./live/chat-session-manager.js";
import { type ModuleNoticeService, MODULE_NOTICE_ARRIVAL_CHANNEL } from "./module-notices.js";
import {
  startStoredMessageArrivalListener,
  type StoredMessageArrivalListener
} from "./stored-message-arrival.js";

export interface ModuleNoticeArrivalDependencies {
  readonly connectionString?: string;
  readonly notices: ModuleNoticeService;
}

/** Only the host installs the configured notice service. No source definitions means no listener. */
export function registerModuleNoticeArrivalLifecycle(
  server: FastifyInstance,
  deps: ModuleNoticeArrivalDependencies & {
    readonly manager: Pick<ChatSessionManager, "deliverBackgroundMessage">;
  }
): void {
  const { connectionString } = deps;
  if (!connectionString) return;
  let listener: StoredMessageArrivalListener | undefined;
  server.addHook("onReady", async () => {
    listener = startStoredMessageArrivalListener({
      connectionString,
      channel: MODULE_NOTICE_ARRIVAL_CHANNEL,
      label: "module notice arrival",
      read: (arrival) => deps.notices.readArrival({ actorUserId: arrival.actorUserId }, arrival),
      deliver: (message) => deps.manager.deliverBackgroundMessage(message),
      warn: (err, message) => server.log.warn({ err }, message)
    });
    await listener.ready;
  });
  server.addHook("onClose", async () => {
    await listener?.stop();
  });
}
