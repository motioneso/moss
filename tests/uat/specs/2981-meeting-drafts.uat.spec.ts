import { assertMeetingReviewLayout, assertProvisionalContrast } from "./meeting-review-layout.js";
import { randomUUID } from "node:crypto";
import { expect, test, type Dialog } from "@playwright/test";
import type { MeetingCapturePreferences, MeetingRecord } from "@moss/shared";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

// Repository live-path proof uses executable assertions and bounded text only.
test.use({ trace: "off", screenshot: "off", video: "off" });

export const uatLevel = { level: "solo-admin", without: [] } as const;

// Real browser + API only. Never run against a personal database; deletes only this test's draft.
// This spec is not evidence until executed through the isolated UAT provisioner.
test("Meetings draft setup, notes, history, defaults and deletion use the real backend (#2981)", async ({
  page
}) => {
  test.setTimeout(120_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  console.log("MEETINGS_UAT signed in", {
    path: new URL(page.url()).pathname,
    navigation: await page.locator(".module-link").allTextContents()
  });
  const originalResponse = await page.request.get("/api/meetings/preferences");
  expect(originalResponse.status()).toBe(200);
  const original = (await originalResponse.json()) as MeetingCapturePreferences;
  let fixtureId: string | null = null;
  const title = `UAT meeting draft ${randomUUID()}`;
  const notesText = "Unsent notes retained through navigation.\nSecond line.\nThird line.";
  try {
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Set up your meeting" })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Start meeting", exact: true })).toBeDisabled();
    await expect(
      page.getByText("Recording isn’t available in this version of Moss.", { exact: false })
    ).toBeVisible();
    await page.getByRole("radio", { name: /^Microphone and selected app/ }).click();
    const defaultControl = page.getByRole("checkbox", {
      name: "Use this capture mode as my default"
    });
    await expect(defaultControl).toBeEnabled();
    // The shared switch's input is deliberately zero-sized; click its visible label/track.
    // This uses the real control without forcing a hidden element or changing DOM state.
    const defaultLabel = page.locator("label.jds-switch").filter({ has: defaultControl });
    if (await defaultControl.isChecked()) {
      const [clearResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/meetings/preferences") &&
            response.request().method() === "PUT"
        ),
        defaultLabel.click()
      ]);
      expect(clearResponse.status()).toBe(200);
      await expect(defaultControl).not.toBeChecked();
      await expect(defaultControl).toBeEnabled();
    }
    const [defaultResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/meetings/preferences") &&
          response.request().method() === "PUT"
      ),
      defaultLabel.click()
    ]);
    expect(defaultResponse.status()).toBe(200);
    await expect(defaultControl).toBeChecked();
    expect(await (await page.request.get("/api/meetings/preferences")).json()).toEqual({
      defaultCaptureMode: "selected-app"
    });

    await page.getByLabel("Meeting title", { exact: true }).fill(title);
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meetings/records") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    const created = await createResponse;
    expect(created.status()).toBe(201);
    const { meeting } = (await created.json()) as { meeting: MeetingRecord };
    fixtureId = meeting.id;
    await expect(page).toHaveURL(new RegExp(`id=${fixtureId}`));
    await expect(page.getByRole("main")).toHaveCount(1);
    await assertMeetingReviewLayout(page);
    await expect(page.getByRole("button", { name: "Ask Moss", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: /^My notes/ }).click();
    const notes = page.getByLabel("Personal notes", { exact: true });
    await notes.fill(notesText);
    await expect(page.getByRole("tab", { name: "My notes", exact: true })).toHaveText("My notes");
    await page.locator(".jds-usermenu__trigger").click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Sign out with unsaved changes?" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(notes).toHaveValue(notesText);
    await page.getByRole("button", { name: "View meeting history", exact: true }).click();
    await page.goBack();
    await page.getByRole("tab", { name: /^My notes/ }).click();
    await expect(notes).toHaveValue(notesText);
    await page.goForward();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Open review", exact: true }).click();
    await page.getByRole("tab", { name: /^My notes/ }).click();
    await expect(notes).toHaveValue(notesText);
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: /^My notes/ }).click();
    await expect(notes).toHaveValue(notesText);
    await expect(page.getByRole("tab", { name: "My notes", exact: true })).toHaveText("My notes");
    const persisted = await page.request.get(`/api/meetings/records/${fixtureId}`);
    expect((await persisted.json()).meeting.personalNotes).toBe(notesText);

    // The solo-admin fixture has no configured default model. Check the real server's
    // availability result and the real button after choosing an otherwise valid template.
    const outputsResponse = await page.request.get(`/api/meetings/records/${fixtureId}/outputs`);
    expect(outputsResponse.status()).toBe(200);
    const outputs = (await outputsResponse.json()) as {
      generationAvailability: string;
      templates: { id: string }[];
    };
    expect(outputs.generationAvailability).toBe("model-unavailable");
    expect(outputs.templates.length).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Summary and actions", exact: true }).click();
    await page
      .getByLabel("Summary template", { exact: true })
      .selectOption(outputs.templates[0]!.id);
    await expect(
      page.getByRole("button", { name: "Generate summary", exact: true })
    ).toBeDisabled();
    await expect(
      page.getByText(
        "Your default model is unavailable or cannot produce structured summaries. Check its connection and try again. No other model will be used.",
        { exact: true }
      )
    ).toBeVisible();
    await page.getByRole("tab", { name: "My notes", exact: true }).click();

    await notes.fill("Keep these edits when canceling.");
    await page.getByRole("button", { name: "Delete draft", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("permanently deleted");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(notes).toHaveValue("Keep these edits when canceling.");
    expect((await page.request.get(`/api/meetings/records/${fixtureId}`)).status()).toBe(200);
    await page.getByRole("button", { name: "Delete draft", exact: true }).click();
    const deletion = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}`) &&
        response.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Permanently delete draft", exact: true }).click();
    expect((await deletion).status()).toBe(204);
    await expect(page.getByRole("heading", { name: "Meeting history", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("view") === "history" &&
        !url.searchParams.has("id") &&
        !url.searchParams.has("selected") &&
        !url.searchParams.has("panel")
    );
    await expect(
      page.getByRole("button", { name: "Retry selected meeting", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByText("This meeting is unavailable. Choose another meeting.", { exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/meetings/records/${fixtureId}`)).status()).toBe(404);
    fixtureId = null;
    console.log(
      "MEETINGS_DRAFT_REVIEW_UAT tab panels below tab list at full content width; one main landmark; multiline notes without record count; no-model summary disabled; successful delete clears selected URL and unavailable retry."
    );
  } finally {
    if (fixtureId)
      expect
        .soft((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status())
        .toBe(204);
    expect((await page.request.put("/api/meetings/preferences", { data: original })).status()).toBe(
      200
    );
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
    await page.getByRole("button", { name: "View meeting history", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Open review", exact: true }).click();
    await page.getByRole("tab", { name: /^My notes/ }).click();
    await page
      .getByLabel("Personal notes", { exact: true })
      .fill("Discard only after confirmation.");
    await page.locator(".jds-usermenu__trigger").click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Sign out with unsaved changes?" });
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
    expect((await saved.json()).meeting.personalNotes).toBe("");
    console.log(
      "MEETINGS_SIGNOUT_UAT real dirty notes → shared confirmation → signed out; zero native dialogs; discarded notes not saved"
    );
  } finally {
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
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await page.getByRole("button", { name: "View meeting history", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Open review", exact: true }).click();
    await page.getByRole("tab", { name: /^Transcript/ }).click();
    const transcript = page.getByRole("region", { name: "Retained transcript", exact: true });
    await expect(transcript).toContainText("Synthetic desk microphone");
    await expect(transcript).toContainText("Synthetic corrected wording.");
    await expect(transcript).toContainText("0:01–0:04");
    await expect(transcript).toContainText("Source labels only");
    await expect(page.getByLabel("Personal notes", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Previous revision", exact: true }).click();
    await expect(transcript).toContainText("Synthetic draft wording.");
    await expect(transcript).toContainText("Provisional");
    await assertProvisionalContrast(page);
    await expect(transcript).not.toContainText("Synthetic corrected wording.");
    await page.getByRole("button", { name: "Latest revision", exact: true }).click();
    await expect(transcript).toContainText("Synthetic corrected wording.");
    await page.reload();
    await page.getByRole("tab", { name: /^Transcript/ }).click();
    await expect(transcript).toContainText("Synthetic corrected wording.");
    const url = new URL(page.url());
    url.searchParams.set("segmentId", original.segmentId);
    url.searchParams.set("segmentRevision", "1");
    url.searchParams.set("startCharacter", "0");
    url.searchParams.set("endCharacter", String(original.text.length));
    await page.goto(url.toString());
    await page.getByRole("tab", { name: /^Transcript/ }).click();
    const evidence = page.getByRole("region", { name: "Transcript evidence", exact: true });
    await expect(evidence).toContainText(original.text);
    await evidence.getByText("Source details", { exact: true }).click();
    await expect(evidence).toContainText("Transcript revision 1");
    await expect(transcript).toContainText("Synthetic corrected wording.");
    await page.getByRole("button", { name: "Close evidence", exact: true }).click();
    await expect(evidence).toHaveCount(0);
  } finally {
    if (fixtureId)
      expect
        .soft((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status())
        .toBe(204);
  }
});
