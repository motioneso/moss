import { meetingRow, openMeetingChat } from "./meeting-minimal-ui.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import {
  meetingChatSurface,
  type GetChatModelOverrideSettingsResponse,
  type GetChatPrivacyStateResponse,
  type ListChatThreadMessagesResponse,
  type ListChatThreadsResponse,
  type MeetingChatTurnResponse
} from "@moss/shared";
import {
  MEETING_FIXTURE_LATE_REPLY,
  MEETING_FIXTURE_MODEL,
  MEETING_FIXTURE_OLD,
  MEETING_FIXTURE_PORT,
  MEETING_FIXTURE_QUESTION,
  MEETING_FIXTURE_REPLY,
  type MeetingFixtureObservation
} from "../fixtures/meeting-chat-fixture-server.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { openChatDrawer } from "../visual-parity/shell-navigation.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

// Repository live-path proof uses executable assertions and bounded text only.
test.use({ trace: "off", screenshot: "off", video: "off" });

export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);

const REPLIES = ".chatd-msg:not(.chatd-msg--me) .chatd-bubble";
const QUESTIONS = ".chatd-msg--me";
const P1_QUESTION = "What are my goals?";

/** Runs one request against the stand-in from inside its own container. */
async function fixture(name: string, method: "GET" | "POST", path: string): Promise<string> {
  const { stdout } = await exec("docker", [
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `const r=await fetch('http://127.0.0.1:${MEETING_FIXTURE_PORT}${path}',{method:'${method}'}); if(!r.ok)process.exit(1); console.log(await r.text());`
  ]);
  return stdout;
}

async function fixtureEvidence(name: string): Promise<readonly MeetingFixtureObservation[]> {
  return (
    JSON.parse(await fixture(name, "GET", "/evidence")) as {
      observations: MeetingFixtureObservation[];
    }
  ).observations;
}

async function holdNextTurn(name: string, send: () => Promise<void>): Promise<void> {
  await fixture(name, "POST", "/control/hold");
  await send();
  await expect
    .poll(
      async () =>
        (JSON.parse(await fixture(name, "GET", "/control/held")) as { held: boolean }).held
    )
    .toBe(true);
}

function isTurn(response: Response): boolean {
  return response.url().endsWith("/api/chat/turn") && response.request().method() === "POST";
}

function isClear(response: Response): boolean {
  return (
    new URL(response.url()).pathname.endsWith("/api/chat/clear") &&
    response.request().method() === "POST"
  );
}

async function askMeeting(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(MEETING_FIXTURE_QUESTION);
  await composer.press("Enter");
}

async function newSideChat(drawer: Locator): Promise<void> {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat", exact: true }).click();
}

/** Maps each persisted message id on a surface to the conversation that holds it. */
async function persistedMessages(page: Page, surface: string) {
  const query = `surface=${encodeURIComponent(surface)}`;
  const threads = await page.request.get(`/api/chat/threads?${query}`);
  expect(threads.status()).toBe(200);
  const byId = new Map<string, { threadId: string; role: string; body: string }>();
  for (const thread of ((await threads.json()) as ListChatThreadsResponse).threads) {
    const messages = await page.request.get(`/api/chat/threads/${thread.id}/messages?${query}`);
    expect(messages.status()).toBe(200);
    for (const message of ((await messages.json()) as ListChatThreadMessagesResponse).messages)
      byId.set(message.id, { threadId: thread.id, role: message.role, body: message.body });
  }
  return byId;
}

async function drawerThreadId(page: Page): Promise<string | undefined> {
  const response = await page.request.get("/api/chat/privacy?surface=drawer");
  expect(response.status()).toBe(200);
  return ((await response.json()) as GetChatPrivacyStateResponse).threadId;
}

