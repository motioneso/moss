import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type {
  MeetingCaptureBrowserStatus,
  MeetingTranscriptSnapshotResponse,
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureLink,
  MeetingCaptureRedeemResult,
  MeetingCaptureState
} from "@moss/shared";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { requireUatBaseURL, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import {
  CAPTURE_DEVICE_NAME,
  nativePost,
  pairCaptureFixture,
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

test("explicit capture approval, recording, transcript, Pause, Stop cutoff and revoke use real Moss routes (#2981)", async ({
  page
}) => {
  test.setTimeout(180000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    throw new Error("Use the credential-free Meetings UAT wrapper");
  const baseURL = requireUatBaseURL();
  const fixtureName = `${project}-meeting-capture-fixture`;
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  let meetingId: string | undefined;
  let deviceId: string | undefined;
  let providerId: string | undefined;
  let modelId: string | undefined;
  let native: ReturnType<typeof startCaptureNativeFixture> | undefined;
  await signInUatAdmin(page);
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

    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    const title = `Synthetic capture meeting ${randomUUID()}`;
    await page.getByLabel("Meeting title", { exact: true }).fill(title);
    await page.getByRole("radio", { name: /^Microphone only/ }).click();
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    meetingId = (await createdResponse.json()).meeting.id as string;
    const path = `/api/meetings/records/${meetingId}`;
    const panel = page.getByRole("region", { name: "Meeting capture", exact: true });
    await expect(panel).toContainText("Trail Marker not connected");
    const handoff = new URL(
      (await panel
        .getByRole("link", { name: "Open Trail Marker", exact: true })
        .getAttribute("href"))!
    );
    expect(handoff.protocol).toBe("moss-meeting:");
    expect([...handoff.searchParams.keys()]).toEqual(["instance", "meetingId"]);
    expect(handoff.searchParams.get("meetingId")).toBe(meetingId);
    expect(handoff.searchParams.get("instance")).toBe(new URL(baseURL).origin);

    const paired = await pairCaptureFixture(page, baseURL);
    deviceId = paired.device.id;
    const verifier = randomBytes(32).toString("base64url");
    const linked = await nativePost(baseURL, "/api/meetings/capture/link", paired.credential, {
      meetingId,
      verifierHash: createHash("sha256").update(verifier).digest("hex")
    });
    expect(linked.status).toBe(200);
    const link = (await linked.json()) as MeetingCaptureLink;
    expect(link).toMatchObject({ meetingId, deviceId });
    const redeemBody = { meetingId, challengeId: link.challengeId, verifier };
    const pending = await nativePost(
      baseURL,
      "/api/meetings/capture/redeem",
      paired.credential,
      redeemBody
    );
    expect(await pending.json()).toEqual({ status: "pending" });
    await expect(panel).toContainText(`Allow ${CAPTURE_DEVICE_NAME} to capture “${title}”?`);
    await expect(panel).toContainText(deviceId);
    await expect(panel.getByRole("button", { name: "Record", exact: true })).toHaveCount(0);
    const approved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/capture/approve`) && response.request().method() === "POST"
    );
    await panel.getByRole("button", { name: "Approve this device", exact: true }).click();
    expect((await approved).status()).toBe(200);
    const redeemed = await nativePost(
      baseURL,
      "/api/meetings/capture/redeem",
      paired.credential,
      redeemBody
    );
    expect(redeemed.status).toBe(200);
    const grant = (await redeemed.json()) as MeetingCaptureRedeemResult;
    if (grant.status !== "issued") throw new Error("Synthetic meeting grant was not issued");
    native = startCaptureNativeFixture(baseURL, grant.credential, meetingId, grant.grantId);
    await expect(panel.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Record", exact: true })).toBeDisabled();
    await panel.getByLabel("Microphone", { exact: true }).selectOption("synthetic-device");
    const notice = page.getByRole("checkbox", {
      name: "Participants have been notified and recording is permitted",
      exact: true
    });
    // `has` is evaluated inside each label; keep its checkbox locator root-relative.
    await panel.locator("label.jds-switch").filter({ has: notice }).click();
    await expect(notice).toBeChecked();
    await expect(panel.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
    const recording = await controlFromUi(page, "Record", path);
    expect(recording.input).toMatchObject({
      grantId: grant.grantId,
      command: "record",
      expectedGeneration: 0,
      noticeAcknowledged: true,
      selection: {
        mode: "microphone-only",
        microphone: { deviceId: "synthetic-device", sourceId: "synthetic-mic" }
      }
    });
    await expect(panel.getByRole("status").filter({ hasText: /^Starting…$/ })).toBeVisible();
    native.acknowledge(recording.capture, "recording");
    await expect(panel.getByRole("status").filter({ hasText: /^Recording$/ })).toBeVisible();
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
    const transcript = page.getByRole("region", { name: "Retained transcript", exact: true });
    await expect(transcript).toContainText(CAPTURE_FIXTURE_TEXT);
    await expect(transcript).toContainText("Generated PCM microphone");
    await expect(transcript).toContainText("Source labels only");
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

    const pause = await controlFromUi(page, "Pause", path);
    await expect(panel.getByRole("status").filter({ hasText: /^Pausing…$/ })).toBeVisible();
    const deniedDuringPause = await nativePost(
      baseURL,
      "/api/meetings/capture/audio",
      grant.credential,
      { ...firstClip, requestKey: randomUUID(), sequence: 1 }
    );
    expect(deniedDuringPause.status).toBe(409);
    native.acknowledge(pause.capture, "paused");
    await expect(panel.getByRole("status").filter({ hasText: /^Paused$/ })).toBeVisible();
    const resumed = await controlFromUi(page, "Resume", path);
    expect(resumed.capture.epoch).toBe(recording.capture.epoch + 1);
    native.acknowledge(resumed.capture, "recording");
    await expect(panel.getByRole("status").filter({ hasText: /^Recording$/ })).toBeVisible();
    await expect
      .poll(() => native!.latest()?.elapsedMs ?? 0)
      .toBeGreaterThan(resumed.capture.epochStartMs + 200);
    const stopped = await controlFromUi(page, "Stop and review", path);
    expect(stopped.capture.stopCutoffMs).not.toBeNull();
    const cutoff = stopped.capture.stopCutoffMs!;
    await expect(panel.getByRole("status").filter({ hasText: /^Stopping…$/ })).toBeVisible();
    native.acknowledge(stopped.capture, "stopped");
    await expect(panel.getByRole("status").filter({ hasText: /^Stopped$/ })).toBeVisible();
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
    await controlFromUi(page, "Disconnect device", path);
    await expect.poll(() => native!.status()).toBe(401);
    expect(
      (
        await nativePost(baseURL, "/api/meetings/capture/audio", grant.credential, {
          ...finalClip,
          requestKey: randomUUID(),
          sequence: 2
        })
      ).status
    ).toBe(401);
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
    expect(observations).toHaveLength(2);
    expect(observations.every((item) => item.generatedPcm && item.timestampsRequested)).toBe(true);
    console.log(
      "MEETINGS_CAPTURE_UAT real UI/API: exact device approval; explicit microphone selection and notice; native generation acknowledgments; generated PCM through disclosed HTTP ASR; timestamped retained transcript; duplicate audio idempotent; Pause rejects dispatch; Stop immutable cutoff and pre-cutoff final flush; revoke rejects next device request. Synthetic transport only, not live Mac capture proof."
    );
  } finally {
    try {
      await native?.close();
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
