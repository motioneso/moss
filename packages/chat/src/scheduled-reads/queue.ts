import type { QueueDefinition } from "@moss/jobs";
export const CHAT_SCHEDULED_READ_QUEUE = "chat.scheduled-read";
export const CHAT_SCHEDULED_READ_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_SCHEDULED_READ_QUEUE,
  options: {
    retryLimit: 1,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 60,
    retentionSeconds: 3_456_000,
    deleteAfterSeconds: 86_400
  }
};

export const CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE = "chat.scheduled-read-bookkeeping";
export const CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  options: { ...CHAT_SCHEDULED_READ_QUEUE_DEFINITION.options, retryLimit: 1 }
};

export interface ScheduledReadWatchdogPayload {
  readonly actorUserId: string;
  readonly resourceId: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly operationId?: string;
  readonly step: number;
}
