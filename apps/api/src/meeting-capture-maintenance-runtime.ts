import type { MossAuthRuntime } from "@moss/auth";
import { AbortablePgPool, withAbortableDataContext } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  createMeetingCaptureMaintenanceScheduler,
  registerMeetingCaptureMaintenanceWorker,
  MEETING_CAPTURE_MAINTENANCE_QUEUE
} from "@moss/meetings";

/** The API awaits start at readiness and close in its preClose hook. */
export interface MeetingCaptureMaintenanceRuntime {
  start(): Promise<void>;
  /** Must also be safe when readiness never started or start failed. */
  close(): Promise<void>;
}

/**
 * Queue claiming uses the existing worker role, as does the API's external-module consumer.
 * Auth-owned session/device/capability tables are unavailable to that role, and capture grants
 * deny worker credential projections. Keep the consumer beside the API's auth/app ports rather
 * than distribute auth credentials or widen the worker role. Background engines stay off here.
 */
export function createMeetingCaptureMaintenanceRuntime(input: {
  /** Borrowed send port; the caller owns producer readiness and shutdown. */
  producer: Pick<PgBoss, "send">;
  workerConnectionString: string;
  appConnectionString: string;
  auth: MossAuthRuntime;
}): MeetingCaptureMaintenanceRuntime {
  const consumer = createPgBossClient(input.workerConnectionString);
  let started = false;
  let maintenancePool: AbortablePgPool | undefined;
  return {
    async start() {
      const pool = new AbortablePgPool({
        connectionString: input.appConnectionString,
        application_name: "moss-abortable-data-context"
      });
      maintenancePool = pool;
      try {
        await consumer.start();
        started = true;
        await registerMeetingCaptureMaintenanceWorker(consumer, {
          withDataContext: (actor, signal, work) =>
            withAbortableDataContext(pool, actor, signal, work),
          probeBinding: input.auth.recordingCapabilities.probeCaptureBinding,
          scheduleMaintenance: createMeetingCaptureMaintenanceScheduler(input.producer)
        });
      } catch (error) {
        await consumer.stop({ graceful: true });
        await pool.close();
        maintenancePool = undefined;
        started = false;
        throw error;
      }
    },
    async close() {
      if (!started) return;
      await consumer.offWork(MEETING_CAPTURE_MAINTENANCE_QUEUE, { wait: true });
      await consumer.stop({ graceful: true });
      await maintenancePool?.close();
      maintenancePool = undefined;
      started = false;
    }
  };
}
