import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type {
  MeetingCaptureControlInput,
  MeetingCapturePreferences,
  MeetingCaptureState,
  MeetingOutputsResponse
} from "@moss/shared";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { createCaptureBrowserFixture } from "./meeting-capture-browser-fixture.js";
import { requireUatBaseURL, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import {
  connectCaptureFixture,
  pairCaptureFixture,
  startCaptureNativeFixture
} from "./meeting-capture-native-fixture.js";
import {
  OUTPUT_FIXTURE_MODEL,
  OUTPUT_FIXTURE_PORT,
  OUTPUT_FIXTURE_TEXT,
  OUTPUT_FIXTURE_OVERVIEW
} from "../fixtures/meeting-outputs-fixture-server.js";

// Real Moss UI, routes, durable stop job and summary worker. The native control transport,
// owner-ingested transcript and third-party HTTP model are synthetic. No audio is captured or
// transcribed by this spec; it is not owner-controlled Mac or provider-quality live proof.
test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);

test("Stop automatically writes one summary after finalization without a generation click (#2981)", async ({
  page
}) => {
  test.setTimeout(240_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    throw new Error("Use the credential-free Meetings UAT wrapper");
  const baseURL = requireUatBaseURL();
  const browserFixture = createCaptureBrowserFixture(page.request, baseURL);
  const fixtureName = `${project}-meeting-auto-summary-fixture`;
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  let providerId: string | undefined;
  let modelId: string | undefined;
  let meetingId: string | undefined;
  let deviceId: string | undefined;
  let native: ReturnType<typeof startCaptureNativeFixture> | undefined;
  await signInUatAdmin(page);
  const originalPin = await page.request.get(pinPath);
  expect(originalPin.status()).toBe(200);
  const { pin } = (await originalPin.json()) as {
    pin: { pinnedModelId: string | null; pinnedProviderId: string | null };
  };
  const preferences = await page.request.get("/api/meetings/preferences");
  expect(preferences.status()).toBe(200);
  const original = (await preferences.json()) as MeetingCapturePreferences;
  let generationPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/meetings\/records\/[^/]+\/outputs$/.test(request.url())
    )
      generationPosts += 1;
  });
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
      "tests/uat/fixtures/meeting-outputs-fixture-cli.ts"
    ]);
    await expect
      .poll(
        async () =>
          (await exec("docker", ["logs", fixtureName])).stdout.includes(
            "[meeting-outputs-fixture] ready"
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Synthetic automatic meeting summary provider",
        baseUrl: `http://${fixtureName}:${OUTPUT_FIXTURE_PORT}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
      }
    });
    expect(provider.status()).toBe(201);
    providerId = (await provider.json()).provider.id as string;
    const model = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: OUTPUT_FIXTURE_MODEL,
        displayName: "Synthetic automatic summary JSON model",
        capabilities: ["transcription", "summarization", "json"],
        status: "active",
        tier: "economy"
      }
    });
    expect(model.status()).toBe(201);
    modelId = (await model.json()).model.id as string;
    expect((await page.request.put(pinPath, { data: { modelId } })).status()).toBe(200);
    const paired = await pairCaptureFixture(page, baseURL);
    deviceId = paired.device.id;
    const connection = await connectCaptureFixture(baseURL, paired);
    expect(
      (
        await page.request.put("/api/meetings/preferences", {
          data: {
            defaultCaptureMode: "microphone-only",
            rememberedSource: {
              deviceId,
              mode: "microphone-only",
              microphoneId: "synthetic-device"
            },
            summarizeOnStop: true,
            summaryTemplateId: "general"
          }
        })
      ).status()
    ).toBe(200);
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    const creating = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "New meeting", exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    meetingId = (await created.json()).meeting.id as string;
    const path = `/api/meetings/records/${meetingId}`;
    await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
      "Untitled meeting"
    );
    const starting = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/capture/start`) && response.request().method() === "POST"
    );
    await connection.refresh();
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    const started = await starting;
    expect(started.status()).toBe(200);
    expect(started.request().postDataJSON()).toEqual({ requestKey: expect.any(String) });
    const capture = ((await started.json()) as { capture: MeetingCaptureState }).capture;
    const grant = await connection.claim(meetingId);
    native = startCaptureNativeFixture(baseURL, grant.credential, meetingId, grant.grantId);
    native.acknowledge(capture, "recording");
    const panel = page.getByRole("region", { name: "Meeting recording", exact: true });
    await expect(panel.getByLabel("Recording", { exact: true })).toBeVisible();
    await expect
      .poll(() => native!.latest()?.elapsedMs ?? 0)
      .toBeGreaterThan(capture.epochStartMs + 200);
    const segmentId = randomUUID();
    const ingested = await page.request.post(`${path}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [
          {
            sourceId: "synthetic-mic",
            epoch: capture.epoch,
            kind: "microphone",
            label: "Declared synthetic transcript",
            startMs: capture.epochStartMs,
            endMs: capture.epochStartMs + 200
          }
        ],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId,
              segmentId,
              sourceId: "synthetic-mic",
              epoch: capture.epoch,
              startMs: capture.epochStartMs,
              endMs: capture.epochStartMs + 200,
              revision: 1,
              text: OUTPUT_FIXTURE_TEXT,
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: null
      }
    });
    expect(ingested.status()).toBe(201);
    const stopping = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${path}/capture/control`) && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const stopped = await stopping;
    expect(stopped.status()).toBe(200);
    const stopInput = stopped.request().postDataJSON() as MeetingCaptureControlInput;
    const stopCapture = ((await stopped.json()) as { capture: MeetingCaptureState }).capture;
    await page.getByRole("tab", { name: "Summary", exact: true }).click();
    const beforeFinalization = await page.request.get(`${path}/outputs`);
    expect(beforeFinalization.status()).toBe(200);
    expect((await beforeFinalization.json()).automaticSummary).toMatchObject({ status: "waiting" });
    native.acknowledge(stopCapture, "stopped");
    native.finalize();
    await expect.poll(() => native!.latest()?.finalization).toBe("complete");
    let completed: MeetingOutputsResponse | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${path}/outputs`);
          expect(response.status()).toBe(200);
          completed = (await response.json()) as MeetingOutputsResponse;
          return completed.automaticSummary?.status;
        },
        { timeout: 130_000, intervals: [1000, 2000] }
      )
      .toBe("saved");
    expect(completed).toMatchObject({
      headVersion: 1,
      automaticSummary: { status: "saved", requestKey: expect.any(String), expiresAt: null }
    });
    expect(completed!.artifacts).toHaveLength(1);
    expect(completed!.artifacts[0]!.content.overview).toBe(OUTPUT_FIXTURE_OVERVIEW);
    expect(completed!.candidates).toHaveLength(1);
    expect(completed!.candidates[0]!.acceptedTaskId).toBeNull();
    const tasksResponse = await page.request.get("/api/tasks");
    expect(tasksResponse.status()).toBe(200);
    const tasks = (await tasksResponse.json()).tasks as { sourceRef: string | null }[];
    expect(tasks.filter((task) => task.sourceRef === meetingId)).toEqual([]);
    await expect(
      page.getByRole("region", { name: "Summary and actions", exact: true })
    ).toContainText(OUTPUT_FIXTURE_OVERVIEW);
    // Worker output must update the open title as well as the persisted record.
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
      OUTPUT_FIXTURE_OVERVIEW
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
      OUTPUT_FIXTURE_OVERVIEW
    );
    expect(generationPosts).toBe(0);
    expect((await browserFixture.replayControl(meetingId, stopInput)).status()).toBe(200);
    const replayed = await page.request.get(`${path}/outputs`);
    expect(replayed.status()).toBe(200);
    const replayOutputs = (await replayed.json()) as MeetingOutputsResponse;
    expect(replayOutputs.headVersion).toBe(1);
    expect(replayOutputs.automaticSummary).toEqual(completed!.automaticSummary);
    const evidence = await exec("docker", [
      "exec",
      fixtureName,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${OUTPUT_FIXTURE_PORT}/evidence').then(r=>r.text()).then(t=>process.stdout.write(t))`
    ]);
    const { observations } = JSON.parse(evidence.stdout) as { observations: unknown[] };
    expect(observations).toEqual([
      expect.objectContaining({
        model: OUTPUT_FIXTURE_MODEL,
        hasTools: false,
        hasSearch: false,
        exactSource: true,
        sourceCount: 1
      })
    ]);
    console.log(
      "MEETINGS_AUTO_SUMMARY_UAT real Start/Stop UI and durable worker: waiting until finalized, one automatic generated version and suggested task, server rename, no generation POST/click, Stop replay preserves receipt. Synthetic native control, owner-ingested transcript and HTTP model only; no real audio, ASR, Mac or provider-quality proof."
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
      // Restore the saved preferences through the real API before isolated teardown.
      expect
        .soft(
          (
            await page.request.put("/api/meetings/preferences", {
              data: {
                defaultCaptureMode: original.defaultCaptureMode,
                rememberedSource: original.rememberedSource,
                summarizeOnStop: original.summarizeOnStop,
                summaryTemplateId: original.summaryTemplateId
              }
            })
          ).status()
        )
        .toBe(200);
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
