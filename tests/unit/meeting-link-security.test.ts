import { createCompanionDevicesService } from "../../packages/auth/src/companion-devices.js";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { acquireCaptureBinding } from "../../packages/auth/src/capture-binding.js";
import { createSessionBindingsService } from "../../packages/auth/src/session-bindings.js";
import { captureStartBudget } from "../../packages/meetings/src/capture-start-limiter.js";
import { withCaptureBindingTransaction } from "../../packages/meetings/src/capture-binding.js";
import { captureAuthorizationError } from "../../packages/meetings/src/capture-authorization.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";
import type { CaptureGrant } from "../../packages/meetings/src/capture-repository.js";
import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
const binding = {
  actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  capabilityRevision: 1
};
function authFixture(missing?: string, fail?: string) {
  const query = vi.fn(async (statement: string) => {
    if (fail && statement.includes(fail))
      throw Object.assign(new Error("synthetic lock busy"), { code: "55P03" });
    return { rows: missing && statement.includes(`FROM app.${missing} `) ? [] : [{ id: "owned" }] };
  });
  const release = vi.fn();
  const client = { query, release };
  return { query, release, pool: { connect: async () => client } as unknown as pg.Pool };
}
describe("Mac link auth fence and limiter", () => {
  it.each([
    ["users", "session-ended"],
    ["better_auth_sessions", "session-ended"],
    ["companion_devices", "device-unavailable"],
    ["companion_recording_capabilities", "recording-permission-revoked"]
  ])("T1/T2/T3/T4 rejects absent %s and releases its auth transaction", async (table, reason) => {
    const f = authFixture(table);
    await expect(acquireCaptureBinding(f.pool, binding)).rejects.toMatchObject({
      bindingReason: reason
    });
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("T1/T4 fresh public session/device checks reject deleted rows", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = createSessionBindingsService({
      pool: { query } as unknown as pg.Pool,
      auth: { api: { getSession: vi.fn() } }
    });
    await expect(
      service.assertLive({ actorUserId: binding.actorUserId, deviceId: binding.deviceId })
    ).rejects.toMatchObject({ bindingReason: "device-unavailable" });
    await expect(
      service.assertLive({ actorUserId: binding.actorUserId, sessionId: binding.sessionId })
    ).rejects.toMatchObject({ bindingReason: "session-ended" });
  });
  it("holds all four owner-scoped row locks, uses live database time, and releases idempotently", async () => {
    const f = authFixture(),
      lease = await acquireCaptureBinding(f.pool, binding);
    expect(f.release).not.toHaveBeenCalled();
    const selects = f.query.mock.calls
      .map(([statement]) => statement)
      .filter((statement) => statement.startsWith("SELECT"));
    expect(selects).toHaveLength(4);
    for (const statement of selects) expect(statement).toContain("FOR SHARE NOWAIT");
    expect(selects[1]).toContain("expires_at>clock_timestamp()");
    expect(selects[2]).toContain("absolute_expires_at>clock_timestamp()");
    expect(selects[3]).toContain("revision=$3 AND revoked_at IS NULL");
    await lease.release();
    await lease.release();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("lock contention releases the client and remains temporary instead of revoking", async () => {
    const f = authFixture(undefined, "FROM app.companion_devices ");
    const error = await acquireCaptureBinding(f.pool, binding).catch((failure: unknown) => failure);
    expect(captureAuthorizationError(error)).toMatchObject({
      httpStatus: 503,
      revocationReason: undefined
    });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "retains auth through app commit or rollback (commit fails=%s)",
    async (failCommit) => {
      const events: string[] = [];
      const deps = {
        dataContext: {
          withDataContext: async (_actor: unknown, run: (db: never) => Promise<unknown>) => {
            const result = await run({} as never);
            events.push(failCommit ? "rollback" : "commit");
            if (failCommit) throw new Error("synthetic commit failure");
            return result;
          }
        },
        acquireRecordingBinding: async () => {
          events.push("auth-fence");
          return {
            release: async () => {
              events.push("release");
            }
          };
        }
      } as unknown as MeetingCaptureDependencies;
      const grant = {
        session_id: binding.sessionId,
        device_id: binding.deviceId,
        capability_revision: 1
      } as CaptureGrant;
      const pending = withCaptureBindingTransaction(
        deps,
        binding,
        async () => {
          events.push("app-locks");
          return grant;
        },
        async () => {
          events.push("write");
          return 1;
        }
      );
      if (failCommit) await expect(pending).rejects.toThrow("synthetic commit failure");
      else expect(await pending).toBe(1);
      expect(events).toEqual([
        "app-locks",
        "auth-fence",
        "write",
        failCommit ? "rollback" : "commit",
        "release"
      ]);
    }
  );
  it("T5 rechecks the grant deadline after waiting for its auth fence", async () => {
    let now = new Date("2026-10-06T12:00:00Z");
    const release = vi.fn(async () => {}),
      work = vi.fn(async () => 1);
    const deps = {
      now: () => now,
      dataContext: {
        withDataContext: async (_actor: unknown, run: (db: never) => Promise<unknown>) =>
          run({} as never)
      },
      acquireRecordingBinding: async () => {
        now = new Date(now.getTime() + 2000);
        return { release };
      }
    } as unknown as MeetingCaptureDependencies;
    const grant = {
      session_id: binding.sessionId,
      device_id: binding.deviceId,
      capability_revision: 1,
      expires_at: new Date(now.getTime() + 1000)
    } as CaptureGrant;
    await expect(
      withCaptureBindingTransaction(deps, binding, async () => grant, work)
    ).rejects.toMatchObject({ httpStatus: 401, revocationReason: "expired" });
    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("T2 logout-only credential retirement rejects cookies and malformed tokens before querying", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const devices = createCompanionDevicesService({ pool: { query } as unknown as pg.Pool });
    for (const headers of [
      {},
      { authorization: "Bearer tm1_short" },
      { authorization: `Bearer tm1_${"x".repeat(43)}`, cookie: "session=other" }
    ])
      await expect(devices.logoutCredential({ headers })).rejects.toMatchObject({
        httpStatus: 401
      });
    expect(query).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer tm1_${"x".repeat(43)}` };
    await expect(devices.logoutCredential({ headers })).resolves.toBeUndefined();
    await expect(devices.logoutCredential({ headers })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(query.mock.calls)).not.toContain(headers.authorization);
  });
  it("T10 refuses the eleventh rolling-minute Start with an accurate Retry-After", () => {
    const at = new Date("2026-10-06T12:00:00Z");
    let starts: Date[] = [];
    for (let index = 0; index < 10; index++)
      starts = captureStartBudget(starts, new Date(at.getTime() + index * 1000));
    expect(() => captureStartBudget(starts.reverse(), new Date(at.getTime() + 10000))).toThrow(
      expect.objectContaining({ httpStatus: 429, retryAfterSeconds: 50 })
    );
    expect(captureStartBudget(starts, new Date(at.getTime() + 60000))).toHaveLength(11);
  });
  it("T10 independently refuses the sixty-first hourly Start and expires old timestamps", () => {
    const at = new Date("2026-10-06T12:00:00Z");
    const starts = Array.from(
      { length: 60 },
      (_, index) => new Date(at.getTime() - 120000 - index * 1000)
    );
    expect(() => captureStartBudget(starts, at)).toThrow(
      expect.objectContaining({ httpStatus: 429, retryAfterSeconds: 3421 })
    );
    expect(captureStartBudget(starts, new Date(at.getTime() + 3600000))).toHaveLength(1);
  });
  it("T11 redacts every recording bearer/header/body secret while preserving caller policy", async () => {
    const logs: string[] = [];
    const server = Fastify({
      logger: recordingLoggerOptions({
        stream: new Writable({
          write(chunk, _encoding, done) {
            logs.push(String(chunk));
            done();
          }
        }),
        redact: { paths: ["existing"], censor: "hidden" },
        serializers: { req: (value) => ({ headers: value.headers, body: value.body }) }
      })
    });
    try {
      server.log.info({
        existing: "original-secret",
        headers: {
          authorization: "Bearer tm1_secret",
          "x-moss-recording-proof": "proof-secret",
          cookie: "cookie-secret"
        },
        req: {
          headers: { authorization: "Bearer mm1_secret" },
          body: {
            verifier: "verifier-secret",
            recordingProof: "proof-secret",
            pcmBase64: "audio-secret"
          }
        }
      });
      const text = logs.join("");
      for (const secret of [
        "original-secret",
        "tm1_secret",
        "mm1_secret",
        "proof-secret",
        "cookie-secret",
        "verifier-secret",
        "audio-secret"
      ])
        expect(text).not.toContain(secret);
      expect(text).toContain("hidden");
    } finally {
      await server.close();
    }
  });
});
