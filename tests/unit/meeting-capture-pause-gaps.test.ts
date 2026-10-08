import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureGap, MeetingCaptureSelection } from "@moss/shared";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import { MeetingCaptureService } from "../../packages/meetings/src/capture-service.js";
import {
  at,
  command,
  fixture,
  grantId,
  inventory,
  meetingId
} from "./helpers/meeting-capture-fixture.js";

const systemOnly: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: null,
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
function gap(sourceId: string, epoch: number, startMs: number, endMs: number): MeetingCaptureGap {
  return { id: randomUUID(), sourceId, epoch, startMs, endMs, reason: "paused" };
}

describe("native pause gaps retain the selection interval", () => {
  it.each(["resume", "stop"] as const)(
    "accepts Pause then source edit then %s gap payloads through the real route and service",
    async (finish) => {
      let now = at(1000);
      const f = fixture(undefined, () => now);
      await f.service.browserControl(f.browser, meetingId, command("pause", 1));
      now = at(2000);
      await f.service.nativeControl(f.headers, "change", {
        meetingId,
        grantId,
        requestKey: randomUUID(),
        expectedGeneration: 2,
        expectedEpoch: 1,
        command: "change-sources",
        selection: systemOnly
      });
      now = at(3000);
      await f.service.nativeControl(f.headers, finish, {
        meetingId,
        grantId,
        requestKey: randomUUID(),
        expectedGeneration: 3,
        command: finish === "resume" ? "record" : "stop"
      });
      const server = Fastify();
      const actualStatus = f.service.status.bind(f.service);
      const status = vi
        .spyOn(MeetingCaptureService.prototype, "status")
        .mockImplementation(actualStatus);
      registerMeetingCaptureRoutes(server, f.deps);
      const payload = {
        meetingId,
        grantId,
        inventory,
        observed: { generation: 4, phase: finish === "resume" ? "recording" : "stopped" },
        gaps: [gap("mic", 1, 1000, 2000), gap("output", 2, 2000, 3000)]
      };
      try {
        const result = await server.inject({
          method: "POST",
          url: "/api/meetings/capture/status",
          headers: f.headers,
          payload
        });
        expect(result.statusCode).toBe(200);
        expect(result.json().capture.gaps).toEqual(payload.gaps);
        expect(result.json().capture.desired).toBe(finish === "resume" ? "recording" : "stopped");
        expect(JSON.parse(f.grant.state_json!).epochs[1]).toMatchObject({
          startMs: 2000,
          endMs: 2000
        });
        const saved = f.grant.state_json;
        now = at(4000);
        for (const invalid of [
          gap("mic", 1, 1000, 2001),
          gap("mic", 2, 2000, 3000),
          gap("output", 2, 2000, 3001)
        ]) {
          const rejected = await server.inject({
            method: "POST",
            url: "/api/meetings/capture/status",
            headers: f.headers,
            payload: { ...payload, gaps: [invalid] }
          });
          expect(rejected.statusCode).toBe(400);
          expect(f.grant.state_json).toBe(saved);
        }
      } finally {
        status.mockRestore();
        await server.close();
      }
    }
  );

  it("accepts the ordinary paused interval up to the Resume epoch start without widening audio", async () => {
    let now = at(1000);
    const f = fixture(undefined, () => now);
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    now = at(3000);
    await f.service.nativeControl(f.headers, "resume", {
      meetingId,
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "record"
    });
    const result = await f.service.status(f.headers, "gap", {
      meetingId,
      grantId,
      inventory,
      observed: { generation: 3, phase: "recording" },
      gaps: [gap("mic", 1, 1000, 3000)]
    });
    expect(result.capture.gaps).toEqual([
      expect.objectContaining({ epoch: 1, startMs: 1000, endMs: 3000 })
    ]);
    expect(JSON.parse(f.grant.state_json!).epochs[0].endMs).toBe(1000);
  });
});
