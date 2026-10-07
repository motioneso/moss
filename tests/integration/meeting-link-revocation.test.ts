import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeMeetingLinkRevocation,
  meetingLinkRevocationFixture,
  setupMeetingLinkRevocation
} from "./meeting-link-revocation-fixture.js";

beforeAll(setupMeetingLinkRevocation);
afterAll(closeMeetingLinkRevocation);
const fixtures: Awaited<ReturnType<typeof meetingLinkRevocationFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.server.close()));
});

describe("initial-link active recording revocation (real auth, isolated gate only)", () => {
  it.each(["recording-only", "unlink"] as const)(
    "%s revocation refuses the next native upload and settles browser/persisted REVOKED",
    async (kind) => {
      const fixture = await meetingLinkRevocationFixture();
      fixtures.push(fixture);
      const active = await fixture.begin();
      expect((await active.stored())?.status).toBe("active");
      const before = await active.storage();
      expect(before.batches).toHaveLength(1);
      if (kind === "recording-only") {
        const revoked = await fixture.revoke();
        expect(revoked.statusCode, "real-recording-revoke-route").toBe(204);
        await expect(fixture.ordinaryLink()).resolves.toHaveProperty("deviceId", fixture.deviceId);
      } else {
        await fixture.unlink();
        await expect(fixture.ordinaryLink()).rejects.toMatchObject({ httpStatus: 401 });
      }
      await expect(fixture.recordingLink()).rejects.toThrow();

      // No browser status request is made between committed auth revocation and this upload.
      // Thus refusal cannot be attributed to the browser first settling the capture grant.
      const refused = await active.upload(active.audio);
      expect(refused.statusCode, "revoked-next-native-audio-status").toBe(401);
      expect(refused.json()).toMatchObject({ code: "meeting_capture_unavailable" });
      expect(fixture.transcribe, "no-provider-dispatch-after-auth-revoke").toHaveBeenCalledTimes(1);
      expect(await active.storage(), "no-audio-or-transcript-writes-after-auth-revoke").toEqual(
        before
      );

      // On the base branch, the browser observation persists revocation. Do not claim the
      // denied native upload itself writes the terminal state or a #3082 revocation reason.
      const observed = await fixture.browserStatus();
      expect(observed.statusCode).toBe(200);
      expect(observed.json().capture.desired, "revoked-browser-capture-state").toBe("revoked");
      const stored = await active.stored();
      expect(stored?.status, "revoked-persisted-grant-status").toBe("revoked");
      expect(JSON.parse(stored!.state_json!).desired, "revoked-persisted-capture-state").toBe(
        "revoked"
      );
      expect(fixture.transcribe).toHaveBeenCalledTimes(1);
      expect(await active.storage()).toEqual(before);
    }
  );
});
