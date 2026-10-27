import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  MeetingOutputArtifact,
  RecordingTypeConfiguration,
  SendChatTurnResponse
} from "@moss/shared";
import { execUatSql } from "./job-search-board-sql.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const deadline = 180000;
async function configuration(page: Page): Promise<RecordingTypeConfiguration> {
  const response = await page.request.get("/api/meetings/recording-types");
  expect(response.status()).toBe(200);
  return response.json();
}
async function openChat(page: Page) {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  return drawer;
}
async function edit(page: Page, drawer: Locator, text: string, disclosures: readonly string[]) {
  const before = await configuration(page);
  const result = page
    .waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/chat/turn" &&
        candidate.request().method() === "POST" &&
        candidate.request().postDataJSON()?.text === text,
      { timeout: deadline }
    )
    .then(async (response) => {
      expect(response.status()).toBe(200);
      return (await response.json()) as SendChatTurnResponse;
    });
  void result.catch(() => undefined);
  await drawer.getByRole("textbox", { name: /^Message/ }).fill(text);
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  const card = drawer
    .getByRole("region", { name: "Action request", exact: true })
    .filter({ has: drawer.page().getByRole("button", { name: "Approve", exact: true }) });
  await expect(card).toHaveCount(1, { timeout: deadline });
  for (const disclosure of disclosures) await expect(card).toContainText(disclosure);
  expect(await configuration(page)).toEqual(before);
  // The request card owns execution; app.callAction dispatches in-process, not as a browser PUT.
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const turn = await result;
  expect(turn.assistantMessageId).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(async () => (await configuration(page)).revision).toBe(before.revision + 1);
  await expect(card).toHaveCount(0);
  const proof = JSON.parse(
    execUatSql(
      requireUatProjectName(),
      `SELECT json_build_object('executed',model_metadata->'executed','threadId',thread_id) FROM app.chat_messages WHERE id='${turn.assistantMessageId}'::uuid AND owner_user_id='${UAT_ADMIN_ID}'::uuid`
    ).trim()
  ) as { executed: { provider: string; model: string }; threadId: string };
  expect(proof.executed?.provider).toBeTruthy();
  expect(proof.executed?.model).toBeTruthy();
  const messages = await (
    await page.request.get(`/api/chat/threads/${proof.threadId}/messages?surface=drawer`)
  ).json();
  const message = messages.messages.find(
    (message: { id: string }) => message.id === turn.assistantMessageId
  );
  expect(message.origin).toBeUndefined();
  expect(
    message.activity.some(
      (activity: { toolName?: string; outcome?: string }) =>
        activity.toolName === "app.callAction" && activity.outcome === "executed"
    )
  ).toBe(true);
  return configuration(page);
}
async function add(page: Page, selected: boolean) {
  await page.getByRole("button", { name: "Add recording", exact: true }).click();
  const entry = page.getByRole("region", { name: "Add recording", exact: true });
  if (selected) {
    await entry.getByLabel("Title (optional)", { exact: true }).fill("Chosen field observations");
    await entry.getByLabel("Type (optional)", { exact: true }).selectOption("field-notes");
  }
  await entry
    .getByLabel("Transcript", { exact: true })
    .fill(
      selected
        ? "These are my personal field notes from a walk. The reeds moved gently in the wind. I noticed three birds near the pond. I would like to observe them again; no decisions or commitments were made."
        : "This is a brain dump, thinking aloud on a walk about my personal hobby game Fernworld, not a work meeting. Loose ideas: the grass could move in wind waves. Birds might respond to changing wind. I wonder whether the animation would look too busy. There are no decisions or action assignments, just thoughts for a free-time project."
    );
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/meetings/manual-transcripts") &&
      response.request().method() === "POST"
  );
  await entry.getByRole("button", { name: "Add recording", exact: true }).click();
  const response = await created;
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
          throw new Error(`Analysis failed: ${data.automaticSummary.code}`);
        return data.headVersion;
      },
      { timeout: 150000, intervals: [2000, 3000] }
    )
    .toBe(1);
  const data = await (await page.request.get(`/api/meetings/records/${meetingId}/outputs`)).json();
  const artifact = data.artifacts[0] as MeetingOutputArtifact;
  expect(artifact.stale).toBe(false);
  return { meetingId, artifact };
}
test("edit types through real chat, refresh mounted menus, classify with chosen style and regenerate retired user choice (#3777)", async ({
  page
}) => {
  test.setTimeout(900000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingCodex(requireUatProjectName());
  await page.getByRole("link", { name: "Meetings", exact: true }).click();
  const filter = page.getByLabel("Recording type", { exact: true });
  await expect(filter.locator("option", { hasText: "Brain dump" })).toHaveCount(1);
  let drawer = await openChat(page);
  const updated = await edit(
    page,
    drawer,
    'Please read my recording types and save these changes together: add a type named Field notes with description "Personal observations outdoors" and the general summary style. Rename Brain dump to Thinking aloud, change its description to "Loose thoughts and ideas spoken aloud", and choose the Project review summary style for it. Retire Other. Keep every existing type ID and all other fields unchanged. Use the app’s approval flow to save the changes.',
    [
      "Add Field notes",
      "Personal observations outdoors",
      "Brain dump",
      "Thinking aloud",
      "Loose thoughts and ideas spoken aloud",
      "Project review",
      "Retire Other",
      "Status: Retired"
    ]
  );
  expect(updated.types.find((type) => type.id === "brain-dump")).toMatchObject({
    name: "Thinking aloud",
    description: "Loose thoughts and ideas spoken aloud",
    templateId: "project-review",
    retired: false
  });
  expect(updated.types.find((type) => type.id === "other")?.retired).toBe(true);
  expect(updated.types.find((type) => type.id === "field-notes")).toMatchObject({
    name: "Field notes",
    description: "Personal observations outdoors",
    templateId: "general",
    retired: false
  });
  expect(
    updated.types.filter((type) => !["brain-dump", "other", "field-notes"].includes(type.id))
  ).toHaveLength(4);
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  // Same mounted screen, without navigation/reload: app-action refresh invalidates Meetings.
  await expect(filter.locator("option", { hasText: "Thinking aloud" })).toHaveCount(1);
  await expect(filter.locator('option[value="other"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Add recording", exact: true }).click();
  const select = page.getByLabel("Type (optional)", { exact: true });
  await expect(select.locator('option[value="field-notes"]')).toHaveCount(1);
  await expect(select.locator('option[value="other"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const automatic = await add(page, false);
  expect(automatic.artifact.content.recording?.typeId).toBe("brain-dump");
  expect(automatic.artifact.templateId).toBe("project-review");
  expect(JSON.parse(automatic.artifact.modelRoute).modelId).toBe(model.id);
  await expect(
    page.getByRole("button", { name: "Recording type: Thinking aloud", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  const selected = await add(page, true);
  expect(selected.artifact.templateId).toBe("general");
  drawer = await openChat(page);
  const retired = await edit(
    page,
    drawer,
    "Please read the current recording types. Retire Field notes and change its summary style to One-to-one. Keep its ID, name and description, and all other recording types unchanged. Use the app’s approval flow to save the changes.",
    ["Retire Field notes", "General meeting", "One-to-one", "Status: Active", "Status: Retired"]
  );
  expect(retired.types.find((type) => type.id === "field-notes")).toMatchObject({
    retired: true,
    templateId: "one-to-one"
  });
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recording type: Field notes", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Recording type: Field notes", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Field notes", exact: true })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Meeting actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rewrite summary", exact: true }).click();
  await expect(
    page.getByText("Summary style follows the recording type: Field notes.", { exact: true })
  ).toBeVisible();
  const rewritten = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/meetings/records/${selected.meetingId}/outputs`) &&
      response.request().method() === "POST",
    { timeout: 150000 }
  );
  await page.getByRole("button", { name: "Rewrite summary", exact: true }).click();
  const rewrite = await rewritten;
  expect(rewrite.status()).toBe(200);
  expect(await rewrite.json()).toMatchObject({
    status: "saved",
    artifact: { version: 2, templateId: "one-to-one", stale: false }
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recording type: Field notes", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await filter.selectOption("field-notes");
  await expect(
    page.getByRole("button").filter({ hasText: "Chosen field observations" })
  ).toHaveCount(1);
  console.log(
    `RECORDING_TYPES_REAL_UAT model=${model.id} providerModel=${model.providerModelId} chatApproval=true add=true rename=true description=true style=true retire=true mountedRefresh=true firstClassificationStyle=true retainedUserStyle=true retiredFilter=true reload=true screenshots=off`
  );
});
