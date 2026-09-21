import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  focusContextRouteSchema,
  focusCorrectRouteSchema,
  focusJudgeRouteSchema
} from "@moss/shared";

// Same approach as companion-api-schema.test.ts: exercise the schemas through a real Fastify
// instance, because that is the runtime contract. With Fastify's default ajv,
// additionalProperties: false strips unknown keys rather than rejecting them.
async function post(
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

const BLOCK_ID = "4e0d2a1c-0000-4000-8000-000000000000";
const VALID_JUDGE = {
  blockId: BLOCK_ID,
  appName: "Safari",
  windowTitle: "Attention Is All You Need",
  observedAt: "2026-09-20T21:26:40.572Z"
};

describe("focusJudgeRouteSchema request", () => {
  it("accepts a well-formed observation", async () => {
    const { status, body } = await post(focusJudgeRouteSchema.body, VALID_JUDGE);
    expect(status).toBe(200);
    expect(body).toEqual(VALID_JUDGE);
  });

  it("accepts an empty window title (some windows have none)", async () => {
    const { status } = await post(focusJudgeRouteSchema.body, { ...VALID_JUDGE, windowTitle: "" });
    expect(status).toBe(200);
  });

  it("rejects a 201-character window title (fails if the bound is missing)", async () => {
    const { status } = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      windowTitle: "t".repeat(201)
    });
    expect(status).toBe(400);
  });

  it("rejects an app name of 0 or 65 characters", async () => {
    const empty = await post(focusJudgeRouteSchema.body, { ...VALID_JUDGE, appName: "" });
    expect(empty.status).toBe(400);
    const long = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      appName: "a".repeat(65)
    });
    expect(long.status).toBe(400);
  });

  it("rejects control characters in the app name and the window title", async () => {
    const inName = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      appName: "Saf\u0000ari"
    });
    expect(inName.status).toBe(400);
    const inTitle = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      windowTitle: "line\nbreak"
    });
    expect(inTitle.status).toBe(400);
  });

  it("rejects a block id that is not a uuid", async () => {
    const { status } = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      blockId: "not-a-uuid"
    });
    expect(status).toBe(400);
  });

  it("drops an unknown body key instead of keeping it, so a Mac cannot smuggle an owner id", async () => {
    const { status, body } = await post(focusJudgeRouteSchema.body, {
      ...VALID_JUDGE,
      ownerUserId: "attacker-supplied"
    });
    expect(status).toBe(200);
    expect(body).toEqual(VALID_JUDGE);
    expect(body).not.toHaveProperty("ownerUserId");
  });
});

describe("focusJudgeRouteSchema response", () => {
  it("writes only the four declared fields even if the handler returns more", async () => {
    // Serializing an object that carries an extra key must not emit it. Fails if the schema
    // lists no properties or allows additional ones. This is the serializer stripping the key,
    // not rejecting it, so the assertion is on the serialized text.
    const app = Fastify();
    app.post(
      "/probe",
      { schema: { response: focusJudgeRouteSchema.response as never } },
      async () => ({
        judgmentId: BLOCK_ID,
        label: "focused",
        reason: "reading course material",
        nudge: false,
        prompt: "SECRET-PROMPT-TEXT"
      })
    );
    const res = await app.inject({ method: "POST", url: "/probe", payload: {} });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SECRET-PROMPT-TEXT");
    expect(JSON.parse(res.body)).toEqual({
      judgmentId: BLOCK_ID,
      label: "focused",
      reason: "reading course material",
      nudge: false
    });
  });
});

describe("focusContextRouteSchema response", () => {
  it("serializes a null block and a ready flag, and strips extra keys", async () => {
    const app = Fastify();
    app.post(
      "/probe",
      { schema: { response: focusContextRouteSchema.response as never } },
      async () => ({
        block: null,
        judgmentReady: false,
        ownerUserId: "leak"
      })
    );
    const res = await app.inject({ method: "POST", url: "/probe", payload: {} });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ block: null, judgmentReady: false });
  });

  it("serializes a block with exactly its four fields", async () => {
    const app = Fastify();
    app.post(
      "/probe",
      { schema: { response: focusContextRouteSchema.response as never } },
      async () => ({
        block: {
          id: BLOCK_ID,
          title: "Study AI",
          startsAt: "2026-09-20T16:00:00.000Z",
          endsAt: "2026-09-20T18:00:00.000Z",
          description: "private notes"
        },
        judgmentReady: true
      })
    );
    const res = await app.inject({ method: "POST", url: "/probe", payload: {} });
    await app.close();
    expect(JSON.parse(res.body).block).toEqual({
      id: BLOCK_ID,
      title: "Study AI",
      startsAt: "2026-09-20T16:00:00.000Z",
      endsAt: "2026-09-20T18:00:00.000Z"
    });
  });
});

describe("focusCorrectRouteSchema", () => {
  it("accepts right and wrong and nothing else", async () => {
    for (const verdict of ["right", "wrong"]) {
      const ok = await post(focusCorrectRouteSchema.body, { judgmentId: BLOCK_ID, verdict });
      expect(ok.status).toBe(200);
    }
    const bad = await post(focusCorrectRouteSchema.body, {
      judgmentId: BLOCK_ID,
      verdict: "maybe"
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a judgment id that is not a uuid", async () => {
    const { status } = await post(focusCorrectRouteSchema.body, {
      judgmentId: "nope",
      verdict: "right"
    });
    expect(status).toBe(400);
  });
});
