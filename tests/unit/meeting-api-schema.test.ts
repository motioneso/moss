import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { meetingAudioEnvelopeSchema } from "../../packages/shared/src/meeting-api.js";

const valid = {
  meetingId: "meeting",
  sourceId: "mic",
  epoch: 1,
  sequence: 0,
  startMs: 0,
  endMs: 10,
  format: "pcm-s16le",
  sampleRateHz: 16000,
  channels: 1,
  contentHash: "a".repeat(64)
};
async function validate(payload: object) {
  const app = Fastify();
  app.post("/probe", { schema: { body: meetingAudioEnvelopeSchema } }, async (req) => req.body);
  try {
    return (await app.inject({ method: "POST", url: "/probe", payload })).statusCode;
  } finally {
    await app.close();
  }
}
describe("meeting envelope wire schema", () => {
  it("accepts a bounded mono envelope", async () => {
    expect(await validate(valid)).toBe(200);
  });
  it.each([
    { meetingId: "" },
    { sourceId: "" },
    { epoch: -1 },
    { epoch: 0.5 },
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { startMs: -1 },
    { endMs: -1 },
    { endMs: Number.MAX_SAFE_INTEGER + 1 },
    { sampleRateHz: 0 },
    { sampleRateHz: 192001 },
    { sampleRateHz: 16000.5 },
    { channels: 2 },
    { format: "stereo" },
    { contentHash: "invalid" }
  ])("rejects malformed metadata %j", async (patch) => {
    expect(await validate({ ...valid, ...patch })).toBe(400);
  });
  it.each(Object.keys(valid))("requires %s", async (key) => {
    const body: Record<string, unknown> = { ...valid };
    delete body[key];
    expect(await validate(body)).toBe(400);
  });
});
