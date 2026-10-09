import { meetingRow, openMeetingChat } from "./meeting-minimal-ui.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import {
  meetingChatSurface,
  type GetChatModelOverrideSettingsResponse,
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
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

// Repository live-path proof uses executable assertions and bounded text only.
test.use({ trace: "off", screenshot: "off", video: "off" });

export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);

const REPLIES = ".chatd-msg:not(.chatd-msg--me) .chatd-bubble";
const QUESTIONS = ".chatd-msg--me";

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

const clearMatcher = (url: URL): boolean => url.pathname.endsWith("/api/chat/clear");

/**
 * Holds every clear request in the browser until released, then passes it through unchanged,
 * so a held provider turn can finish before the server cancels it.
 */
async function delayClears(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers: Promise<void>[] = [];
  await page.route(clearMatcher, async (route) => {
    const handled = released.then(() => route.continue());
    handlers.push(handled);
    await handled;
  });
  return {
    seen: () => handlers.length > 0,
    release,

    /** Lets held clears through before removing the route, so no handler outlives it. */
    async restore() {
      release();
      await Promise.allSettled(handlers);
      await page.unroute(clearMatcher);
    }
  };
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

// Evidence scope: real owner login → Meetings UI → docked chat → Conversations → New side chat →
// real chat API/services → HTTP request to a disclosed local third-party stand-in that holds one
// turn and answers it late. The browser delays one clear request with route.continue() so a real
// late success can land before the server cancels the turn; no Moss response is intercepted,
// replayed or edited. This does not prove hosted-model quality or a real provider credential.
test("Meeting New side chat ignores a real late success or failure, and Conversations stays inside the panel (#3274, #3282)", async ({
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
  let bodyError: unknown;
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

      const clears = await delayClears(page);
      try {
        const clear = page.waitForResponse(isClear);
        await newSideChat(drawer);
        await expect.poll(clears.seen).toBe(true);
        await fixture(fixtureName, "POST", "/control/release?outcome=success");
        const late = await lateTurn;
        expect(late.status()).toBe(200);
        const lateBody = (await late.json()) as MeetingChatTurnResponse;
        expect(lateBody.reply).toBe(MEETING_FIXTURE_LATE_REPLY);
        await page.waitForTimeout(2_000);
        await expect(drawer.getByText(MEETING_FIXTURE_LATE_REPLY)).toHaveCount(0);

        clears.release();
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
        await clears.restore();
      }
    });

    await test.step("A late failure from the old meeting turn leaves no error on the new side chat", async () => {
      const lateTurn = page.waitForResponse(isTurn, { timeout: 60_000 });
      await holdNextTurn(fixtureName, () => askMeeting(page));
      await expect(drawer.locator(QUESTIONS)).toHaveCount(2);

      // The provider fails the held turn before the clear reaches the server, so the browser
      // receives the provider's own failure, not the server's cancellation.
      const clears = await delayClears(page);
      try {
        const clear = page.waitForResponse(isClear);
        await newSideChat(drawer);
        await expect.poll(clears.seen).toBe(true);
        await fixture(fixtureName, "POST", "/control/release?outcome=failure");
        const late = await lateTurn;
        expect(late.status()).toBe(503);
        expect(await late.json()).toMatchObject({ code: "meeting_chat_failed" });
        await page.waitForTimeout(2_000);
        await expect(drawer.locator(".form-error")).toHaveCount(0);

        clears.release();
        expect((await clear).status()).toBe(204);
        await expect(drawer.locator(QUESTIONS)).toHaveCount(0);
        await expect(drawer.locator(REPLIES)).toHaveCount(0);
        await expect(drawer.locator(".form-error")).toHaveCount(0);
      } finally {
        await clears.restore();
      }

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

    console.log(
      "MEETING_NEW_SIDE_CHAT_UAT real UI/API; disclosed local HTTP provider held two meeting turns; late success answered after New side chat and before the delayed clear reached the server, never shown or persisted in the current side chat; late failure answered by the provider before the delayed clear reached the server left no error; next questions kept the selected meeting; reload showed only the current side chat; Conversations stayed inside the docked panel at 1440 wide"
    );
  } catch (error) {
    bodyError = error;
  }
  {
    // Every restore runs even when an earlier one fails. A test failure outranks cleanup failures.
    const failures: unknown[] = [];
    const restore = async (status: () => Promise<number>, expected: number) => {
      try {
        expect(await status()).toBe(expected);
      } catch (error) {
        failures.push(error);
      }
    };
    await restore(
      async () => (await page.request.put(pinPath, { data: { modelId: null } })).status(),
      200
    );
    for (const id of meetingIds)
      await restore(
        async () => (await page.request.delete(`/api/meetings/records/${id}`)).status(),
        204
      );
    await restore(
      async () =>
        (
          await page.request.put("/api/ai/chat-model-override", {
            data: { modelId: settings.currentOverrideModelId }
          })
        ).status(),
      200
    );
    await restore(
      async () =>
        (
          await page.request.put("/api/admin/ai/chat-model-override", {
            data: { enabled: settings.overrideEnabled }
          })
        ).status(),
      200
    );
    if (modelId)
      await restore(
        async () => (await page.request.delete(`/api/ai/models/${modelId}`)).status(),
        200
      );
    if (providerId)
      await restore(
        async () => (await page.request.post(`/api/ai/providers/${providerId}/revoke`)).status(),
        200
      );
    await exec("docker", ["rm", "--force", fixtureName]).catch((error: unknown) => {
      failures.push(error);
    });
    if (bodyError !== undefined) throw bodyError;
    if (failures.length > 0) throw new AggregateError(failures, "Meeting UAT cleanup failed");
  }
});
