import type { AbortablePgPool } from "@moss/db";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createRecordingCapabilitiesService,
  createSessionBindingsService,
  type CompanionDevicesService,
  type MossAuthRuntime
} from "@moss/auth";
import { registerCompanionRecordingRoutes } from "../../apps/api/src/companion-recording-routes.js";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const device = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const proof = "p".repeat(43);
const proofHash = createHash("sha256").update(proof).digest("hex");
const expiresAt = new Date("2030-01-01T00:00:00Z");

function fixture() {
  const row = { proof_hash: proofHash, revision: 4, expires_at: expiresAt };
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [row] }));
  const resolve = vi.fn(async () => ({ actorUserId: owner, deviceId: device, requestId: "test" }));
  const service = createRecordingCapabilitiesService({
    pool: { query } as unknown as pg.Pool,
    maintenancePool: { withClient: vi.fn() } as unknown as AbortablePgPool,
    companionDevices: { resolve } as unknown as CompanionDevicesService
  });
  return { row, query, resolve, service };
}

describe("independent recording capability proof", () => {
  it("requires independent proof in addition to the existing companion identity", async () => {
    const f = fixture();
    const base = { authorization: "Bearer tm1_synthetic" };
    await expect(f.service.resolve({ headers: base, requestId: "missing" })).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled();
    await expect(
      f.service.resolve({
        headers: { ...base, "x-moss-recording-proof": "x".repeat(43) },
        requestId: "wrong"
      })
    ).rejects.toThrow();
    const accepted = await f.service.resolve({
      headers: { ...base, "x-moss-recording-proof": proof },
      requestId: "right"
    });
    expect(accepted).toEqual({
      actorUserId: owner,
      deviceId: device,
      requestId: "test",
      capabilityRevision: 4,
      expiresAt
    });
    expect(JSON.stringify(accepted)).not.toContain(proof);
    expect(JSON.stringify(accepted)).not.toContain(proofHash);
    expect(f.query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual([device, owner]);
  });
  it("rejects cookie mixing and malformed proof before identity resolution", async () => {
    const f = fixture();
    for (const headers of [
      {
        authorization: "Bearer tm1_synthetic",
        cookie: "session=synthetic",
        "x-moss-recording-proof": proof
      },
      { authorization: "Bearer tm1_synthetic", "x-moss-recording-proof": "short" }
    ])
      await expect(f.service.resolve({ headers, requestId: "bad" })).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("never restores old authority after a capability revision changes", async () => {
    const f = fixture();
    const binding = { actorUserId: owner, deviceId: device, capabilityRevision: 4 };
    await expect(f.service.assertLive(binding)).resolves.toEqual({ expiresAt });
    f.row.revision = 6;
    await expect(f.service.assertLive(binding)).rejects.toThrow();
    await expect(f.service.assertLive({ ...binding, capabilityRevision: 6 })).resolves.toEqual({
      expiresAt
    });
    f.query.mockResolvedValueOnce({ rows: [] });
    await expect(f.service.assertLive({ ...binding, capabilityRevision: 6 })).rejects.toThrow();
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("c.revoked_at IS NULL");
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("u.status='active'");
  });
});

describe("recording capability approval HTTP boundary", () => {
  async function httpFixture() {
    const query = vi.fn(async () => ({ rows: [{ expires_at: expiresAt }] }));
    const bindings = createSessionBindingsService({
      pool: { query } as unknown as pg.Pool,
      auth: {
        api: { getSession: vi.fn(async () => ({ session: { id: session }, user: { id: owner } })) }
      }
    });
    const decide = vi.fn(async () => ({ status: "approved" as const, revision: 1 }));
    const list = vi.fn(async () => ({ devices: [] }));
    const app = Fastify();
    registerCompanionRecordingRoutes(app, {
      trustedOrigins: ["https://moss.example"],
      sessionBindings: bindings,
      recordingCapabilities: { decide, list }
    } as unknown as MossAuthRuntime);
    return { app, decide, list };
  }
  it.each([
    { authorization: "Bearer legacy-session", origin: "https://moss.example" },
    {
      authorization: "Bearer legacy-session",
      cookie: "session=synthetic",
      origin: "https://moss.example"
    },
    { cookie: "session=synthetic", origin: "https://foreign.example" },
    { cookie: "session=synthetic" }
  ])(
    "does not approve persistent capability for spoofed/non-cookie requests %#",
    async (headers) => {
      const f = await httpFixture();
      try {
        const response = await f.app.inject({
          method: "POST",
          url: "/api/companion/recording-capability/decide",
          headers,
          payload: { attemptId: device, decision: "approve", policyVersion: 1 }
        });
        expect(response.statusCode).toBe(403);
        expect(f.decide).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    }
  );
  it("binds the cookie owner/session and displayed policy, never body-supplied identity", async () => {
    const f = await httpFixture();
    try {
      const response = await f.app.inject({
        method: "POST",
        url: "/api/companion/recording-capability/decide",
        headers: { cookie: "session=synthetic", origin: "https://moss.example" },
        payload: {
          attemptId: device,
          decision: "approve",
          policyVersion: 1,
          actorUserId: "attacker"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(f.decide).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: owner, sessionId: session }),
        { attemptId: device, decision: "approve", policyVersion: 1 }
      );
      const unsupported = await f.app.inject({
        method: "POST",
        url: "/api/companion/recording-capability/decide",
        headers: { cookie: "session=synthetic", origin: "https://moss.example" },
        payload: { attemptId: device, decision: "approve", policyVersion: 2 }
      });
      expect(unsupported.statusCode).toBe(400);
      expect(f.decide).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });
});
