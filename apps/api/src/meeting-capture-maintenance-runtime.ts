import type { MossAuthRuntime } from "@moss/auth";
import { withAbortableDataContext } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  createMeetingCaptureMaintenanceScheduler,
  registerMeetingCaptureMaintenanceWorker,
  MEETING_CAPTURE_MAINTENANCE_QUEUE
} from "@moss/meetings";

/** Queue claiming uses the existing worker role; capture data/identity stays in the API's ports. */
export function createMeetingCaptureMaintenanceRuntime(input: {
  producer: PgBoss;
  workerConnectionString: string;
  appConnectionString: string;
  auth: MossAuthRuntime;
}) {
  const consumer = createPgBossClient(input.workerConnectionString);
  let started = false;
  return {
    async start() {
      try {
        await input.producer.start();
        await consumer.start();
        started = true;
        await registerMeetingCaptureMaintenanceWorker(consumer, {
          withDataContext: (actor, signal, work) =>
            withAbortableDataContext(input.appConnectionString, actor, signal, work),
          probeBinding: input.auth.recordingCapabilities.probeCaptureBinding,
          scheduleMaintenance: createMeetingCaptureMaintenanceScheduler(input.producer)
        });
      } catch (error) {
        await consumer.stop({ graceful: true });
        started = false;
        throw error;
      }
    },
    async close() {
      if (!started) return;
      await consumer.offWork(MEETING_CAPTURE_MAINTENANCE_QUEUE, { wait: true });
      await consumer.stop({ graceful: true });
      started = false;
    }
  };
}
