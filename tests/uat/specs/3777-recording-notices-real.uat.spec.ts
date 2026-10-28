import { expect, test } from "@playwright/test";
import type { ChatMessageDto, ChatThreadDto, MeetingOutputArtifact } from "@moss/shared";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

test("an uncertain real classification reaches Main once and survives reload (#3777)", async ({
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
  const before = await page.request.get("/api/chat/threads?surface=drawer");
  expect(before.status()).toBe(200);
  expect((await before.json()).threads.some((thread: ChatThreadDto) => thread.isMain)).toBe(false);
  await page.getByRole("button", { name: "Add recording", exact: true }).click();
  const entry = page.getByRole("region", { name: "Add recording", exact: true });
  await entry
    .getByLabel("Transcript", { exact: true })
    .fill(
      "Planning note for Fernworld: prototype one wind system shared by grass and birds. " +
        "I am unsure whether this belongs to my personal game or the project at work; " +
        "we discussed both and this short recording does not say which. " +
        "The idea may be useful to either project. No decision about that was made."
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
  await expect
    .poll(
      async () => {
        const outputs = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
        expect(outputs.status()).toBe(200);
        const data = await outputs.json();
        if (data.automaticSummary?.status === "failed")
          throw new Error(`Analysis failed: ${data.automaticSummary.code}`);
        return data.headVersion;
      },
      { timeout: 150000 }
    )
    .toBe(1);
  const data = await (await page.request.get(`/api/meetings/records/${meetingId}/outputs`)).json();
  const artifact = data.artifacts[0] as MeetingOutputArtifact;
  expect(JSON.parse(artifact.modelRoute).modelId).toBe(model.id);
  expect(
    artifact.content.recording?.confidence,
    "The real model must express uncertainty for this transcript"
  ).toBeLessThan(0.8);
  // Create Main through the ordinary UI only after the uncertain summary has finished.
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  const firstTurn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chat/turn" &&
      response.request().method() === "POST",
    { timeout: 150000 }
  );
  await drawer.getByRole("textbox", { name: /^Message/ }).fill("Hello. Reply with Ready.");
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  expect((await firstTurn).status()).toBe(200);
  let main: ChatThreadDto | undefined;
  await expect
    .poll(async () => {
      const threadsResponse = await page.request.get("/api/chat/threads?surface=drawer");
      expect(threadsResponse.status()).toBe(200);
      const { threads } = (await threadsResponse.json()) as { threads: ChatThreadDto[] };
      main = threads.find((thread) => thread.isMain);
      return main?.id;
    })
    .toBeTruthy();
  const notices = async () => {
    const result = await page.request.get(`/api/chat/threads/${main!.id}/messages?surface=drawer`);
    expect(result.status()).toBe(200);
    const { messages } = (await result.json()) as { messages: ChatMessageDto[] };
    return messages.filter(
      (message) => message.origin?.kind === "module_notice" && message.origin.sourceId === meetingId
    );
  };
  await expect.poll(async () => (await notices()).length, { timeout: 60000 }).toBe(1);
  const [notice] = await notices();
  expect(notice!.role).toBe("assistant");
  expect(notice!.status).toBe("stored");
  expect(notice!.body).toContain(`as ${artifact.content.recording!.side}.`);
  expect(notice!.body).toContain(`/meetings?id=${meetingId}`);
  await expect(drawer).toContainText(`as ${artifact.content.recording!.side}.`);
  await expect(drawer.getByRole("link", { name: "recording", exact: true })).toHaveCount(1);
  await page.reload();
  const opener = page.getByRole("button", { name: /^(Chat with |Open chat$)/ });
  await expect(opener.or(drawer).first()).toBeVisible();
  if (!(await drawer.isVisible())) await opener.click();
  await expect(drawer).toContainText(`as ${artifact.content.recording!.side}.`);
  await expect(drawer.getByRole("link", { name: "recording", exact: true })).toHaveCount(1);
  expect((await notices()).map((message) => message.id)).toEqual([notice!.id]);
  await drawer.getByRole("link", { name: "recording", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/meetings" && url.searchParams.get("id") === meetingId
  );
  console.log(
    `RECORDING_NOTICE_REAL_UAT model=${model.id} confidence=${artifact.content.recording!.confidence} realSummary=true durableMain=true reloadOnce=true recordingLink=true captures=off`
  );
});
