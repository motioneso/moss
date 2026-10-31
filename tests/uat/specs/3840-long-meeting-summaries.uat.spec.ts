import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MeetingOutputArtifact } from "@moss/shared";
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

// Run with JARVIS_UAT_REAL_CHAT_PROVIDER=claude. The transcripts are disclosed stand-ins
// posted through the real transcript API, so Moss's own path runs unaltered. The long
// transcript is sized so one summary prompt would pass the 64 KiB cap, which failed every
// long summary before #3840. The summary model calls are real Claude subscription calls.
test("Long and short recordings both get summaries on the Meeting screen (#3840)", async ({
  page
}) => {
  test.setTimeout(900_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  const project = requireUatProjectName();
  await signInUatAdmin(page);
  await page.goto(requireUatBaseURL());
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI providers", exact: true })).toBeVisible();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingClaude(project, "2.1.312");

  const created: string[] = [];
  async function createMeeting(title: string, segmentTexts: readonly string[]): Promise<string> {
    const createdResponse = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(createdResponse.status()).toBe(201);
    const meetingId = (await createdResponse.json()).meeting.id as string;
    created.push(meetingId);
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
            endMs: segmentTexts.length * 10000
          }
        ],
        events: segmentTexts.map((text, index) => ({
          cursor: index + 1,
          segment: {
            meetingId,
            segmentId: randomUUID(),
            sourceId: "synthetic-mic",
            epoch: 1,
            startMs: index * 10000,
            endMs: index * 10000 + 10000,
            revision: 1,
            text,
            finality: "final",
            provenance: "transcription",
            speakerId: null
          }
        })),
        stopCutoffMs: segmentTexts.length * 10000
      }
    });
    expect(transcript.status()).toBe(201);
    return meetingId;
  }

  async function writeSummaryOnScreen(meetingId: string, title: string): Promise<void> {
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).getByRole("button").click();
    await openMeetingAction(page, "Rewrite summary");
    const summary = page.getByRole("region", { name: "Summary and actions", exact: true });
    const write = summary.getByRole("button", { name: "Write summary", exact: true });
    await expect(write).toBeEnabled();
    const generated = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/meetings/records/${meetingId}/outputs`) &&
        r.request().method() === "POST",
      { timeout: 600_000 }
    );
    await write.click();
    const result = await generated;
    const resultBody = await result.text();
    console.log(`LONG_SUMMARY_UAT generation response ${result.status()} ${resultBody}`);
    expect(result.status(), `summary generation status ${result.status()} ${resultBody}`).toBe(200);
    const outputs = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
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
    console.log(
      `LONG_SUMMARY_UAT summary saved meeting=${meetingId} segments=${artifact.inputs.transcript?.segments.length ?? 0}`
    );
  }

  try {
    const shortTitle = `Short summary check ${randomUUID()}`;
    const shortId = await createMeeting(shortTitle, [
      "We decided to launch the Orchid pilot on Friday. Alex will prepare the checklist."
    ]);
    await writeSummaryOnScreen(shortId, shortTitle);
    console.log("LONG_SUMMARY_UAT short recording summary saved on the single-call path");

    const longTitle = `Long summary check ${randomUUID()}`;
    const longSegments = Array.from({ length: 60 }, (_, index) => {
      const topic =
        `Topic ${index + 1}: the team reviewed milestone ${index + 1} for the Orchid rollout. ` +
        `They decided to ship phase ${index + 1} on Friday, and Alex will prepare checklist ${index + 1}. ` +
        `The group discussed risks, staffing, customer feedback, and the budget for this phase in detail. `;
      return topic.repeat(6);
    });
    const longCharacters = longSegments.join("").length;
    expect(longCharacters).toBeGreaterThan(70_000);
    const longId = await createMeeting(longTitle, longSegments);
    console.log(`LONG_SUMMARY_UAT long transcript stand-in characters=${longCharacters}`);
    await writeSummaryOnScreen(longId, longTitle);
    console.log("LONG_SUMMARY_UAT long recording summary saved");

    const notesTitle = `Long notes check ${randomUUID()}`;
    const notesId = await createMeeting(notesTitle, [
      "We decided to launch the Orchid pilot on Friday. Alex will prepare the checklist."
    ]);
    // Notes cap at 64,000 characters in the app. 62,909 characters of notes plus the
    // transcript segment, recording details, and guidance push one prompt over the cap,
    // so the notes must be cut into pieces for this summary.
    const longNotes = Array.from({ length: 270 }, (_, index) => {
      return (
        `Note ${index + 1}: the team decided to complete step ${index + 1} of the Orchid rollout this week. ` +
        `Alex will prepare checklist ${index + 1} and Priya will review the budget for step ${index + 1}. ` +
        `The open question for step ${index + 1} is whether the vendor can deliver on time. `
      );
    }).join("\n");
    expect(longNotes.length).toBeGreaterThan(62_000);
    const notesSaved = await page.request.put(`/api/meetings/records/${notesId}/notes`, {
      data: { requestKey: randomUUID(), expectedRevision: 0, personalNotes: longNotes }
    });
    expect(notesSaved.status()).toBe(200);
    console.log(`LONG_SUMMARY_UAT long notes stand-in characters=${longNotes.length}`);
    await writeSummaryOnScreen(notesId, notesTitle);
    const notesOutputs = await page.request.get(`/api/meetings/records/${notesId}/outputs`);
    const notesBody = (await notesOutputs.json()) as { artifacts: MeetingOutputArtifact[] };
    expect(notesBody.artifacts[0]!.inputs.personalNotes.length).toBe(longNotes.length);
    console.log("LONG_SUMMARY_UAT long notes summary saved");
  } finally {
    for (const meetingId of created)
      await page.request.delete(`/api/meetings/records/${meetingId}`).catch(() => undefined);
  }
});
