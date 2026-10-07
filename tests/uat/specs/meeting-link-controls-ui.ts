import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type {
  ListMySessionsResponse,
  MeetingCaptureBrowserStatus,
  MeetingCapturePreferences,
  MeetingCaptureState,
  RecordingCapabilityAttempt,
  RedeemPairAttemptResponse
} from "@moss/shared";
import {
  CAPTURE_DEVICE_NAME,
  connectCaptureFixture,
  nativePost,
  startCaptureNativeFixture
} from "./meeting-capture-native-fixture.js";
import {
  CAPTURE_FIXTURE_TEXT,
  CAPTURE_SAMPLE_RATE,
  syntheticMeetingPcm
} from "../fixtures/meeting-capture-fixture-server.js";

/** Real owner APIs and UI; only the native recorder is synthetic. No response interception. */
export async function assertMeetingLinkControls({
  page,
  baseURL,
  paired,
  retainedMeetingId
}: {
  readonly page: Page;
  readonly baseURL: string;
  readonly paired: RedeemPairAttemptResponse & { recordingProof: string };
  readonly retainedMeetingId: string;
}): Promise<void> {
  const saved = (await (
    await page.request.get("/api/meetings/preferences")
  ).json()) as MeetingCapturePreferences;
  let proof = paired.recordingProof;
  for (const action of ["revoke", "unlink"] as const) {
    if (action === "unlink") {
      proof = randomBytes(32).toString("base64url");
      const attempt = await nativePost(
        baseURL,
        "/api/companion/recording-capability/attempt",
        paired.credential,
        {
          requestKey: randomUUID(),
          proofHash: createHash("sha256").update(proof).digest("hex"),
          policyVersion: 1
        }
      );
      expect(attempt.status).toBe(200);
      const requested = (await attempt.json()) as RecordingCapabilityAttempt;
      await page.goto("/settings?section=profile");
      const approved = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/companion/recording-capability/decide") &&
          response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "Enable meeting recording", exact: true }).click();
      const approval = await approved;
      expect(approval.status()).toBe(200);
      expect(approval.request().postDataJSON()).toEqual({
        attemptId: requested.attemptId,
        decision: "approve",
        policyVersion: 1
      });
    }
    const connection = await connectCaptureFixture(baseURL, { ...paired, recordingProof: proof });
    let meetingId: string | undefined;
    let native: ReturnType<typeof startCaptureNativeFixture> | undefined;
    try {
      await page.getByRole("link", { name: "Meetings", exact: true }).click();
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "New meeting", exact: true }).click();
      const result = await created;
      expect(result.status()).toBe(201);
      meetingId = (await result.json()).meeting.id as string;
      const path = `/api/meetings/records/${meetingId}`;
      await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));
      const notes = page.getByRole("textbox", { name: "Notes", exact: true });
      await expect(notes).toBeEditable();
      const savedNotes = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${path}/notes`) && response.request().method() === "PUT"
      );
      await notes.fill(`Keep my notes after ${action}.`);
      expect((await savedNotes).status()).toBe(200);
      await connection.refresh();
      const started = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${path}/capture/start`) && response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      const start = await started;
      expect(start.status()).toBe(200);
      const capture = ((await start.json()) as { capture: MeetingCaptureState }).capture;
      const grant = await connection.claim(meetingId);
      native = startCaptureNativeFixture(baseURL, grant.credential, meetingId, grant.grantId);
      native.acknowledge(capture, "recording");
      const panel = page.getByRole("region", { name: "Meeting recording", exact: true });
      await expect(panel.getByLabel("Recording", { exact: true })).toBeVisible();
      await page
        .locator(".meetings-record-tools")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect(page).toHaveURL(/module=meetings/);
      const settings = page.locator(".meeting-settings");
      const unlinkButton = settings.getByRole("button", { name: "Unlink Mac", exact: true });
      const audioSource = settings.getByLabel("Audio source", { exact: true });
      await expect(settings.getByRole("checkbox")).toHaveCount(0);
      await expect(settings.getByText("Linked", { exact: true })).toBeVisible();
      if (action === "revoke") {
        expect(saved.defaultCaptureMode).toBe("computer-audio");
        for (const mode of ["microphone-only", "computer-audio"] as const) {
          const saving = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/meetings/preferences") &&
              response.request().method() === "PUT"
          );
          await audioSource.selectOption(mode);
          const savedSource = await saving;
          expect(savedSource.status()).toBe(200);
          expect(savedSource.request().postDataJSON()).toEqual({ defaultCaptureMode: mode });
          await expect(audioSource).toBeEnabled();
          const current = (await (
            await page.request.get(`${path}/capture`)
          ).json()) as MeetingCaptureBrowserStatus;
          expect(current.capture?.selection).toEqual(capture.selection);
        }
        expect(await (await page.request.get("/api/meetings/preferences")).json()).toEqual(saved);
      }
      const originalViewport = page.viewportSize();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.colorMode = mode;
          }, mode);
          for (const control of [unlinkButton, audioSource]) {
            await expect(control).toBeVisible();
            const bounds = await control.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          }
        }
      }
      await page.evaluate(() => {
        delete document.documentElement.dataset.colorMode;
      });
      if (originalViewport) await page.setViewportSize(originalViewport);
      if (action === "unlink") {
        await unlinkButton.click();
        const dialog = page.getByRole("dialog", {
          name: `Unlink ${CAPTURE_DEVICE_NAME}?`,
          exact: true
        });
        await expect(dialog).toContainText("Your saved notes and transcripts stay available");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(settings.getByText("Linked", { exact: true })).toBeVisible();
        await unlinkButton.click();
        const changed = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/me/sessions/${paired.device.id}`) &&
            response.request().method() === "DELETE"
        );
        await dialog.getByRole("button", { name: "Unlink Mac", exact: true }).click();
        expect((await changed).status()).toBe(200);
        await expect(
          page.getByText(`${CAPTURE_DEVICE_NAME} unlinked.`, { exact: false })
        ).toBeVisible();
      } else {
        // Recording-only revocation is exercised through the real owner API. The compact
        // Meetings settings intentionally has no recording-permission toggle.
        const revoked = await page.request.post("/api/companion/recording-capability/revoke", {
          headers: { Origin: new URL(baseURL).origin },
          data: { deviceId: paired.device.id }
        });
        expect(revoked.status()).toBe(204);
      }
      const stoppedBy = Date.now() + 30_000;
      const heartbeat = await nativePost(baseURL, "/api/companion/heartbeat", paired.credential, {
        appVersion: "uat",
        osVersion: "synthetic"
      });
      expect(heartbeat.status).toBe(action === "unlink" ? 401 : 200);
      const after = (await (
        await page.request.get("/api/me/sessions")
      ).json()) as ListMySessionsResponse;
      expect(after.sessions.some((session) => session.id === paired.device.id)).toBe(
        action !== "unlink"
      );
      // The post-commit audio request exercises Moss admission, not a stubbed UI result.
      const denied = await nativePost(baseURL, "/api/meetings/capture/audio", grant.credential, {
        meetingId,
        grantId: grant.grantId,
        requestKey: randomUUID(),
        generation: capture.generation,
        epoch: capture.epoch,
        sourceId: "synthetic-mic",
        sequence: 0,
        startMs: capture.epochStartMs,
        endMs: capture.epochStartMs + 200,
        sampleRateHz: CAPTURE_SAMPLE_RATE,
        pcmBase64: syntheticMeetingPcm(200).toString("base64")
      });
      expect([401, 403]).toContain(denied.status);
      await expect
        .poll(() => native!.status(), { timeout: Math.max(1, stoppedBy - Date.now()) })
        .toBe(401);
      await expect(page.locator(".meetings-recording-indicator")).toHaveCount(0, {
        timeout: Math.max(1, stoppedBy - Date.now())
      });
      expect(Date.now()).toBeLessThanOrEqual(stoppedBy);
      await page.goto(`/meetings?id=${meetingId}`);
      await expect(panel).toContainText("Recording authorization revoked. Recording stopped.");
      await expect(notes).toHaveValue(`Keep my notes after ${action}.`);
      const terminal = (await (
        await page.request.get(`${path}/capture`)
      ).json()) as MeetingCaptureBrowserStatus;
      expect(terminal.capture).toMatchObject({
        desired: "revoked"
      });
      expect(await (await page.request.get("/api/meetings/preferences")).json()).toEqual(saved);
    } finally {
      await native?.close();
      if (meetingId)
        expect
          .soft((await page.request.delete(`/api/meetings/records/${meetingId}`)).status())
          .toBe(204);
    }
  }
  await page.goto(`/meetings?id=${retainedMeetingId}`);
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
    "Keep these notes visible when I start recording."
  );
  await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
    CAPTURE_FIXTURE_TEXT
  );
}
