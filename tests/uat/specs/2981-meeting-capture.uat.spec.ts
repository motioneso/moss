import { assertMinimalMeetingWorkspace } from "./meeting-minimal-ui.js";
import { assertMeetingLinkControls } from "./meeting-link-controls-ui.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type {
  MeetingCaptureBrowserStatus,
  MeetingTranscriptSnapshotResponse,
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureState,
  MeetingOutputsResponse,
  MeetingCapturePreferences
} from "@moss/shared";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { requireUatBaseURL, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import {
  nativePost,
  pairCaptureFixture,
  connectCaptureFixture,
  startCaptureNativeFixture
} from "./meeting-capture-native-fixture.js";
import {
  CAPTURE_FIXTURE_MODEL,
  CAPTURE_FIXTURE_PORT,
  CAPTURE_FIXTURE_TEXT,
  CAPTURE_SAMPLE_RATE,
  syntheticMeetingPcm
} from "../fixtures/meeting-capture-fixture-server.js";

// Real Moss UI, routes and storage; disclosed synthetic native transport and HTTP ASR.
// This is not proof of actual Mac capture, permissions, process exclusion, or transcription quality.
test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);
async function controlFromUi(page: Page, name: string, path: string) {
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${path}/capture/control`) && response.request().method() === "POST"
  );
  await page.getByRole("button", { name, exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  return {
    capture: ((await response.json()) as { capture: MeetingCaptureState }).capture,
    input: response.request().postDataJSON() as MeetingCaptureControlInput
  };
}
function clip(
  meetingId: string,
  capture: MeetingCaptureState,
  startMs: number,
  endMs: number,
  sequence = 0
): MeetingCaptureAudioInput {
  return {
    meetingId,
    grantId: capture.grantId,
    requestKey: randomUUID(),
    generation: capture.generation,
    epoch: capture.epoch,
    sourceId: "synthetic-mic",
    sequence,
    startMs,
    endMs,
    sampleRateHz: CAPTURE_SAMPLE_RATE,
    pcmBase64: syntheticMeetingPcm(endMs - startMs).toString("base64")
  };
}

test("shared connection, single Start, recording controls, transcript and Stop→New recovery use real Moss routes (#2981)", async ({
  page
}) => {
  test.setTimeout(360_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    throw new Error("Use the credential-free Meetings UAT wrapper");
  const baseURL = requireUatBaseURL();
  const fixtureName = `${project}-meeting-capture-fixture`;
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  let meetingId: string | undefined;
  let deviceId: string | undefined;
  let secondMeetingId: string | undefined;
  let providerId: string | undefined;
  let modelId: string | undefined;
  let native: ReturnType<typeof startCaptureNativeFixture> | undefined;
  await signInUatAdmin(page);
  const preferencesResponse = await page.request.get("/api/meetings/preferences");
  expect(preferencesResponse.status()).toBe(200);
  const originalPreferences = (await preferencesResponse.json()) as MeetingCapturePreferences;
  expect(originalPreferences).toMatchObject({
    defaultCaptureMode: "computer-audio",
    rememberedSource: null,
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
  let startRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/capture/start")) startRequests += 1;
  });
  const priorPin = await page.request.get(pinPath);
  expect(priorPin.status()).toBe(200);
  const { pin } = (await priorPin.json()) as {
    pin: { pinnedModelId: string | null; pinnedProviderId: string | null };
  };
  try {
    await exec("docker", [
      "run",
      "--detach",
      "--name",
      fixtureName,
      "--network",
      `${project}_jarv1s`,
      `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
      "node_modules/.bin/tsx",
      "tests/uat/fixtures/meeting-capture-fixture-cli.ts"
    ]);
    await expect
      .poll(
        async () =>
          (await exec("docker", ["logs", fixtureName])).stdout.includes(
            "[meeting-capture-fixture] ready"
          ),
        { timeout: 30000 }
      )
      .toBe(true);
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Synthetic meeting capture HTTP provider",
        baseUrl: `http://${fixtureName}:${CAPTURE_FIXTURE_PORT}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
      }
    });
    expect(provider.status()).toBe(201);
    providerId = (await provider.json()).provider.id as string;
    const model = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: CAPTURE_FIXTURE_MODEL,
        displayName: "Synthetic timestamped transcription model",
        capabilities: ["transcription"],
        status: "active",
        tier: "economy"
      }
    });
    expect(model.status()).toBe(201);
    modelId = (await model.json()).model.id as string;
    expect((await page.request.put(pinPath, { data: { modelId } })).status()).toBe(200);

    const openPages = page.context().pages().length;
    const paired = await pairCaptureFixture(page, baseURL);
    deviceId = paired.device.id;
    const connection = await connectCaptureFixture(baseURL, paired);
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    const title = `Synthetic capture meeting ${randomUUID()}`;
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "New meeting", exact: true }).click();
    expect(startRequests).toBe(0);
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const newMeeting = (await createdResponse.json()).meeting;
    meetingId = newMeeting.id as string;
    expect(newMeeting.title).toBe("Untitled meeting");
    const path = `/api/meetings/records/${meetingId}`;
    await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));
    await assertMinimalMeetingWorkspace(page);
    expect(startRequests).toBe(0);
    expect((await (await page.request.get(`${path}/capture`)).json()).capture).toBeNull();
    await page.getByRole("button", { name: "Edit meeting title", exact: true }).click();
    const titleInput = page.getByLabel("Meeting title", { exact: true });
    await titleInput.fill("");
    await titleInput.pressSequentially(title, { delay: 0 });
    await expect(titleInput).toHaveValue(title);
    const renamed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/title`) && response.request().method() === "PUT"
    );
    await titleInput.press("Enter");
    expect((await renamed).status()).toBe(200);
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    const savedNotes = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/notes`) && response.request().method() === "PUT"
    );
    await notes.fill("Keep these notes visible when I start recording.");
    expect((await savedNotes).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
    await connection.refresh();
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/capture/start`) && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    const startResponse = await started;
    expect(startResponse.status()).toBe(200);
    expect(startResponse.request().postDataJSON()).toEqual({ requestKey: expect.any(String) });
    expect(startRequests).toBe(1);
    const recording = (await startResponse.json()) as { capture: MeetingCaptureState };
    expect(recording.capture).toMatchObject({
      deviceId,
      selection: {
        mode: "computer-audio",
        microphone: { deviceId: "synthetic-device", sourceId: "synthetic-mic" }
      }
    });
    await expect(notes).toBeVisible();
    await expect(notes).toBeEditable();
    await expect(notes).toHaveValue("Keep these notes visible when I start recording.");
    const grant = await connection.claim(meetingId);
    native = startCaptureNativeFixture(baseURL, grant.credential, meetingId, grant.grantId);
    const panel = page.getByRole("region", { name: "Meeting recording", exact: true });
    await expect(panel.getByLabel("Starting…", { exact: true })).toBeVisible();
    native.acknowledge(recording.capture, "recording");
    await expect(panel.getByLabel("Recording", { exact: true })).toBeVisible();
    expect(page.context().pages()).toHaveLength(openPages);
    await expect
      .poll(() => native!.latest()?.elapsedMs ?? 0)
      .toBeGreaterThan(recording.capture.epochStartMs + 200);
    const firstClip = clip(
      meetingId,
      recording.capture,
      recording.capture.epochStartMs,
      recording.capture.epochStartMs + 200
    );
    const audio = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      firstClip
    );
    expect(audio.status).toBe(200);
    expect(await audio.json()).toMatchObject({ status: "saved", transcriptRevision: 1 });
    const transcript = page.getByRole("region", { name: "Transcript", exact: true });
    await expect(transcript).toContainText(CAPTURE_FIXTURE_TEXT);
    await expect(transcript).toContainText("You");
    await expect(transcript).not.toContainText("Source labels only");
    const replayed = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      firstClip
    );
    expect(await replayed.json()).toMatchObject({
      status: "saved",
      replayed: true,
      transcriptRevision: 1
    });

    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    const strip = page.getByRole("link", {
      name: `Return to meeting: ${title}, Recording`,
      exact: true
    });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(/\d+:\d{2}/);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.locator(".meetings-recording-indicator")).toBeVisible();
    await strip.click();
    await expect(notes).toHaveValue("Keep these notes visible when I start recording.");
    const pause = await controlFromUi(page, "Pause", path);
    await expect(panel.getByLabel("Pausing…", { exact: true })).toBeVisible();
    const deniedDuringPause = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      { ...firstClip, requestKey: randomUUID(), sequence: 1 }
    );
    expect(deniedDuringPause.status).toBe(409);
    native.acknowledge(pause.capture, "paused");
    await expect(panel.getByLabel("Paused", { exact: true })).toBeVisible();
    const resumed = await controlFromUi(page, "Resume", path);
    expect(resumed.capture.epoch).toBe(recording.capture.epoch + 1);
    native.acknowledge(resumed.capture, "recording");
    await expect(panel.getByLabel("Recording", { exact: true })).toBeVisible();
    await expect
      .poll(() => native!.latest()?.elapsedMs ?? 0)
      .toBeGreaterThan(resumed.capture.epochStartMs + 200);
    const stopped = await controlFromUi(page, "Stop", path);
    expect(stopped.capture.stopCutoffMs).not.toBeNull();
    const cutoff = stopped.capture.stopCutoffMs!;
    await expect(panel.getByLabel("Stopping…", { exact: true })).toBeVisible();
    native.acknowledge(stopped.capture, "stopped");
    await expect(panel).toContainText("Ended");
    const finalClip = clip(meetingId, resumed.capture, cutoff - 100, cutoff);
    const finalAudio = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      finalClip
    );
    expect(finalAudio.status).toBe(200);
    expect(await finalAudio.json()).toMatchObject({ status: "saved", transcriptRevision: 2 });
    const afterCutoff = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      clip(meetingId, resumed.capture, cutoff, cutoff + 100, 1)
    );
    expect(afterCutoff.status).toBe(409);
    const repeated = await page.evaluate(
      async ({ path, input }) => {
        const result = await fetch(`${path}/capture/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        return { status: result.status, body: await result.json() };
      },
      { path, input: stopped.input }
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.capture.stopCutoffMs).toBe(cutoff);
    const savedTranscript = await page.request.get(
      `${path}/transcript?maxSegments=10&maxCharacters=10000`
    );
    expect(savedTranscript.status()).toBe(200);
    const retained = (await savedTranscript.json()) as MeetingTranscriptSnapshotResponse;
    expect(retained.snapshot.segments).toHaveLength(2);
    const persistedCapture = await page.request.get(`${path}/capture`);
    expect(persistedCapture.status()).toBe(200);
    expect(
      ((await persistedCapture.json()) as MeetingCaptureBrowserStatus).capture?.stopCutoffMs
    ).toBe(cutoff);
    expect(
      retained.snapshot.segments.every((segment: { endMs: number }) => segment.endMs <= cutoff)
    ).toBe(true);
    await expect(panel.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    native.finalize();
    await expect.poll(() => native!.latest()?.finalization).toBe("complete");
    expect(native.status()).toBe(200);
    expect(
      (
        await nativePost(baseURL, "/api/meetings/capture/audio", grant.credential, {
          ...finalClip,
          requestKey: randomUUID(),
          sequence: 2
        })
      ).status
    ).toBe(409);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${path}/outputs`);
          expect(response.status()).toBe(200);
          return ((await response.json()) as MeetingOutputsResponse).automaticSummary;
        },
        { timeout: 130_000, intervals: [1000, 2000] }
      )
      .toMatchObject({ status: "failed", code: "meeting_output_route_unavailable" });
    // Transcription-only fixture cannot summarize. Failure must be honest and actionable.
    await page.getByRole("tab", { name: "Summary", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Summary and actions", exact: true })
    ).toContainText("Use Rewrite summary to try again.");
    await native.close();
    await connection.refresh();
    await panel.getByRole("link", { name: "New meeting", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toHaveCount(0);
    await expect(strip).toHaveCount(0);
    await expect(page.locator(".meetings-recording-indicator")).toHaveCount(0);
    // The compact Settings UI edits only audio source. Keep legacy summary-off worker
    // coverage through the real preferences API, without inventing a removed UI control.
    const settingsResult = await page.request.put("/api/meetings/preferences", {
      data: { summarizeOnStop: false }
    });
    expect(settingsResult.status()).toBe(200);
    expect((await settingsResult.json()).rememberedSource).toEqual(
      originalPreferences.rememberedSource
    );
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    const createdAgain = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "New meeting", exact: true }).click();
    const nextMeeting = await createdAgain;
    expect(nextMeeting.status()).toBe(201);
    secondMeetingId = (await nextMeeting.json()).meeting.id as string;
    await expect(page).toHaveURL(new RegExp(`id=${secondMeetingId}`));
    await assertMinimalMeetingWorkspace(page);
    expect(startRequests).toBe(1);
    expect(
      (await (await page.request.get(`/api/meetings/records/${secondMeetingId}/capture`)).json())
        .capture
    ).toBeNull();
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
    await connection.refresh();
    const startedAgain = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${secondMeetingId}/capture/start`) &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    const nextResponse = await startedAgain;
    expect(nextResponse.status()).toBe(200);
    expect(nextResponse.request().postDataJSON()).toEqual({ requestKey: expect.any(String) });
    expect(startRequests).toBe(2);
    const nextCapture = ((await nextResponse.json()) as { capture: MeetingCaptureState }).capture;
    const nextGrant = await connection.claim(secondMeetingId);
    expect(nextGrant.grantId).not.toBe(grant.grantId);
    native = startCaptureNativeFixture(
      baseURL,
      nextGrant.credential,
      secondMeetingId,
      nextGrant.grantId
    );
    native.acknowledge(nextCapture, "recording");
    await expect(panel.getByLabel("Recording", { exact: true })).toBeVisible();
    await expect
      .poll(() => native!.latest()?.elapsedMs ?? 0)
      .toBeGreaterThan(nextCapture.epochStartMs + 200);
    const offAudio = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      nextGrant.credential,
      clip(secondMeetingId, nextCapture, nextCapture.epochStartMs, nextCapture.epochStartMs + 200)
    );
    expect(offAudio.status).toBe(200);
    expect(await offAudio.json()).toMatchObject({ status: "saved", transcriptRevision: 1 });
    await expect(transcript).toContainText(CAPTURE_FIXTURE_TEXT);

    const stoppedAgain = await controlFromUi(
      page,
      "Stop",
      `/api/meetings/records/${secondMeetingId}`
    );
    native.acknowledge(stoppedAgain.capture, "stopped");
    native.finalize();
    await expect.poll(() => native!.latest()?.finalization).toBe("complete");
    expect(native.status()).toBe(200);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/meetings/records/${secondMeetingId}/outputs`
          );
          expect(response.status()).toBe(200);
          const outputs = (await response.json()) as MeetingOutputsResponse;
          expect(outputs.artifacts).toEqual([]);
          return outputs.automaticSummary;
        },
        { timeout: 130_000, intervals: [1000, 2000] }
      )
      .toMatchObject({ status: "skipped", code: "setting-off" });
    await expect(panel.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    await native.close();
    await assertMeetingLinkControls({ page, baseURL, paired, retainedMeetingId: meetingId });
    deviceId = undefined; // The real Settings Unlink above already deleted the fixture device.
    const evidence = await exec("docker", [
      "exec",
      fixtureName,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${CAPTURE_FIXTURE_PORT}/evidence').then(r=>r.text()).then(t=>process.stdout.write(t))`
    ]);
    const { observations } = JSON.parse(evidence.stdout) as {
      observations: { generatedPcm: boolean; timestampsRequested: boolean }[];
    };
    expect(observations).toHaveLength(3);
    expect(observations.every((item) => item.generatedPcm && item.timestampsRequested)).toBe(true);
    console.log(
      "MEETINGS_CAPTURE_UAT real UI/API: shared one-time connection approval in the existing tab; fresh mic-and-system default without setup; New opens the meeting workspace without capture; rapid inline title entry; notes retained through explicit source-free Start; timer-only return link during list navigation; native acknowledgments; generated PCM through disclosed HTTP ASR; retained transcript; duplicate audio idempotent; Pause rejects dispatch; immutable Stop cutoff and bounded final flush; finalization retires authority; Stop → New → Start recording succeeds without a setup dialog; summary route failure reported and API-configured legacy summary-off yields skipped worker receipt; immediate audio-source dropdown writes only its default and leaves active capture unchanged; recording-only API revoke preserves the link; Settings Unlink followed by initial browser approval relinks a new device, which records again; Settings Unlink then rejects its credentials and audio while notes/transcripts remain visible. Synthetic transport only, not live Mac capture proof."
    );
  } finally {
    try {
      await native?.close();
      if (secondMeetingId)
        expect
          .soft((await page.request.delete(`/api/meetings/records/${secondMeetingId}`)).status())
          .toBe(204);
      if (meetingId)
        expect
          .soft((await page.request.delete(`/api/meetings/records/${meetingId}`)).status())
          .toBe(204);
      if (deviceId)
        expect.soft((await page.request.delete(`/api/me/sessions/${deviceId}`)).status()).toBe(200);
      expect
        .soft((await page.request.put(pinPath, { data: { modelId: null } })).status())
        .toBe(200);
      if (pin.pinnedModelId || pin.pinnedProviderId)
        expect
          .soft(
            (
              await page.request.put(pinPath, {
                data: { modelId: pin.pinnedModelId, providerId: pin.pinnedProviderId }
              })
            ).status()
          )
          .toBe(200);
      // Restore the saved preferences through the real API before isolated teardown.
      expect
        .soft(
          (
            await page.request.put("/api/meetings/preferences", {
              data: {
                defaultCaptureMode: originalPreferences.defaultCaptureMode,
                rememberedSource: originalPreferences.rememberedSource,
                summarizeOnStop: originalPreferences.summarizeOnStop,
                summaryTemplateId: originalPreferences.summaryTemplateId
              }
            })
          ).status()
        )
        .toBe(200);
      if (modelId)
        expect.soft((await page.request.delete(`/api/ai/models/${modelId}`)).status()).toBe(200);
      if (providerId)
        expect
          .soft((await page.request.post(`/api/ai/providers/${providerId}/revoke`)).status())
          .toBe(200);
    } finally {
      await exec("docker", ["rm", "--force", fixtureName]);
    }
  }
});
