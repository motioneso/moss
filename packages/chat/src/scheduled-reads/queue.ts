import type { QueueDefinition } from "@moss/jobs";
export const CHAT_SCHEDULED_READ_QUEUE = "chat.scheduled-read";
export const CHAT_SCHEDULED_READ_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_SCHEDULED_READ_QUEUE,
  options: {
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 60,
    retentionSeconds: 3_456_000,
    deleteAfterSeconds: 86_400
  }
};