// Evidence scope: real owner login → Meetings UI → docked chat → Conversations → New side chat →
// real chat API/services → HTTP request to a disclosed local third-party stand-in that holds one
// turn and answers it late. The browser delays one clear request with route.continue() so a real
// late success can land before the server cancels the turn; no Moss response is intercepted,
// replayed or edited. This does not prove hosted-model quality or a real provider credential.
test("Meeting New side chat ignores a real late success or failure, the P1 helper gets a fresh reply, and Conversations stays inside the panel (#3274, #3282)", async ({
  page
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  const fixtureName = `${project}-meeting-new-side-chat-fixture`;
  const meetingIds: string[] = [];
  let providerId: string | undefined;
  let modelId: string | undefined;
  await signInUatAdmin(page);
  const settingsResponse = await page.request.get("/api/ai/chat-model-override");
  expect(settingsResponse.status()).toBe(200);
  const { settings } = (await settingsResponse.json()) as GetChatModelOverrideSettingsResponse;
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  try {
    await exec("docker", [
      "run",
      "--detach",
      "--name",
      fixtureName,
      "--network",
      `${project}_jarv1s`,
      `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
      "node_modules/.bin/tsx",
      "tests/uat/fixtures/meeting-chat-fixture-cli.ts"
    ]);
    await expect
      .poll(async () => (await exec("docker", ["logs", fixtureName])).stdout, { timeout: 30_000 })
      .toContain("[meeting-chat-fixture] ready");
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Synthetic meeting UAT HTTP provider",
        baseUrl: `http://${fixtureName}:${MEETING_FIXTURE_PORT}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
      }
    });
    expect(provider.status()).toBe(201);
    providerId = (await provider.json()).provider.id as string;
    const model = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: MEETING_FIXTURE_MODEL,
        displayName: "Synthetic meeting UAT model",
        capabilities: ["chat"],
        status: "active",
        tier: "economy",
        allowUserOverride: true
      }
    });
    expect(model.status()).toBe(201);
    modelId = (await model.json()).model.id as string;
    expect(
      (
        await page.request.put("/api/admin/ai/chat-model-override", { data: { enabled: true } })
      ).status()
    ).toBe(200);
    expect(
      (await page.request.put("/api/ai/chat-model-override", { data: { modelId } })).status()
    ).toBe(200);
    expect((await page.request.put(pinPath, { data: { modelId } })).status()).toBe(200);

    const title = `Synthetic meeting side chat ${randomUUID()}`;
    const created = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title }
    });
    expect(created.status()).toBe(201);
    const meetingId = (await created.json()).meeting.id as string;
    meetingIds.push(meetingId);
    const source = {
      sourceId: "synthetic-microphone",
      epoch: 1,
      kind: "microphone",
      label: "Synthetic desk microphone",
      startMs: 0,
      endMs: 10000
    };
    const posted = await page.request.post(`/api/meetings/records/${meetingId}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [source],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId,
              segmentId: randomUUID(),
              sourceId: source.sourceId,
              epoch: 1,
              startMs: 1000,
              endMs: 4000,
              revision: 1,
              text: MEETING_FIXTURE_OLD,
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: null
      }
    });
    expect(posted.status()).toBe(201);
    const surface = meetingChatSurface(meetingId);

    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    await openMeetingChat(page);
    const drawer = page.locator(".chatd--docked");
    await expect(drawer).toBeVisible();

    await test.step("Conversations covers the docked chat panel only (#3282)", async () => {
      await drawer.getByRole("button", { name: "Open conversations" }).click();
      const overlay = drawer.locator(".chatd-conversations__overlay");
      await expect(overlay).toBeVisible();
      const panel = (await drawer.boundingBox())!;
      const box = (await overlay.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(box.y).toBeGreaterThanOrEqual(panel.y - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      await expect(drawer.getByRole("button", { name: "Open conversations" })).toBeFocused();
    });

    await test.step("A late success from the old meeting turn never reaches the new side chat", async () => {
      const lateTurn = page.waitForResponse(isTurn, { timeout: 60_000 });
      await holdNextTurn(fixtureName, () => askMeeting(page));
      await expect(drawer.locator(QUESTIONS)).toHaveCount(1);

      // Delay the clear request in the browser so the provider can answer before the server
      // cancels the turn. The request itself passes through unchanged.
      let releaseClear!: () => void;
      const clearHeld = new Promise<void>((resolve) => {
        releaseClear = resolve;
      });
      let clearSeen = false;
      await page.route(
        (url) => url.pathname.endsWith("/api/chat/clear"),
        async (route) => {
          clearSeen = true;
          await clearHeld;
          await route.continue();
        }
      );
      try {
        const clear = page.waitForResponse(isClear);
        await newSideChat(drawer);
        await expect.poll(() => clearSeen).toBe(true);
        await fixture(fixtureName, "POST", "/control/release?outcome=success");
        const late = await lateTurn;
        expect(late.status()).toBe(200);
        const lateBody = (await late.json()) as MeetingChatTurnResponse;
        expect(lateBody.reply).toBe(MEETING_FIXTURE_LATE_REPLY);
        await page.waitForTimeout(1_000);
        await expect(drawer.getByText(MEETING_FIXTURE_LATE_REPLY)).toHaveCount(0);

        releaseClear();
        expect((await clear).status()).toBe(204);
        await expect(drawer.locator(QUESTIONS)).toHaveCount(0);
        await expect(drawer.locator(REPLIES)).toHaveCount(0);
        await expect(drawer.getByText(MEETING_FIXTURE_LATE_REPLY)).toHaveCount(0);

        const nextTurn = page.waitForResponse(isTurn);
        await askMeeting(page);
        const next = await nextTurn;
        expect(next.status()).toBe(200);
        const nextBody = (await next.json()) as MeetingChatTurnResponse;
        expect(nextBody.meetingContext.meetingId).toBe(meetingId);
        expect(nextBody.reply).toBe(MEETING_FIXTURE_REPLY);
        await expect(drawer.locator(REPLIES)).toHaveCount(1);
        await expect(drawer.locator(REPLIES)).toContainText("The synthetic decision is recorded");
        await expect(drawer.getByText(MEETING_FIXTURE_LATE_REPLY)).toHaveCount(0);

        const persisted = await persistedMessages(page, surface);
        const current = persisted.get(nextBody.userMessageId)?.threadId;
        expect(current).toBeDefined();
        expect(persisted.get(lateBody.userMessageId)?.threadId).not.toBe(current);
        const currentBodies = [...persisted.values()]
          .filter((message) => message.threadId === current)
          .map((message) => message.body);
        expect(currentBodies).toEqual(
          expect.arrayContaining([MEETING_FIXTURE_QUESTION, MEETING_FIXTURE_REPLY])
        );
        expect(currentBodies).toHaveLength(2);
        expect(currentBodies).not.toContain(MEETING_FIXTURE_LATE_REPLY);

        const evidence = await fixtureEvidence(fixtureName);
        expect(evidence).toHaveLength(2);
        for (const observation of evidence)
          expect(observation).toMatchObject({ hasOld: true, hasTools: false, hasUnrelated: false });
      } finally {
        releaseClear();
        await page.unroute((url) => url.pathname.endsWith("/api/chat/clear"));
      }
    });

    await test.step("A late failure from the old meeting turn leaves no error on the new side chat", async () => {
      const lateTurn = page.waitForResponse(isTurn, { timeout: 60_000 });
      await holdNextTurn(fixtureName, () => askMeeting(page));
      await expect(drawer.locator(QUESTIONS)).toHaveCount(2);

      const clear = page.waitForResponse(isClear);
      await newSideChat(drawer);
      expect((await clear).status()).toBe(204);
      await expect(drawer.locator(QUESTIONS)).toHaveCount(0);
      await expect(drawer.locator(REPLIES)).toHaveCount(0);

      await fixture(fixtureName, "POST", "/control/release?outcome=failure");
      expect((await lateTurn).status()).toBeGreaterThanOrEqual(400);
      await page.waitForTimeout(1_000);
      await expect(drawer.locator(QUESTIONS)).toHaveCount(0);
      await expect(drawer.locator(".form-error")).toHaveCount(0);

      const nextTurn = page.waitForResponse(isTurn);
      await askMeeting(page);
      const next = await nextTurn;
      expect(next.status()).toBe(200);
      expect(((await next.json()) as MeetingChatTurnResponse).meetingContext.meetingId).toBe(
        meetingId
      );
      await expect(drawer.locator(QUESTIONS)).toHaveCount(1);
      await expect(drawer.locator(REPLIES)).toHaveCount(1);
      await expect(drawer.locator(".form-error")).toHaveCount(0);
      const evidence = await fixtureEvidence(fixtureName);
      expect(evidence).toHaveLength(4);
      expect(evidence[3]).toMatchObject({ hasOld: true, hasTools: false, hasUnrelated: false });
    });

    await test.step("Reloading the meeting shows only the current side chat", async () => {
      await page.reload();
      await openMeetingChat(page);
      const reloaded = page.locator(".chatd--docked");
      await expect(reloaded.locator(REPLIES)).toHaveCount(1);
      await expect(reloaded.getByText(MEETING_FIXTURE_LATE_REPLY)).toHaveCount(0);
    });

    await test.step("The installed P1 helper opens twice and gets a fresh reply after a clear", async () => {
      // General drawer chat refuses API-key providers, so the helper runs on the signed-in
      // economy model instead of the meeting stand-in.
      expect((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
      await bringUpRealChatModel(page);
      await page.getByRole("link", { name: "Today", exact: true }).click();
      const toggle = page.locator(".topbar-actions").getByRole("button", {
        name: /^(Chat with .+|Open chat)$/
      });
      if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
      await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

      const clears: Response[] = [];
      const onResponse = (response: Response) => {
        if (isClear(response)) clears.push(response);
      };
      page.on("response", onResponse);
      try {
        await openChatDrawer(page);
        const firstThread = await drawerThreadId(page);
        expect(firstThread).toBeDefined();
        const clearsBefore = clears.length;
        await page.getByRole("button", { name: "Close chat" }).click();
        await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

        await openChatDrawer(page);
        expect(clears).toHaveLength(clearsBefore + 1);
        expect(clears.at(-1)!.status()).toBe(204);
        expect(new URL(clears.at(-1)!.url()).searchParams.get("surface")).toBe("drawer");
        await expect(page.locator(REPLIES).filter({ hasText: /\S/ })).toHaveCount(1);
        const secondThread = await drawerThreadId(page);
        expect(secondThread).toBeDefined();
        expect(secondThread).not.toBe(firstThread);

        const kept = await page.request.get(
          `/api/chat/threads/${firstThread}/messages?surface=drawer`
        );
        expect(kept.status()).toBe(200);
        const keptMessages = ((await kept.json()) as ListChatThreadMessagesResponse).messages;
        expect(keptMessages.filter((message) => message.role === "user").at(-1)?.body).toBe(
          P1_QUESTION
        );
        expect(
          keptMessages.some((message) => message.role === "assistant" && message.body.trim())
        ).toBe(true);
      } finally {
        page.off("response", onResponse);
      }
    });
    console.log(
      "MEETING_NEW_SIDE_CHAT_UAT real UI/API; disclosed local HTTP provider held two meeting turns; late success answered after New side chat and before the delayed clear reached the server, never shown or persisted in the current side chat; late failure after the clear left no error; next questions kept the selected meeting; reload showed only the current side chat; P1 helper cleared through Conversations and got a fresh reply in a new conversation; Conversations stayed inside the docked panel at 1440 wide"
    );
  } finally {
    try {
      expect((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
      for (const id of meetingIds)
        expect((await page.request.delete(`/api/meetings/records/${id}`)).status()).toBe(204);
      expect(
        (
          await page.request.put("/api/ai/chat-model-override", {
            data: { modelId: settings.currentOverrideModelId }
          })
        ).status()
      ).toBe(200);
      expect(
        (
          await page.request.put("/api/admin/ai/chat-model-override", {
            data: { enabled: settings.overrideEnabled }
          })
        ).status()
      ).toBe(200);
      if (modelId)
        expect((await page.request.delete(`/api/ai/models/${modelId}`)).status()).toBe(200);
      if (providerId)
        expect((await page.request.post(`/api/ai/providers/${providerId}/revoke`)).status()).toBe(
          200
        );
    } finally {
      await exec("docker", ["rm", "--force", fixtureName]);
    }
  }
});
