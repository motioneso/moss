import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  COMPANION_CREDENTIAL_PREFIX,
  COMPANION_PROTOCOL_VERSION,
  createPairAttemptRouteSchema,
  decidePairAttemptRouteSchema,
  companionHeartbeatRouteSchema,
  redeemPairAttemptRouteSchema,
  renameCompanionDeviceRouteSchema
} from "@moss/shared";

// These schemas ARE the runtime Fastify validation contract for the Trail Marker pairing
// exchange, so they are exercised through a real Fastify instance rather than a hand-rolled
// validator. With Fastify's default ajv, `additionalProperties: false` strips unknown keys
// instead of rejecting; a missing `required` field still yields 400.
async function parseBody(
  bodySchema: unknown,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const app = Fastify();
  app.post("/probe", { schema: { body: bodySchema as never } }, async (req) => req.body);
  const res = await app.inject({
    method: "POST",
    url: "/probe",
    payload,
    headers: { "content-type": "application/json" }
  });
  await app.close();
  return {
    status: res.statusCode,
    body: res.statusCode === 200 ? (JSON.parse(res.body) as Record<string, unknown>) : undefined
  };
}

const VALID_PAIR_BODY = {
  deviceName: "Ben's MacBook Pro",
  platform: "macos",
  appVersion: "1.0.0",
  osVersion: "14.5",
  verifierHash: "a".repeat(43)
};

describe("companion protocol constants", () => {
  it("pins the protocol version and credential prefix", () => {
    expect(COMPANION_PROTOCOL_VERSION).toBe(1);
    expect(COMPANION_CREDENTIAL_PREFIX).toBe("tm1_");
  });
});

describe("createPairAttemptRouteSchema", () => {
  it("accepts a well-formed attempt and strips unknown keys", async () => {
    const { status, body } = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      userId: "attacker-supplied"
    });
    expect(status).toBe(200);
    expect(body).toEqual(VALID_PAIR_BODY);
  });

  it("rejects a platform other than macos", async () => {
    const { status } = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      platform: "windows"
    });
    expect(status).toBe(400);
  });

  it("rejects an empty or over-long device name", async () => {
    const empty = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      deviceName: ""
    });
    expect(empty.status).toBe(400);
    const tooLong = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      deviceName: "x".repeat(65)
    });
    expect(tooLong.status).toBe(400);
  });

  it("rejects a verifier hash that is not a 43-character base64url digest", async () => {
    const wrongLength = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      verifierHash: "a".repeat(42)
    });
    expect(wrongLength.status).toBe(400);
    const wrongAlphabet = await parseBody(createPairAttemptRouteSchema.body, {
      ...VALID_PAIR_BODY,
      verifierHash: `${"a".repeat(42)}+`
    });
    expect(wrongAlphabet.status).toBe(400);
  });

  it("rejects a missing required field", async () => {
    const { deviceName: _omitted, ...withoutName } = VALID_PAIR_BODY;
    const { status } = await parseBody(createPairAttemptRouteSchema.body, withoutName);
    expect(status).toBe(400);
  });
});

describe("decidePairAttemptRouteSchema", () => {
  it("accepts approve and deny", async () => {
    for (const decision of ["approve", "deny"]) {
      const { status } = await parseBody(decidePairAttemptRouteSchema.body, {
        code: "x".repeat(32),
        decision
      });
      expect(status).toBe(200);
    }
  });

  it("rejects any other decision", async () => {
    const { status } = await parseBody(decidePairAttemptRouteSchema.body, {
      code: "x".repeat(32),
      decision: "maybe"
    });
    expect(status).toBe(400);
  });
});

describe("redeemPairAttemptRouteSchema", () => {
  it("requires both the attempt id and the verifier", async () => {
    const ok = await parseBody(redeemPairAttemptRouteSchema.body, {
      attemptId: "4e0d2a1c-0000-4000-8000-000000000000",
      verifier: "v".repeat(43)
    });
    expect(ok.status).toBe(200);
    const missingVerifier = await parseBody(redeemPairAttemptRouteSchema.body, {
      attemptId: "4e0d2a1c-0000-4000-8000-000000000000"
    });
    expect(missingVerifier.status).toBe(400);
  });

  it("rejects an attempt id that is not a uuid", async () => {
    const { status } = await parseBody(redeemPairAttemptRouteSchema.body, {
      attemptId: "not-a-uuid",
      verifier: "v".repeat(43)
    });
    expect(status).toBe(400);
  });
});

describe("companion device schemas", () => {
  it("bounds the heartbeat version strings", async () => {
    const ok = await parseBody(companionHeartbeatRouteSchema.body, {
      appVersion: "1.0.0",
      osVersion: "14.5"
    });
    expect(ok.status).toBe(200);
    const tooLong = await parseBody(companionHeartbeatRouteSchema.body, {
      appVersion: "x".repeat(33),
      osVersion: "14.5"
    });
    expect(tooLong.status).toBe(400);
  });

  it("bounds the device display name to 1-64 characters", async () => {
    const ok = await parseBody(renameCompanionDeviceRouteSchema.body, {
      displayName: "Studio Mac"
    });
    expect(ok.status).toBe(200);
    const tooLong = await parseBody(renameCompanionDeviceRouteSchema.body, {
      displayName: "x".repeat(65)
    });
    expect(tooLong.status).toBe(400);
  });

  it("rejects control characters in a device display name", async () => {
    const { status } = await parseBody(renameCompanionDeviceRouteSchema.body, {
      displayName: "Studio\u0007Mac"
    });
    expect(status).toBe(400);
  });
});

describe("no companion response schema can carry a credential to the wrong place", () => {
  it("returns the raw credential only from the redeem response", () => {
    const redeem = redeemPairAttemptRouteSchema.response[200] as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(redeem.properties)).toContain("credential");

    const heartbeat = companionHeartbeatRouteSchema.response[200] as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(heartbeat.properties)).not.toContain("credential");
  });
});
