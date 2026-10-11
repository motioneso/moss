import { randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";
import type { MeetingTranscriptSnapshotResponse } from "@moss/shared";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import { meetingRow, openMeetingAction } from "./meeting-minimal-ui.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;

// Only synthetic retained text uses the real record/transcript routes. No capture, provider
// request, response substitution or native login-item operation is part of this browser proof.
test("Meeting search names its timeline scope and keeps separate cited evidence beyond the cap (#3397)", async ({
  page
}) => {
  test.setTimeout(180_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  let meetingId: string | undefined;
  const title = `Audit search ${randomUUID()}`;
  const displayedPhrase = "Displayed cedar decision.";
  const omittedPhrase = "Retained quartz decision beyond the view.";
  const captureWrites: string[] = [];
  const observeCaptureWrites = (request: Request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.includes("/capture/"))
      captureWrites.push(new URL(request.url()).pathname);
  };
  page.on("request", observeCaptureWrites);
  try {
    const created = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(created.status()).toBe(201);
    meetingId = (await created.json()).meeting.id as string;
    const captureBefore = await page.request.get(`/api/meetings/records/${meetingId}/capture`);
    expect(captureBefore.status()).toBe(200);
    const initialCapture = await captureBefore.json();
    expect(initialCapture.capture).toBeNull();
    const source = {
      sourceId: "audit-synthetic-mic",
      epoch: 1,
      kind: "microphone",
      label: "Declared synthetic microphone",
      startMs: 0,
      endMs: 501000
    };
    for (let batch = 0; batch < 6; batch += 1) {
      const first = batch * 100;
      const ingested = await page.request.post(`/api/meetings/records/${meetingId}/transcript`, {
        data: {
          requestKey: randomUUID(),
          expectedVersion: batch,
          sources: [source],
          stopCutoffMs: null,
          events: Array.from({ length: Math.min(100, 501 - first) }, (_, offset) => {
            const index = first + offset;
            return {
              cursor: index + 1,
              segment: {
                meetingId,
                segmentId: `audit-line-${index + 1}`,
                sourceId: source.sourceId,
                epoch: 1,
                startMs: index * 1000,
                endMs: (index + 1) * 1000,
                revision: 1,
                text:
                  index === 0
                    ? displayedPhrase
                    : index === 500
                      ? omittedPhrase
                      : `Ordinary synthetic discussion ${index + 1}.`,
                finality: "final",
                provenance: "transcription",
                speakerId: null
              }
            };
          })
        }
      });
      expect(ingested.status()).toBe(201);
    }
    const transcript = await page.request.get(
      `/api/meetings/records/${meetingId}/transcript?maxSegments=500&maxCharacters=100000`
    );
    expect(transcript.status()).toBe(200);
    const retained = (await transcript.json()) as MeetingTranscriptSnapshotResponse;
    expect(retained.snapshot.segments).toHaveLength(500);
    expect(retained.snapshot.omittedSegments).toBe(1);
    expect(retained.snapshot.segments.some((line) => line.text === omittedPhrase)).toBe(false);

    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await openMeetingAction(page, "Search transcript");
      const search = page.getByRole("searchbox", {
        name: "Search transcript timeline",
        exact: true
      });
      await expect(search).toBeFocused();
      await expect(search).toHaveAttribute("aria-describedby", "meeting-transcript-search-scope");
      await expect(
        page.getByText(
          "Search checks only the loaded timeline lines. Separate cited excerpts aren’t searched.",
          { exact: true }
        )
      ).toBeVisible();
      const pane = page.getByRole("region", { name: "Transcript", exact: true });
      await expect(pane).toContainText("1 line is outside this view’s limits.");
      await expect(pane).toContainText(
        "Search checks only loaded timeline lines. Separate cited excerpts aren’t searched."
      );
      await expect(pane).toContainText("Meeting chat needs a ready configured model.");
      await search.fill(displayedPhrase.toUpperCase());
      await expect(pane.getByText(displayedPhrase, { exact: true })).toBeVisible();
      await expect(pane.getByRole("article")).toHaveCount(1);
      await search.fill(omittedPhrase);
      await expect(pane.getByRole("status")).toHaveText("No loaded timeline lines match.");
      await expect(pane.getByRole("article")).toHaveCount(0);
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth).toBeLessThanOrEqual(width + 1);
      await pane.getByRole("button", { name: "Close search", exact: true }).click();
      await expect(search).toHaveCount(0);
      await expect(pane.getByRole("article")).toHaveCount(500);
    }

    // Enter the existing exact-reference route with a real retained segment outside the
    // snapshot. This proves deep-link resolution, not provider-generated citation quality.
    const reference = new URLSearchParams({
      id: meetingId,
      segmentId: "audit-line-501",
      segmentRevision: "1",
      startCharacter: "0",
      endCharacter: String(omittedPhrase.length)
    });
    await page.goto(`/meetings?${reference}`);
    const excerpt = page.locator(`#meeting-reference-${meetingId}`);
    await expect(excerpt).toContainText(omittedPhrase);
    await expect(excerpt).toBeFocused();
    await openMeetingAction(page, "Search transcript");
    const citedSearch = page.getByRole("searchbox", {
      name: "Search transcript timeline",
      exact: true
    });
    await citedSearch.fill(omittedPhrase);
    const citedPane = page.getByRole("region", { name: "Transcript", exact: true });
    await expect(citedPane).toContainText("Separate cited excerpts aren’t searched.");
    await expect(citedPane.getByRole("status")).toHaveText("No loaded timeline lines match.");
    await expect(citedPane.locator(".meetings-transcript-turn")).toHaveCount(0);
    await expect(excerpt).toContainText(omittedPhrase);
    await citedSearch.fill(displayedPhrase.toUpperCase());
    await expect(citedPane.locator(".meetings-transcript-turn")).toHaveCount(1);
    await expect(excerpt).toContainText(omittedPhrase);
    await citedPane.getByRole("button", { name: "Close search", exact: true }).click();
    await expect(citedPane.locator(".meetings-transcript-turn")).toHaveCount(500);
    await expect(excerpt).toContainText(omittedPhrase);
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    await openMeetingAction(page, "Search transcript");
    await expect(
      page.getByRole("searchbox", { name: "Search transcript timeline", exact: true })
    ).toHaveValue("");
    const captureAfter = await page.request.get(`/api/meetings/records/${meetingId}/capture`);
    expect(captureAfter.status()).toBe(200);
    expect(await captureAfter.json()).toEqual(initialCapture);
    expect(captureWrites).toEqual([]);
    console.log(
      "AUDIT_MEETINGS_UAT real routes: 501 synthetic retained lines; timeline-only match/no-match at 1280/390/320; separate cited excerpt excluded from search and preserved; close and return; exact evidence beyond cap; no capture writes. Native startup and active-capture navigation remain unverified."
    );
  } finally {
    page.off("request", observeCaptureWrites);
    if (meetingId)
      expect
        .soft((await page.request.delete(`/api/meetings/records/${meetingId}`)).status())
        .toBe(204);
  }
});
