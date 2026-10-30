import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MeetingOutputArtifact } from "@moss/shared";
import { installPromotedMeetingClaude } from "./meeting-promoted-claude.js";
import { meetingRow, openMeetingAction } from "./meeting-minimal-ui.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

// Run with JARVIS_UAT_REAL_CHAT_PROVIDER=claude. Short synthetic source, real subscription inference. No intercepted Moss/provider responses.
// This proves configured-default dispatch and visible validated output, not audio/ASR or
// whole long-meeting coverage. The disposable provisioner owns login copying and cleanup.
test("Meeting summary uses the configured Claude default after a CLI update (#3565)", async ({
  page
}) => {
  test.setTimeout(360_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI providers", exact: true })).toBeVisible();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingClaude(requireUatProjectName());
  const effective = await page.request.get("/api/ai/chat-model-override");
  expect(effective.status()).toBe(200);
  expect((await effective.json()).settings.selectedModel.id).toBe(model.id);

  const title = `Synthetic Orchid review ${randomUUID()}`;
  const created = await page.request.post("/api/meetings/records", {
    data: { requestKey: randomUUID(), title }
  });
  expect(created.status()).toBe(201);
  const meetingId = (await created.json()).meeting.id as string;
  const path = `/api/meetings/records/${meetingId}`;
  const segmentId = randomUUID();
  const source =
    "We decided to launch the Orchid pilot on Friday. Alex will prepare the checklist.";
  const transcript = await page.request.post(`${path}/transcript`, {
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
  await page.getByRole("link", { name: "Meetings", exact: true }).click();
  await meetingRow(page, title).getByRole("button").click();
  await openMeetingAction(page, "Rewrite summary");
  const summary = page.getByRole("region", { name: "Summary and actions", exact: true });
  const write = summary.getByRole("button", { name: "Write summary", exact: true });
  await expect(write).toBeEnabled();
  const generated = page.waitForResponse(
    (r) => r.url().endsWith(`${path}/outputs`) && r.request().method() === "POST",
    { timeout: 120_000 }
  );
  await write.click();
  const result = await generated;
  expect(result.status(), `summary generation status ${result.status()}`).toBe(200);
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
  expect(artifact.content.overview).toMatch(/Orchid/i);
  await expect(summary).toContainText(artifact.content.overview);
  expect(artifact.content.decisions.length).toBeGreaterThan(0);
  expect(artifact.content.decisions[0]!.evidence).toContainEqual(
    expect.objectContaining({ kind: "transcript", meetingId, segmentId, segmentRevision: 1 })
  );
  console.log(
    `MEETING_PROMOTED_CLAUDE_REAL_UAT selectedModel=${model.id} providerModel=${model.providerModelId} summaryVersion=${body.headVersion} validatedEvidence=true visibleOverview=true`
  );
});
