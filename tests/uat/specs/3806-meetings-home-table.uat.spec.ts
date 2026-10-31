import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MeetingRecord } from "@moss/shared";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import { meetingRow } from "./meeting-minimal-ui.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;

// Synthetic meetings are created through the production record, type and transcript
// endpoints. This proves the assembled home table, never recording or ASR.
test("Meetings home table finds a recording by transcript words and opens it (#3806)", async ({
  page
}) => {
  test.setTimeout(180_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  const marker = `hometable${randomUUID().replaceAll("-", "")}`;
  const word = `transcriptonly${marker}`;
  const title = `Home table ${marker}`;
  const ids: string[] = [];
  async function create(name: string): Promise<MeetingRecord> {
    const response = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title: name }
    });
    expect(response.status()).toBe(201);
    const meeting = (await response.json()).meeting as MeetingRecord;
    ids.push(meeting.id);
    return meeting;
  }
  try {
    const target = await create(title);
    const source = {
      sourceId: "home-table-synthetic-mic",
      epoch: 1,
      kind: "microphone",
      label: "Declared synthetic microphone",
      startMs: 0,
      endMs: 10000
    };
    const ingested = await page.request.post(`/api/meetings/records/${target.id}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [source],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId: target.id,
              segmentId: "home-table-first",
              sourceId: source.sourceId,
              epoch: 1,
              startMs: 1000,
              endMs: 3000,
              revision: 1,
              text: `The ${word} decision.`,
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
    const recording = await page.request.get(`/api/meetings/records/${target.id}/recording`);
    expect(recording.status()).toBe(200);
    const revision = ((await recording.json()).metadata?.revision as number | undefined) ?? 0;
    const typed = await page.request.put(`/api/meetings/records/${target.id}/recording/type`, {
      data: { expectedRevision: revision, typeId: "work-meeting" }
    });
    expect(typed.status()).toBe(200);

    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    for (const heading of ["Title", "Date", "Length", "Attendees", "Type"])
      await expect(table.getByRole("columnheader", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Search meetings", exact: true }).fill(word);
    const row = meetingRow(page, title);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Added");
    await expect(row).toContainText("—");
    await expect(row).toContainText("Work meeting");

    // The type filter intersects with the transcript search, it does not replace it.
    await page.getByLabel("Recording type", { exact: true }).selectOption("work-meeting");
    await expect(row).toBeVisible();
    await page.getByLabel("Recording type", { exact: true }).selectOption("appointment");
    await expect(page.getByText("No meetings match this search.", { exact: true })).toBeVisible();
    await page.getByLabel("Recording type", { exact: true }).selectOption("");
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`id=${target.id}`));
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(word);
  } finally {
    for (const id of ids) await page.request.delete(`/api/meetings/records/${id}`);
  }
});
