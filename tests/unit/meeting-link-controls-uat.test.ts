import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("tests/uat/specs/meeting-link-controls-ui.ts", "utf8");
const evidence = readFileSync("tests/uat/specs/2981-meeting-capture.uat.spec.ts", "utf8");

describe("capture UAT single-link source contract (not live browser proof)", () => {
  it("removes the retired approval flow and pairs only after the old link is removed", () => {
    expect(source).not.toContain("/recording-capability/attempt");
    expect(source).not.toContain("/recording-capability/decide");
    expect(source).not.toContain("Enable meeting recording");
    const unlink = source.indexOf("await unlinkCaptureFixtureFromSettings(page, linked.device.id)");
    const paired = source.indexOf("linked = await pairCaptureFixture(page, baseURL)");
    const connected = source.indexOf("await connectCaptureFixture(baseURL, linked)");
    expect(unlink).toBeGreaterThan(-1);
    expect(paired).toBeGreaterThan(unlink);
    expect(connected).toBeGreaterThan(paired);
    expect(source).toContain("expect(oldHeartbeat.status).toBe(401)");
    expect(source).toContain("expect(linked.device.id).not.toBe(paired.device.id)");
    expect(source).toContain("expect(linked.recordingProof).not.toBe(paired.recordingProof)");
  });

  it("keeps both real Start and post-revocation upload checks with relinked-device cleanup", () => {
    expect(source).toContain('for (const action of ["revoke", "unlink"] as const)');
    expect(source).toContain(
      'getByRole("button", { name: "Start recording", exact: true }).click()'
    );
    expect(source).toContain("expect(start.status()).toBe(200)");
    expect(source).toContain(
      "expect(start.request().postDataJSON()).toEqual({ requestKey: expect.any(String) })"
    );
    expect(source).toContain("expect([401, 403]).toContain(denied.status)");
    expect(source).toContain(".poll(() => native!.status()");
    expect(source).toContain('desired: "revoked"');
    expect(source).toContain("await native?.close()");
    expect(source).toContain("page.request.delete(`/api/me/sessions/${relinkedDeviceId}`)");
  });

  it("retains preferences, active source, summary switch and saved notes/transcript assertions", () => {
    for (const assertion of [
      "expect(current.capture?.selection).toEqual(capture.selection)",
      "expect(savedSource.request().postDataJSON()).toEqual({ defaultCaptureMode: mode })",
      "expect(savedSummary.request().postDataJSON()).toEqual({ summarizeOnStop: enabled })",
      "await expect(automaticSummary).toBeChecked({ checked: enabled })",
      'expect(await (await page.request.get("/api/meetings/preferences")).json()).toEqual(saved)',
      "await expect(notes).toHaveValue(`Keep my notes after ${action}.`)",
      "Keep these notes visible when I start recording.",
      "CAPTURE_FIXTURE_TEXT"
    ])
      expect(source).toContain(assertion);
    expect(evidence).not.toContain("real attempt/decide restores permission");
    expect(evidence).toContain(
      "initial browser approval relinks a new device, which records again"
    );
  });
});
