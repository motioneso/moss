import {
  CHAT_VOICE_REQUEST_QUEUE,
  registerVoiceRequestWorker,
  type VoiceRequestService
} from "@moss/chat";
import { createPgBossClient } from "@moss/jobs";

/** Worker credentials claim jobs; the API's single Chat service owns private work. */
export function createVoiceRequestWorkerRuntime(
  workerConnectionString: string,
  getService: () => VoiceRequestService | undefined
) {
  const consumer = createPgBossClient(workerConnectionString);
  let started = false;
  return {
    async start() {
      const service = getService();
      if (!service) throw new Error("Chat voice admission unavailable");
      try {
        await consumer.start();
        await registerVoiceRequestWorker(consumer, service);
        started = true;
      } catch (error) {
        await consumer.stop({ graceful: true });
        throw error;
      }
    },
    async close() {
      if (!started) return;
      try {
        await consumer.offWork(CHAT_VOICE_REQUEST_QUEUE, { wait: true });
      } finally {
        try {
          await consumer.stop({ graceful: true });
        } finally {
          started = false;
        }
      }
    }
  };
}
