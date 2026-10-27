import { expect, test, type Page } from "@playwright/test";
import type { MeetingOutputArtifact } from "@moss/shared";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

async function add(page: Page, explicit: boolean) {
  await page.getByRole("button", { name: "Add recording", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add recording", exact: true })).toBeVisible();
  const entry = page.getByRole("region", { name: "Add recording", exact: true });
  if (explicit) {
    await entry.getByLabel("Title (optional)", { exact: true }).fill("My chosen wind notes");
    await entry.getByLabel("Type (optional)", { exact: true }).selectOption("idea");
  }
  await entry
    .getByLabel("Transcript", { exact: true })
    .fill(
      "I am thinking aloud on my walk about my personal hobby game, Fernworld. This is a brain dump, not a work discussion. The grass should move in waves even when the player stands still. Wind direction could change the grass animation. Maybe birds can react to the same wind. I wonder how to keep it subtle. These are loose ideas for my free-time project, with no decisions or assigned actions."
    );
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/meetings/manual-transcripts") &&
      response.request().method() === "POST"
  );
  await entry.getByRole("button", { name: "Add recording", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { meetingId } = (await response.json()) as { meetingId: string };
  await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));
  await expect
    .poll(
      async () => {
        const result = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
        expect(result.status()).toBe(200);
        const data = await result.json();
        if (data.automaticSummary?.status === "failed")
          throw new Error(`Automatic analysis failed: ${data.automaticSummary.code}`);
        return data.headVersion;
      },
      { timeout: 150000, intervals: [2000, 3000] }
    )
    .toBe(1);
  const result = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
  const artifact = (await result.json()).artifacts[0] as MeetingOutputArtifact;
  expect(artifact.content.recording?.side).toBe("personal");
  expect(artifact.content.recording?.title.length).toBeGreaterThan(3);
  expect(artifact.content.recording?.ideaGroups.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", {
      name: `Recording type: ${explicit ? "Idea" : "Brain dump"}`,
      exact: true
    })
  ).toBeVisible();
  await expect(page.getByText("Personal", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Summary", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Summary and actions", exact: true })
  ).toContainText(artifact.content.overview);
  await expect(page.getByRole("heading", { name: "Ideas", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Recording type: ${explicit ? "Idea" : "Brain dump"}`,
      exact: true
    })
  ).toBeVisible();
  await expect(page.getByText("Personal", { exact: true })).toBeVisible();
  const record = await page.request.get(`/api/meetings/records/${meetingId}`);
  const title = (await record.json()).meeting.title as string;
  expect(title).toBe(explicit ? "My chosen wind notes" : artifact.content.recording?.title);
  return { meetingId, artifact, title };
}
test("paste a recording, classify with the real default model, change type, filter and reload (#3777)", async ({
  page
}) => {
  test.setTimeout(600000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingCodex(requireUatProjectName());
  await page.getByRole("link", { name: "Meetings", exact: true }).click();
  const first = await add(page, false);
  expect(JSON.parse(first.artifact.modelRoute)).toMatchObject({
    modelId: model.id,
    providerKind: "openai-compatible"
  });
  const picker = page.getByRole("button", { name: "Recording type: Brain dump", exact: true });
  await expect(picker).toHaveClass(/jds-btn--chip/);
  expect(await picker.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(
    200
  );
  await picker.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Brain dump", exact: true })
  ).toBeVisible();
  await page.getByRole("menuitemcheckbox", { name: "Conversation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recording type: Conversation", exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recording type: Conversation", exact: true })
  ).toBeVisible();
  await page.getByRole("tab", { name: "Summary", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Topics", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search meetings", exact: true }).fill("Fernworld");
  await page.getByLabel("Recording type", { exact: true }).selectOption("conversation");
  await expect(page.getByRole("button").filter({ hasText: first.title })).toHaveCount(1);
  await page.getByLabel("Recording type", { exact: true }).selectOption("brain-dump");
  await expect(page.getByText("No meetings match this search.", { exact: true })).toBeVisible();
  await page.getByLabel("Recording type", { exact: true }).selectOption("");
  await expect(page.getByRole("searchbox", { name: "Search meetings", exact: true })).toHaveValue(
    "Fernworld"
  );
  await expect(page.getByRole("button").filter({ hasText: first.title })).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search meetings", exact: true }).fill("");
  const second = await add(page, true);
  expect(JSON.parse(second.artifact.modelRoute).modelId).toBe(model.id);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("button", { name: "Recording type: Idea", exact: true })
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  }
  for (const theme of [
    { mode: "dark", park: "forest" },
    { mode: "light", park: "sage" }
  ]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value.mode;
      document.documentElement.dataset.theme = value.park;
    }, theme);
    await expect(
      page.getByRole("button", { name: "Recording type: Idea", exact: true })
    ).toBeVisible();
  }
  console.log(
    `RECORDING_IDENTITY_REAL_UAT model=${model.id} providerModel=${model.providerModelId} manualEntry=true classification=true title=true ownerChoicesPreserved=true menuKeyboard=true combinedFilter=true reload=true widths=390,1280 screenshots=off`
  );
});
