import { assertMeetingReviewLayout, assertProvisionalContrast } from "./meeting-review-layout.js";
import {
  assertMinimalMeetingWorkspace,
  meetingRow,
  openMeetingAction,
  openMeetingChat
} from "./meeting-minimal-ui.js";
import { randomUUID } from "node:crypto";
import { expect, test, type Dialog } from "@playwright/test";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

// Real browser/API assertions only; no screenshot or response substitution.
test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;

// First-use notes remain available with no linked Mac. New meeting → explicit Start recording
// is exercised separately by the synthetic capture spec.
test("Minimal meeting workspace edits titles, autosaves notes, resolves conflicts and deletes through real routes (#2981)", async ({
  page
}) => {
  test.setTimeout(120_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  let fixtureId: string | null = null;
  const title = `UAT meeting ${randomUUID()}`;
  const notesText = "Notes autosaved through navigation.\nSecond line.\nThird line.";
  try {
    const originalPreferences = await page.request.get("/api/meetings/preferences");
    expect(originalPreferences.status()).toBe(200);
    const savedPreferences = await originalPreferences.json();
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
    await expect(page.getByText("Link your Mac", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Open Trail Marker and follow its linking instructions.", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New meeting", exact: true })).toHaveCount(0);
    // Existing notes remain editable after unlinking. Seed through the real record API,
    // then open the record through the preserved history list.
    const response = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title: "Untitled meeting" }
    });
    expect(response.status()).toBe(201);
    fixtureId = (await response.json()).meeting.id as string;
    const afterNotes = await page.request.get("/api/meetings/preferences");
    expect(await afterNotes.json()).toEqual(savedPreferences);
    const capture = await page.request.get(`/api/meetings/records/${fixtureId}/capture`);
    expect(capture.status()).toBe(200);
    expect((await capture.json()).capture).toBeNull();
    await page.reload();
    await meetingRow(page, "Untitled meeting").click();
    await expect(page).toHaveURL(new RegExp(`id=${fixtureId}`));
    await assertMinimalMeetingWorkspace(page);
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
      "Untitled meeting"
    );
    await page.getByRole("button", { name: "Edit meeting title", exact: true }).click();
    const titleInput = page.getByLabel("Meeting title", { exact: true });
    await titleInput.fill("");
    await titleInput.pressSequentially(title, { delay: 0 });
    await expect(titleInput).toHaveValue(title);
    const renamed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/title`) &&
        response.request().method() === "PUT"
    );
    await titleInput.press("Tab");
    expect((await renamed).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
      title
    );
    await assertMeetingReviewLayout(page);
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await notes.fill(notesText);
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(meetingRow(page, title)).toContainText("Personal notes");
    await page.goBack();
    await expect(notes).toHaveValue(notesText);
    await page.goForward();
    await meetingRow(page, title).click();
    await expect(notes).toHaveValue(notesText);
    await page.reload();
    await expect(notes).toHaveValue(notesText);
    const persisted = await page.request.get(`/api/meetings/records/${fixtureId}`);
    expect((await persisted.json()).meeting.personalNotes).toBe(notesText);

    // A real second writer advances the revision. Local unsaved text must survive 409.
    const competing = await page.request.put(`/api/meetings/records/${fixtureId}/notes`, {
      data: {
        requestKey: randomUUID(),
        expectedRevision: 1,
        personalNotes: "Saved in another editor."
      }
    });
    expect(competing.status()).toBe(200);
    const conflict = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await notes.fill("Keep my local version.");
    expect((await conflict).status()).toBe(409);
    await expect(notes).toHaveValue("Keep my local version.");
    await expect(page.getByLabel("Current saved notes", { exact: true })).toHaveValue(
      "Saved in another editor."
    );
    const rebased = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Keep my version", exact: true }).click();
    expect((await rebased).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();

    await openMeetingChat(page);
    await expect(page.locator(".chatd--docked")).toBeVisible();
    const widths = await page.locator(".meetings-workspace").evaluate((element) => ({
      workspace: element.getBoundingClientRect().width,
      page: element.closest(".meetings-page")!.getBoundingClientRect().width
    }));
    expect(widths.workspace).toBeGreaterThanOrEqual(widths.page - 2);
    await page
      .locator(".topbar-actions")
      .getByRole("button", { name: /^(Chat with .+|Open chat)$/ })
      .click();

    // The fixture has no configured default model; check the real availability and button.
    const outputsResponse = await page.request.get(`/api/meetings/records/${fixtureId}/outputs`);
    expect(outputsResponse.status()).toBe(200);
    expect((await outputsResponse.json()).generationAvailability).toBe("model-unavailable");
    await openMeetingAction(page, "Rewrite summary");
    await expect(page.getByLabel("Summary style", { exact: true })).toHaveValue("general");
    await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeDisabled();
    await expect(
      page.getByText(
        "Your default model is unavailable or cannot produce structured summaries. Check its connection and try again. No other model will be used.",
        { exact: true }
      )
    ).toBeVisible();
    await page.getByRole("tab", { name: "Notes", exact: true }).click();
    await openMeetingAction(page, "Delete meeting");
    await expect(page.getByRole("dialog")).toContainText("permanently deleted");
    await expect(page.getByRole("dialog")).not.toContainText(/draft/i);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(notes).toHaveValue("Keep my local version.");
    expect((await page.request.get(`/api/meetings/records/${fixtureId}`)).status()).toBe(200);
    await openMeetingAction(page, "Delete meeting");
    const deletion = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}`) &&
        response.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Permanently delete meeting", exact: true }).click();
    expect((await deletion).status()).toBe(204);
    await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/meetings" && !url.search);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(meetingRow(page, title)).toHaveCount(0);
    await expect(page.getByText("This meeting is unavailable", { exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/meetings/records/${fixtureId}`)).status()).toBe(404);
    fixtureId = null;
    console.log(
      "MEETINGS_MINIMAL_UAT real routes: inline title, desktop split/mobile tabs, notes autosave/reload/navigation, real revision conflict/rebase, notes-only normal docked chat, overflow-only summary and deletion; no per-meeting sources."
    );
  } finally {
    if (fixtureId)
      expect
        .soft((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status())
        .toBe(204);
  }
});

test("Confirmed sign-out discards meeting notes without a second native warning (#2981)", async ({
  page
}) => {
  test.setTimeout(120_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  let fixtureId: string | undefined;
  const title = `UAT notes sign-out ${randomUUID()}`;
  const nativeDialogs: string[] = [];
  const onDialog = async (dialog: Dialog) => {
    nativeDialogs.push(dialog.type());
    // Accept an unexpected native prompt so the regression reports the duplicate instead of hanging.
    await dialog.accept();
  };
  page.on("dialog", onDialog);
  try {
    const created = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(created.status()).toBe(201);
    fixtureId = (await created.json()).meeting.id as string;
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    // A row click changes the route before its initial record GET necessarily resolves.
    // Go offline only once the real, labelled editor is mounted and editable.
    await expect(page).toHaveURL(new RegExp(`id=${fixtureId}`));
    await expect(notes).toBeVisible();
    await expect(notes).toBeEditable();
    await page.context().setOffline(true);
    await notes.fill("Keep these edits after canceling.");
    await expect(
      page.getByRole("status").filter({ hasText: "Couldn’t save. Your edits are kept here." })
    ).toBeVisible();
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Sign out with unsaved changes?" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(notes).toHaveValue("Keep these edits after canceling.");
    await page.context().setOffline(false);
    const savedAfterRetry = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    expect((await savedAfterRetry).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await page.context().setOffline(true);
    await notes.fill("Discard only after confirmation.");
    await expect(
      page.getByRole("status").filter({ hasText: "Couldn’t save. Your edits are kept here." })
    ).toBeVisible();
    // A failed save does not auto-retry on reconnect; the confirmation has no debounce race.
    await page.context().setOffline(false);
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "Discard changes and sign out", exact: true })
      .click();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    expect(nativeDialogs).toEqual([]);
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await signInUatAdmin(page);
    const saved = await page.request.get(`/api/meetings/records/${fixtureId}`);
    expect(saved.status()).toBe(200);
    expect((await saved.json()).meeting.personalNotes).toBe("Keep these edits after canceling.");
    console.log(
      "MEETINGS_SIGNOUT_UAT real offline autosave failure → sign-out canceled → reconnect/retry save → second failed edit discarded at sign-out; zero native dialogs; saved baseline preserved"
    );
  } finally {
    await page.context().setOffline(false);
    try {
      if (fixtureId) {
        if ((await page.request.get("/api/me")).status() === 401) await signInUatAdmin(page);
        expect
          .soft((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status())
          .toBe(204);
      }
    } finally {
      page.off("dialog", onDialog);
    }
  }
});

// Synthetic text is owner-ingested through the real POST route. This proves retained-text
// review and revision lookup, not microphone capture, ASR, diarization, or meeting chat.
test("Retained transcript review shows real source labels and immutable earlier revisions (#2981)", async ({
  page
}) => {
  test.setTimeout(120_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  let fixtureId: string | null = null;
  const title = `UAT synthetic transcript ${randomUUID()}`;
  try {
    const created = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(created.status()).toBe(201);
    fixtureId = (await created.json()).meeting.id as string;
    const source = {
      sourceId: "synthetic-microphone",
      epoch: 1,
      kind: "microphone",
      label: "Synthetic desk microphone",
      startMs: 0,
      endMs: 10000
    };
    const original = {
      meetingId: fixtureId,
      segmentId: "synthetic-segment",
      sourceId: source.sourceId,
      epoch: 1,
      startMs: 1000,
      endMs: 4000,
      revision: 1,
      text: "Synthetic draft wording.",
      finality: "provisional",
      provenance: "transcription",
      speakerId: null
    };
    const first = await page.request.post(`/api/meetings/records/${fixtureId}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [source],
        events: [{ cursor: 1, segment: original }],
        stopCutoffMs: null
      }
    });
    expect(first.status()).toBe(201);
    const firstReceipt = (await first.json()).receipt;
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    const transcript = page.getByRole("region", { name: "Transcript", exact: true });
    await expect(transcript).toContainText("You");
    await expect(transcript).toContainText("Synthetic draft wording.");
    await expect(transcript).toContainText("Still being finalised");
    await assertProvisionalContrast(page);
    const corrected = await page.request.post(`/api/meetings/records/${fixtureId}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: firstReceipt.version,
        sources: [source],
        events: [
          {
            cursor: 2,
            segment: {
              ...original,
              revision: 2,
              text: "Synthetic corrected wording.",
              finality: "final",
              provenance: "correction"
            }
          }
        ],
        stopCutoffMs: 10000
      }
    });
    expect(corrected.status()).toBe(201);
    await page.reload();
    await expect(transcript).toContainText("Synthetic corrected wording.");
    await expect(transcript).toContainText("0:01");
    await expect(transcript).not.toContainText("Still being finalised");
    await expect(transcript).not.toContainText("Source labels only");
    await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("");
    const url = new URL(page.url());
    url.searchParams.set("segmentId", original.segmentId);
    url.searchParams.set("segmentRevision", "1");
    url.searchParams.set("startCharacter", "0");
    url.searchParams.set("endCharacter", String(original.text.length));
    await page.goto(url.toString());
    const evidence = page.locator(`#meeting-reference-${fixtureId}`);
    await expect(evidence).toContainText(original.text);
    await expect(evidence).toContainText("Earlier text at 0:01");
    await expect(evidence).toBeFocused();
    await expect(transcript).toContainText("Synthetic corrected wording.");
    await openMeetingAction(page, "Search transcript");
    await page.getByRole("searchbox", { name: "Search transcript", exact: true }).fill("corrected");
    await expect(transcript.locator(".meetings-transcript-turn")).toHaveCount(1);
    await page.getByRole("button", { name: "Close search", exact: true }).click();
  } finally {
    if (fixtureId)
      expect
        .soft((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status())
        .toBe(204);
  }
});
