import { WORKER_BOSS_OPTIONS } from "../../apps/worker/src/worker.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MossAuthRuntime } from "@moss/auth";
import type { PgBoss } from "@moss/jobs";
import type * as JobsModule from "@moss/jobs";
import { makeRecordingDb } from "./helpers/recording-db.js";
import {
  captureMaintenanceJobId,
  MEETING_CAPTURE_MAINTENANCE_MS,
  MEETING_CAPTURE_MAINTENANCE_HANDLER_MS,
  MEETING_CAPTURE_MAINTENANCE_QUEUES,
  createMeetingCaptureMaintenanceScheduler,
  maintainMeetingCapture,
  type CaptureMaintenanceDependencies
} from "../../packages/meetings/src/capture-maintenance.js";
import { captureView, type CaptureGrant } from "../../packages/meetings/src/capture-repository.js";
import type { CaptureStoredState } from "../../packages/meetings/src/capture-domain.js";
import { createMeetingCaptureMaintenanceRuntime } from "../../apps/api/src/meeting-capture-maintenance-runtime.js";

const hooks = vi.hoisted(() => ({
  events: [] as string[],
  workFailure: false,
  drain: async () => {}
}));
vi.mock("@moss/jobs", async (original) => ({
  ...(await original<typeof JobsModule>()),
  createPgBossClient: () => ({
    start: async () => {
      hooks.events.push("consumer-start");
    },
    work: async () => {
      hooks.events.push("register-worker");
      if (hooks.workFailure) throw new Error("synthetic worker registration failure");
    },
    offWork: async (_queue: string, options: { wait: boolean }) => {
      expect(options.wait).toBe(true);
      hooks.events.push("drain");
      await hooks.drain();
    },
    stop: async () => {
      hooks.events.push("consumer-stop");
    }
  })
}));
afterEach(() => {
  hooks.events.length = 0;
  hooks.workFailure = false;
  hooks.drain = async () => {};
  vi.restoreAllMocks();
});
const actorUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  grantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("durable capture maintenance", () => {
  it("budgets the full phase-aligned single-crash path from unlink inside30seconds", () => {
    const queue = MEETING_CAPTURE_MAINTENANCE_QUEUES[0]!.options!;
    const seconds =
      MEETING_CAPTURE_MAINTENANCE_MS / 1000 +
      1 +
      queue.expireInSeconds! +
      WORKER_BOSS_OPTIONS.superviseIntervalSeconds! +
      WORKER_BOSS_OPTIONS.monitorIntervalSeconds! +
      queue.retryDelay! +
      1 +
      MEETING_CAPTURE_MAINTENANCE_HANDLER_MS / 1000 +
      3;
    expect(seconds).toBe(25);
    expect(seconds).toBeLessThan(30);
    expect(MEETING_CAPTURE_MAINTENANCE_HANDLER_MS / 1000 + 3).toBeLessThan(queue.expireInSeconds!);
  });
  it("uses a deterministic per-sequence job ID, metadata only and the same transaction", async () => {
    const { scoped } = makeRecordingDb(),
      at = new Date("2026-10-06T00:00:00Z");
    const send = vi.fn(async (_queue, _payload, options) => options.id);
    await createMeetingCaptureMaintenanceScheduler({ send } as unknown as PgBoss)(
      scoped,
      { actorUserId },
      { grantId, sequence: 0, at }
    );
    expect(send).toHaveBeenCalledWith(
      "meetings.capture-maintenance",
      {
        actorUserId,
        resourceId: grantId,
        idempotencyKey: captureMaintenanceJobId(grantId, 0),
        version: 0
      },
      expect.objectContaining({
        id: captureMaintenanceJobId(grantId, 0),
        startAfter: new Date(at.getTime() + 5000),
        db: { executeSql: expect.any(Function) }
      })
    );
    expect(send.mock.calls[0]![2]).not.toHaveProperty("singletonKey");
    expect(captureMaintenanceJobId(grantId, 1)).not.toBe(captureMaintenanceJobId(grantId, 0));
  });
  it("fails closed when pg-boss suppresses the maintenance insert", async () => {
    const { scoped } = makeRecordingDb();
    await expect(
      createMeetingCaptureMaintenanceScheduler({ send: async () => null } as unknown as PgBoss)(
        scoped,
        { actorUserId },
        {
          grantId,
          sequence: 0,
          at: new Date()
        }
      )
    ).rejects.toMatchObject({ httpStatus: 503 });
  });
  it("rejects extra content, bad identities and unbounded sequences before database access", async () => {
    const dataContext = { withDataContext: vi.fn() };
    for (const payload of [
      {
        actorUserId,
        resourceId: grantId,
        version: 0,
        idempotencyKey: captureMaintenanceJobId(grantId, 0),
        transcript: "forbidden"
      },
      {
        actorUserId,
        resourceId: grantId,
        version: 1441,
        idempotencyKey: captureMaintenanceJobId(grantId, 1441)
      },
      { actorUserId, resourceId: grantId, version: 0, idempotencyKey: grantId }
    ])
      await expect(
        maintainMeetingCapture(payload, {
          dataContext
        } as unknown as CaptureMaintenanceDependencies)
      ).rejects.toThrow("Invalid capture maintenance metadata");
    expect(dataContext.withDataContext).not.toHaveBeenCalled();
  });
  it("internal maintenance sequence changes do not change the public capture revision", () => {
    const at = new Date("2026-10-06T00:00:00Z");
    const state = {
      generation: 1,
      desired: "recording",
      epochs: [],
      originAt: at.toISOString(),
      stopCutoffMs: null,
      finalizationDeadline: null,
      inventory: null,
      observed: null,
      gaps: [],
      gapLimitReached: false,
      lastSeenAt: at.toISOString(),
      maintenanceSequence: 0
    } satisfies CaptureStoredState;
    const grant = {
      id: grantId,
      status: "active",
      expires_at: new Date(at.getTime() + 7200000)
    } as CaptureGrant;
    expect(captureView(grant, state, at).revision).toBe(
      captureView(grant, { ...state, maintenanceSequence: 1 }, at).revision
    );
  });
  it("starts an injected producer before its consumer and drains work before dependent pools close", async () => {
    const runtime = createMeetingCaptureMaintenanceRuntime({
      producer: {
        start: async () => {
          hooks.events.push("producer-start");
        }
      } as unknown as PgBoss,
      workerConnectionString: "synthetic unused connection",
      appConnectionString: "synthetic unused app connection",
      auth: {
        sessionBindings: { assertLive: vi.fn() },
        recordingCapabilities: { assertLive: vi.fn() }
      } as unknown as MossAuthRuntime
    });
    await runtime.start();
    let release!: () => void;
    hooks.drain = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const closed = runtime.close().then(() => {
      hooks.events.push("auth-app-pools-close");
    });
    await Promise.resolve();
    expect(hooks.events).toEqual(["producer-start", "consumer-start", "register-worker", "drain"]);
    release();
    await closed;
    expect(hooks.events.slice(-2)).toEqual(["consumer-stop", "auth-app-pools-close"]);
  });
  it("failed worker registration closes the consumer and fails startup", async () => {
    hooks.workFailure = true;
    const runtime = createMeetingCaptureMaintenanceRuntime({
      producer: {
        start: async () => {
          hooks.events.push("producer-start");
        }
      } as unknown as PgBoss,
      workerConnectionString: "synthetic unused connection",
      appConnectionString: "synthetic unused app connection",
      auth: {
        sessionBindings: { assertLive: vi.fn() },
        recordingCapabilities: { assertLive: vi.fn() }
      } as unknown as MossAuthRuntime
    });
    await expect(runtime.start()).rejects.toThrow("synthetic worker registration failure");
    expect(hooks.events).toEqual([
      "producer-start",
      "consumer-start",
      "register-worker",
      "consumer-stop"
    ]);
    await runtime.close();
    expect(hooks.events).toHaveLength(4);
  });
});
