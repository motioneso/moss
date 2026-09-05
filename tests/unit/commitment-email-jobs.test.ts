import { describe, expect, it, vi } from "vitest";

vi.mock("@moss/jobs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendJob: vi.fn(async () => "job1")
}));

import { sendJob } from "@moss/jobs";

import {
  EMAIL_JUDGEMENT_DEBOUNCE_SECONDS,
  enqueueEmailThreadJudgement
} from "../../packages/commitments/src/jobs.js";
import { COMMITMENT_EMAIL_JUDGEMENT_QUEUE } from "../../packages/commitments/src/manifest.js";

describe("enqueueEmailThreadJudgement", () => {
  it("sends a metadata-only payload keyed by owner and thread, debounced", async () => {
    await enqueueEmailThreadJudgement({} as never, "u1", "thread-abc");
    const calls = (sendJob as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [, queue, payload, opts] = calls[0] as [
      unknown,
      string,
      Record<string, string>,
      { singletonKey: string; startAfter: number }
    ];
    expect(queue).toBe(COMMITMENT_EMAIL_JUDGEMENT_QUEUE);
    expect(COMMITMENT_EMAIL_JUDGEMENT_QUEUE).toBe("commitment-email-judgement");
    expect(Object.keys(payload).sort()).toEqual(["actorUserId", "idempotencyKey", "threadRef"]);
    expect(payload.idempotencyKey).toMatch(/^email-thread:u1:[0-9a-f]{8}$/);
    expect(opts.singletonKey).toBe(payload.idempotencyKey);
    expect(opts.startAfter).toBe(EMAIL_JUDGEMENT_DEBOUNCE_SECONDS);
    expect(EMAIL_JUDGEMENT_DEBOUNCE_SECONDS).toBe(180);
  });
});
