import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MeetingCapturePreferences, MeetingRecord } from "@moss/shared";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

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
  try {
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Set up your meeting" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start meeting", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Microphone", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Microphone and selected app", exact: true }).click();
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
    await expect(page.getByRole("button", { name: "Ask Moss", exact: true })).toBeDisabled();
    const notes = page.getByLabel("Personal notes", { exact: true });
    await notes.fill("Unsent notes retained through navigation.");
    await page.getByRole("button", { name: "View meeting history", exact: true }).click();
    await page.goBack();
    await expect(notes).toHaveValue("Unsent notes retained through navigation.");
    await page.goForward();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(notes).toHaveValue("Unsent notes retained through navigation.");
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${fixtureId}/notes`) &&
        response.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await page.reload();
    await expect(notes).toHaveValue("Unsent notes retained through navigation.");
    const persisted = await page.request.get(`/api/meetings/records/${fixtureId}`);
    expect((await persisted.json()).meeting.personalNotes).toBe(
      "Unsent notes retained through navigation."
    );

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
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/meetings/records/${fixtureId}`)).status()).toBe(404);
    fixtureId = null;
  } finally {
    if (fixtureId)
      expect((await page.request.delete(`/api/meetings/records/${fixtureId}`)).status()).toBe(204);
    expect((await page.request.put("/api/meetings/preferences", { data: original })).status()).toBe(
      200
    );
  }
});
