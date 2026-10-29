import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { MeetingOutputArtifact } from "@moss/shared";
import { recordingBundle, recordingFile } from "../../fixtures/recording-bundle.js";
import {
  syntheticMeetingPcm,
  CAPTURE_FIXTURE_MODEL,
  CAPTURE_FIXTURE_TEXT
} from "../fixtures/meeting-capture-fixture-server.js";
import { installPromotedMeetingClaude } from "./meeting-promoted-claude.js";
import { meetingRow, openMeetingAction } from "./meeting-minimal-ui.js";
import {
  bringUpRealChatModel,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const exec = promisify(execFile);

// Run with JARVIS_UAT_REAL_CHAT_PROVIDER=claude. The stack's Claude CLI is set to 2.1.312,
// which the old constrained runner's allowlist rejects (2.1.282 and 2.1.286 only), so a saved
// summary here proves summaries no longer depend on that allowlist. The transcription leg uses
// the disclosed generated-audio ASR stand-in from #3601; the summary model call is real.
// The import runs before the chat model is pinned, because a pinned user stays on the pinned
// provider for transcription too.
test("Meeting summaries work on a non-allowlisted Claude CLI, including an imported recording (#3696)", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  const project = requireUatProjectName();
  await signInUatAdmin(page);

  const fixtureName = `${project}-one-path-asr`;
  const port = Number((await exec("devports", ["claim", "one-path-asr"])).stdout.trim());
  let importedMeetingId: string | undefined;
  let meetingId: string | undefined;
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
      "tests/uat/fixtures/meeting-capture-fixture-cli.ts",
      String(port)
    ]);
    await expect
      .poll(async () =>
        (await exec("docker", ["logs", fixtureName])).stdout.includes(
          "[meeting-capture-fixture] ready"
        )
      )
      .toBe(true);
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Generated audio provider",
        baseUrl: `http://${fixtureName}:${port}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-real-key" }
      }
    });
    expect(provider.status()).toBe(201);
    const providerId = (await provider.json()).provider.id;
    const added = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: CAPTURE_FIXTURE_MODEL,
        displayName: "Generated audio model",
        capabilities: ["transcription"],
        status: "active",
        tier: "economy"
      }
    });
    expect(added.status()).toBe(201);
    const asrModelId = (await added.json()).model.id;
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
    await page.getByRole("button", { name: "AI providers", exact: true }).click();
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    const selection = page.getByLabel("Provider and model", { exact: true });
    await selection.scrollIntoViewIfNeeded();
    await selection.selectOption(asrModelId);
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/ai/services/transcription/binding") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save transcription provider", exact: true }).click();
    expect((await saved).status()).toBe(200);
    expect(
      (
        await page.request.put("/api/meetings/preferences", {
          data: { summarizeOnStop: false, transcriptLanguage: "en" }
        })
      ).status()
    ).toBe(200);
    const bundle = { ...recordingBundle(), sourceDeviceId: randomUUID() };
    const wav = Buffer.from(bundle.wav.base64, "base64");
    syntheticMeetingPcm(120).copy(wav, 44);
    const imported = await page.request.post("/api/meetings/recording-imports", {
      data: { ...bundle, wav: recordingFile(bundle.wav.name, wav) }
    });
    expect(imported.status()).toBe(202);
    const accepted = await imported.json();
    importedMeetingId = accepted.meetingId;
    await expect
      .poll(
        async () => {
          const status = await (
            await page.request.get(`/api/meetings/recording-imports/${accepted.id}`)
          ).json();
          console.log(`ONE_PATH_MEETING_UAT import status ${JSON.stringify(status)}`);
          return status.state;
        },
        { timeout: 60_000 }
      )
      .toBe("complete");
    const importedTranscript = await page.request.get(
      `/api/meetings/records/${importedMeetingId}/transcript?maxSegments=50&maxCharacters=10000`
    );
    expect(importedTranscript.status()).toBe(200);
    expect(JSON.stringify(await importedTranscript.json())).toContain(CAPTURE_FIXTURE_TEXT);

    await page.goto(requireUatBaseURL());
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
    await page.getByRole("button", { name: "AI providers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "AI providers", exact: true })).toBeVisible();
    const model = await bringUpRealChatModel(page);
    installPromotedMeetingClaude(project, "2.1.312");
    const effective = await page.request.get("/api/ai/chat-model-override");
    expect(effective.status()).toBe(200);
    expect((await effective.json()).settings.selectedModel.id).toBe(model.id);

    async function writeSummaryOnScreen(
      targetMeetingId: string,
      title: string | null
    ): Promise<void> {
      const path = `/api/meetings/records/${targetMeetingId}`;
      if (title === null) {
        await page.goto(`/meetings?id=${targetMeetingId}`);
      } else {
        await page.getByRole("link", { name: "Meetings", exact: true }).click();
        await meetingRow(page, title).click();
      }
      await openMeetingAction(page, "Rewrite summary");
      const summary = page.getByRole("region", { name: "Summary and actions", exact: true });
      const write = summary.getByRole("button", { name: "Write summary", exact: true });
      await expect(write).toBeEnabled();
      const generated = page.waitForResponse(
        (r) => r.url().endsWith(`${path}/outputs`) && r.request().method() === "POST",
        { timeout: 180_000 }
      );
      await write.click();
      const result = await generated;
      const resultBody = await result.text();
      console.log(`ONE_PATH_MEETING_UAT generation response ${result.status()} ${resultBody}`);
      expect(result.status(), `summary generation status ${result.status()} ${resultBody}`).toBe(
        200
      );
      const outputs = await page.request.get(`${path}/outputs`);
      expect(outputs.status()).toBe(200);
      const body = (await outputs.json()) as {
        headVersion: number;
        artifacts: MeetingOutputArtifact[];
      };
      expect(body.headVersion).toBe(1);
      const artifact = body.artifacts[0]!;
      expect(JSON.parse(artifact.modelRoute)).toMatchObject({
        modelId: model.id,
        providerKind: "anthropic"
      });
      expect(artifact.content.overview.length).toBeGreaterThan(0);
      await expect(summary).toContainText(artifact.content.overview);
    }

    const title = `Synthetic Orchid review ${randomUUID()}`;
    const created = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(created.status()).toBe(201);
    meetingId = (await created.json()).meeting.id as string;
    const segmentId = randomUUID();
    const source =
      "We decided to launch the Orchid pilot on Friday. Alex will prepare the checklist.";
    const transcript = await page.request.post(`/api/meetings/records/${meetingId}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [
          {
            sourceId: "synthetic-mic",
            epoch: 1,
            kind: "microphone",
            label: "Synthetic source",
            startMs: 0,
            endMs: 10000
          }
        ],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId,
              segmentId,
              sourceId: "synthetic-mic",
              epoch: 1,
              startMs: 0,
              endMs: 10000,
              revision: 1,
              text: source,
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: 10000
      }
    });
    expect(transcript.status()).toBe(201);
    await writeSummaryOnScreen(meetingId, title);
    console.log(
      `ONE_PATH_MEETING_UAT normal meeting summary saved with Claude 2.1.312 model=${model.id}`
    );

    await writeSummaryOnScreen(importedMeetingId!, null);
    console.log("ONE_PATH_MEETING_UAT imported recording summary saved with Claude 2.1.312");
  } finally {
    if (importedMeetingId)
      await page.request
        .delete(`/api/meetings/records/${importedMeetingId}`)
        .catch(() => undefined);
    if (meetingId)
      await page.request.delete(`/api/meetings/records/${meetingId}`).catch(() => undefined);
    await exec("docker", ["rm", "--force", fixtureName]).catch(() => undefined);
    await exec("devports", ["release", String(port)]).catch(() => undefined);
  }
});
