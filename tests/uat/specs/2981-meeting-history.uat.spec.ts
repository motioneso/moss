import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { MeetingHistoryPage, MeetingRecord } from "@moss/shared";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import { meetingRow } from "./meeting-minimal-ui.js";
import { assertMeetingHistoryLayout } from "./meeting-history-layout.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;

async function search(page: Page, query: string): Promise<MeetingHistoryPage> {
  const response = page.waitForResponse(
    (result) =>
      result.url().endsWith("/api/meetings/history/search") &&
      result.request().method() === "POST" &&
      result.request().postDataJSON().query === query
  );
  await page.getByRole("searchbox", { name: "Search meetings", exact: true }).fill(query);
  const result = await response;
  expect(result.status()).toBe(200);
  if (query) {
    expect(result.url()).not.toContain(query);
    expect(new URL(page.url()).search).not.toContain(query);
  }
  return result.json() as Promise<MeetingHistoryPage>;
}

// Synthetic text is inserted through production record/notes/transcript endpoints. This proves
// assembled history search and metadata, never recording, ASR, or speaker identification.
test("Minimal list searches all current text, preserves API filters and opens a meeting directly (#2981)", async ({
  page
}) => {
  test.setTimeout(180_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  const ids: string[] = [];
  let observeDeletedSelection = false;
  let deletedSelectionSearches = 0;
  const countDeletedSelectionSearches = (request: Request) => {
    if (
      observeDeletedSelection &&
      request.method() === "POST" &&
      request.url().endsWith("/api/meetings/history/search")
    )
      deletedSelectionSearches += 1;
  };
  page.on("request", countDeletedSelectionSearches);
  const marker = `history${randomUUID().replaceAll("-", "")}`;
  const title = `History ${marker}`;
  async function create(title: string): Promise<MeetingRecord> {
    const response = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(response.status()).toBe(201);
    const meeting = (await response.json()).meeting as MeetingRecord;
    ids.push(meeting.id);
    return meeting;
  }
  try {
    const target = await create(title);
    expect(
      (
        await page.request.put(`/api/meetings/records/${target.id}/notes`, {
          data: { requestKey: randomUUID(), expectedRevision: 0, personalNotes: "Orchard agenda." }
        })
      ).status()
    ).toBe(200);
    const source = {
      sourceId: "history-synthetic-mic",
      epoch: 1,
      kind: "microphone",
      label: "Declared synthetic microphone",
      startMs: 0,
      endMs: 10000
    };
    const firstSegment = {
      meetingId: target.id,
      segmentId: "history-first",
      sourceId: source.sourceId,
      epoch: 1,
      startMs: 1000,
      endMs: 3000,
      revision: 1,
      text: "Birch decision.",
      finality: "final",
      provenance: "transcription",
      speakerId: null
    };
    const secondSegment = {
      ...firstSegment,
      segmentId: "history-second",
      startMs: 5000,
      endMs: 7000,
      text: "Maple concern.",
      finality: "provisional"
    };
    const ingested = await page.request.post(`/api/meetings/records/${target.id}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [source],
        events: [
          { cursor: 1, segment: firstSegment },
          { cursor: 2, segment: secondSegment }
        ],
        stopCutoffMs: null
      }
    });
    expect(ingested.status()).toBe(201);
    const version = (await ingested.json()).receipt.version as number;
    for (let index = 0; index < 31; index++)
      await create(`Recent history filler ${index} ${randomUUID()}`);
    const notesOnly = await create(`Notes only ${marker}`);
    expect(
      (
        await page.request.put(`/api/meetings/records/${notesOnly.id}/notes`, {
          data: {
            requestKey: randomUUID(),
            expectedRevision: 0,
            personalNotes: "Saved without a transcript."
          }
        })
      ).status()
    ).toBe(200);

    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Load older meetings", exact: true })
    ).toBeVisible();
    await expect(meetingRow(page, title)).toHaveCount(0);
    // Search before loading the older page: all terms cross title, notes and two current turns.
    const query = `${marker} orchard birch maple`;
    const found = await search(page, query);
    expect(found.meetings.map((meeting) => meeting.id)).toEqual([target.id]);
    expect(found.nextCursor).toBeNull();
    expect(found.meetings[0]).toMatchObject({
      capture: { status: "unavailable" },
      transcript: {
        segmentCount: 2,
        finalSegmentCount: 1,
        provisionalSegmentCount: 1,
        span: { startMs: 1000, endMs: 7000 }
      }
    });
    expect(found.meetings[0]).not.toHaveProperty("personalNotes");
    await search(page, "");
    await expect(meetingRow(page, title)).toHaveCount(0);
    await page.getByRole("button", { name: "Load older meetings", exact: true }).click();
    await expect(meetingRow(page, title)).toBeVisible();
    await search(page, query);
    const filtered = await page.request.post("/api/meetings/history/search", {
      data: { query, filter: "needs-review", limit: 30 }
    });
    expect(filtered.status()).toBe(200);
    expect((await filtered.json()).meetings.map((meeting: MeetingRecord) => meeting.id)).toEqual([
      target.id
    ]);
    const targetButton = meetingRow(page, title);
    await expect(targetButton).toBeVisible();
    await expect(targetButton).toContainText("Personal notes");
    await expect(page.getByLabel("State", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Capture: Unavailable", { exact: false })).toHaveCount(0);
    await assertMeetingHistoryLayout(page, title);
    await targetButton.focus();
    await targetButton.press("Enter");
    await expect(page).toHaveURL(new RegExp(`id=${target.id}`));
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
      "Maple concern."
    );
    await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
      "Orchard agenda."
    );
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Search meetings", exact: true })).toHaveValue(
      query
    );
    await expect(targetButton).toBeVisible();

    // Real browser offline state pauses new queries; reconnect resumes the actual request.
    const absentQuery = `absent${marker}`;
    await page.context().setOffline(true);
    await page.getByRole("searchbox", { name: "Search meetings", exact: true }).fill(absentQuery);
    await expect(
      page.getByRole("status").filter({ hasText: "Search will continue when you reconnect" })
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("No meetings match this search.", { exact: true })).toHaveCount(0);
    const resumed = page.waitForResponse(
      (result) =>
        result.url().endsWith("/api/meetings/history/search") &&
        result.request().method() === "POST" &&
        result.request().postDataJSON().query === absentQuery
    );
    await page.context().setOffline(false);
    expect((await resumed).status()).toBe(200);
    await expect(page.getByText("No meetings match this search.", { exact: true })).toBeVisible();

    await search(page, marker);
    for (const [filter, expectedId] of [
      ["notes-only", notesOnly.id],
      ["transcript", target.id]
    ] as const) {
      const response = await page.request.post("/api/meetings/history/search", {
        data: { query: marker, filter, limit: 30 }
      });
      expect(response.status()).toBe(200);
      expect((await response.json()).meetings.map((meeting: MeetingRecord) => meeting.id)).toEqual([
        expectedId
      ]);
    }
    await expect(meetingRow(page, notesOnly.title)).toContainText("Personal notes");

    // Correction must remove superseded words while retaining the corrected current turn.
    const corrected = await page.request.post(`/api/meetings/records/${target.id}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: version,
        sources: [source],
        events: [
          {
            cursor: 3,
            segment: {
              ...secondSegment,
              revision: 2,
              text: "Willow resolution.",
              finality: "final",
              provenance: "correction"
            }
          }
        ],
        stopCutoffMs: 10000
      }
    });
    expect(corrected.status()).toBe(201);
    expect((await search(page, `${marker} maple`)).meetings).toEqual([]);
    expect((await search(page, `${marker} willow`)).meetings.map((meeting) => meeting.id)).toEqual([
      target.id
    ]);
    await targetButton.click();
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
      "Willow resolution."
    );
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).not.toContainText(
      "Maple concern."
    );
    expect((await page.request.delete(`/api/meetings/records/${target.id}`)).status()).toBe(204);
    ids.splice(ids.indexOf(target.id), 1);
    observeDeletedSelection = true;
    await page.reload();
    await expect(page.getByText("This meeting is unavailable", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveCount(
      0
    );
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "Search meetings", exact: true })
    ).toBeVisible();
    await expect(targetButton).toHaveCount(0);
    // No render-driven refetch loop after a selected record disappears.
    expect(deletedSelectionSearches).toBeLessThanOrEqual(3);
    console.log(
      "MEETINGS_HISTORY_UAT real UI/API; older-than-page search across title/notes/current turns; real correction; factual metadata; direct workspace navigation; retained search on back; real offline pause/reconnect; keyboard/mobile/light/dark/teal; deleted meeting content hidden. Synthetic text only, no audio or capture proof."
    );
  } finally {
    try {
      await page.context().setOffline(false);
      let deletedFixtures = 0;
      for (const id of ids) {
        const status = (await page.request.delete(`/api/meetings/records/${id}`)).status();
        expect.soft(status).toBe(204);
        if (status === 204) deletedFixtures += 1;
      }
      if (observeDeletedSelection) {
        // Keep observing during all cleanup requests, while the denied selection stays mounted.
        expect(deletedSelectionSearches).toBeLessThanOrEqual(3);
        expect(deletedFixtures).toBe(ids.length);
        console.log("MEETINGS_HISTORY_CLEANUP_UAT deleted-selection searches bounded", {
          searches: deletedSelectionSearches,
          deletedFixtures
        });
      }
    } finally {
      page.off("request", countDeletedSelectionSearches);
    }
  }
});
