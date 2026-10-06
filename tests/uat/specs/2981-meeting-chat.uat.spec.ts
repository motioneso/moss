import { meetingRow, openMeetingChat } from "./meeting-minimal-ui.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  meetingChatSurface,
  type GetChatModelOverrideSettingsResponse,
  type ListAiProviderConfigsResponse,
  type ListAiServiceBindingsResponse,
  type MeetingChatTurnResponse
} from "@moss/shared";
import {
  MEETING_FIXTURE_MODEL,
  MEETING_FIXTURE_QUESTION,
  MEETING_FIXTURE_OLD,
  MEETING_FIXTURE_NEW,
  MEETING_FIXTURE_UNRELATED,
  MEETING_FIXTURE_NOTES,
  MEETING_FIXTURE_PORT,
  type MeetingFixtureObservation
} from "../fixtures/meeting-chat-fixture-server.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

// Repository live-path proof uses executable assertions and bounded text only.
test.use({ trace: "off", screenshot: "off", video: "off" });

export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);

async function fixtureEvidence(name: string): Promise<readonly MeetingFixtureObservation[]> {
  const { stdout } = await exec("docker", [
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `const r=await fetch('http://127.0.0.1:${MEETING_FIXTURE_PORT}/evidence'); if(!r.ok)process.exit(1); console.log(await r.text());`
  ]);
  return (JSON.parse(stdout) as { observations: MeetingFixtureObservation[] }).observations;
}

async function sendQuestion(page: Page): Promise<MeetingChatTurnResponse> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(MEETING_FIXTURE_QUESTION);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/chat/turn") && r.request().method() === "POST"
  );
  await composer.press("Enter");
  const result = await response;
  expect(result.status()).toBe(200);
  return result.json() as Promise<MeetingChatTurnResponse>;
}

// Evidence scope: real owner login → Meetings UI → Ask Moss → real chat API/services → HTTP
// request to a disclosed local third-party stand-in → answer/citation UI. No Moss responses
// are intercepted, replayed or edited. Synthetic retained text enters through its real POST.
// This does not prove hosted-model quality, audio capture, ASR, or a real provider credential.
test("Normal docked chat follows the meeting route, answers notes-only questions and opens exact revision evidence (#2981)", async ({
  page
}) => {
  test.setTimeout(180_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  const fixtureName = `${project}-meeting-chat-fixture`;
  const fallbackProviderModelId = "meeting-uat-admin-default";
  const ids: string[] = [];
  let providerId: string | undefined;
  let modelId: string | undefined;
  let fallbackProviderId: string | undefined;
  let fallbackModelId: string | undefined;
  let defaultProviderChanged = false;
  let chatBindingChanged = false;
  await signInUatAdmin(page);
  const settingsResponse = await page.request.get("/api/ai/chat-model-override");
  expect(settingsResponse.status()).toBe(200);
  const { settings } = (await settingsResponse.json()) as {
    settings: { overrideEnabled: boolean; currentOverrideModelId: string | null };
  };
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  const originalPin = await page.request.get(pinPath);
  expect(originalPin.status()).toBe(200);
  const { pin } = (await originalPin.json()) as {
    pin: { pinnedModelId: string | null; pinnedProviderId: string | null };
  };
  const providersResponse = await page.request.get("/api/ai/providers");
  expect(providersResponse.status()).toBe(200);
  const originalDefault = (
    (await providersResponse.json()) as ListAiProviderConfigsResponse
  ).providers.find((provider) => provider.isInstanceDefault);
  const bindingsResponse = await page.request.get("/api/ai/service-bindings");
  expect(bindingsResponse.status()).toBe(200);
  const originalChatBinding = ((await bindingsResponse.json()) as ListAiServiceBindingsResponse)
    .bindings.chat;
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
      .poll(
        async () => {
          const { stdout } = await exec("docker", ["logs", fixtureName]);
          return stdout.includes("[meeting-chat-fixture] ready");
        },
        { timeout: 30_000 }
      )
      .toBe(true);
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

    const title = `Synthetic meeting Q&A ${randomUUID()}`;
    const segmentId = randomUUID();
    const source = {
      sourceId: "synthetic-microphone",
      epoch: 1,
      kind: "microphone",
      label: "Synthetic desk microphone",
      startMs: 0,
      endMs: 10000
    };
    async function createMeeting(meetingTitle: string, text: string) {
      const created = await page.request.post("/api/meetings/records", {
        data: { requestKey: randomUUID(), title: meetingTitle }
      });
      expect(created.status()).toBe(201);
      const id = (await created.json()).meeting.id as string;
      ids.push(id);
      const posted = await page.request.post(`/api/meetings/records/${id}/transcript`, {
        data: {
          requestKey: randomUUID(),
          expectedVersion: 0,
          sources: [source],
          events: [
            {
              cursor: 1,
              segment: {
                meetingId: id,
                segmentId,
                sourceId: source.sourceId,
                epoch: 1,
                startMs: 1000,
                endMs: 4000,
                revision: 1,
                text,
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
      return { id, version: (await posted.json()).receipt.version as number };
    }
    const selected = await createMeeting(title, MEETING_FIXTURE_OLD);
    await createMeeting(`Other synthetic meeting ${randomUUID()}`, MEETING_FIXTURE_UNRELATED);
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await meetingRow(page, title).click();
    await openMeetingChat(page);
    await expect(page.locator(".chatd--docked")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove meeting context", exact: true })
    ).toBeVisible();

    await test.step("Encoded turn routes retain the meeting selection boundary", async () => {
      for (const path of ["/%61pi/chat/turn", "/api/%63hat/turn", "/api/chat/%74urn"]) {
        for (const meetingContext of [undefined, { meetingId: selected.id, selectionId: "" }]) {
          const rejected = await page.request.post(path, {
            data: {
              surface: meetingChatSurface(selected.id),
              text: MEETING_FIXTURE_QUESTION,
              ...(meetingContext === undefined ? {} : { meetingContext })
            }
          });
          expect(new URL(rejected.url()).pathname).toBe(path);
          expect(rejected.status(), path).toBe(400);
          expect(await rejected.json(), path).toEqual({
            error: "Invalid meeting question. Attachments and actions are unavailable."
          });
        }
      }
      expect(await fixtureEvidence(fixtureName)).toEqual([]);
    });

    const first = await sendQuestion(page);
    expect(first.meetingContext.meetingId).toBe(selected.id);
    expect(first.meetingContext.transcriptRevision).toBe(selected.version);
    expect(first.answerProvenanceCitedIds).toEqual(["S1"]);
    await expect(
      page.locator(".chatd-bubble").filter({ hasText: "The synthetic decision is recorded" })
    ).toHaveCount(1);
    expect(await fixtureEvidence(fixtureName)).toEqual([
      {
        path: "/v1/chat/completions",
        model: MEETING_FIXTURE_MODEL,
        hasTools: false,
        hasNativeSearch: false,
        hasOld: true,
        hasNew: false,
        hasUnrelated: false,
        hasExternalSource: true
      }
    ]);

    await test.step("Offline and reconnect preserve the open meeting answer and unsent question", async () => {
      const composer = page.getByRole("textbox", { name: /^Message/ });
      const draft = "Keep this unsent meeting follow-up through reconnect.";
      await composer.fill(draft);
      try {
        await page.context().setOffline(true);
        // Span an access-poll interval. React Query may pause offline requests; explicit
        // failed-poll status handling is covered separately by the component regressions.
        await page.waitForTimeout(5500);
        await expect(composer).toHaveValue(draft);
        await expect(
          page.getByRole("button", { name: "Remove meeting context", exact: true })
        ).toBeVisible();
        await expect(
          page.locator(".chatd-bubble").filter({ hasText: "The synthetic decision is recorded" })
        ).toHaveCount(1);
        await expect(page.getByText("Meeting unavailable", { exact: true })).toHaveCount(0);
      } finally {
        await page.context().setOffline(false);
      }
      const access = await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/chat/meeting-context" &&
          response.status() === 200,
        { timeout: 15_000 }
      );
      expect((await access.json()).available).toBe(true);
      await expect(composer).toHaveValue(draft);
      await expect(
        page.locator(".chatd-bubble").filter({ hasText: "The synthetic decision is recorded" })
      ).toHaveCount(1);
      await composer.fill("");
      expect(await fixtureEvidence(fixtureName)).toHaveLength(1);
    });

    // Correct the same retained segment through the production ingest route while chat stays open.
    const update = await page.request.post(`/api/meetings/records/${selected.id}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: selected.version,
        sources: [source],
        events: [
          {
            cursor: 2,
            segment: {
              meetingId: selected.id,
              segmentId,
              sourceId: source.sourceId,
              epoch: 1,
              startMs: 1000,
              endMs: 4000,
              revision: 2,
              text: MEETING_FIXTURE_NEW,
              finality: "final",
              provenance: "correction",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: 10000
      }
    });
    expect(update.status()).toBe(201);
    const updatedVersion = (await update.json()).receipt.version as number;
    const second = await sendQuestion(page);
    expect(second.meetingContext.transcriptRevision).toBe(updatedVersion);
    expect(second.meetingContext.cursor).toBe(2);
    const evidence = await fixtureEvidence(fixtureName);
    expect(evidence).toHaveLength(2);
    expect(evidence[1]).toEqual({
      path: "/v1/chat/completions",
      model: MEETING_FIXTURE_MODEL,
      hasTools: false,
      hasNativeSearch: false,
      hasOld: false,
      hasNew: true,
      hasUnrelated: false,
      hasExternalSource: true
    });

    // A disabled hard-pinned model is a configuration error, never permission to substitute.
    expect(
      (
        await page.request.patch(`/api/ai/models/${modelId}`, { data: { status: "disabled" } })
      ).status()
    ).toBe(200);
    const rejectedTurn = page.waitForResponse(
      (r) => r.url().endsWith("/api/chat/turn") && r.request().method() === "POST"
    );
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.fill(MEETING_FIXTURE_QUESTION);
    await composer.press("Enter");
    const rejected = await rejectedTurn;
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).code).toBe("meeting_chat_unsupported");
    await expect(
      page.getByText("Choose an active chat model in AI providers.", { exact: true })
    ).toBeVisible();
    expect(await fixtureEvidence(fixtureName)).toHaveLength(2);

    await test.step("A disabled unpinned override cannot send meeting evidence to an active default", async () => {
      const fallbackProvider = await page.request.post("/api/ai/providers", {
        data: {
          providerKind: "openai-compatible",
          displayName: "Synthetic meeting UAT fallback provider",
          baseUrl: `http://${fixtureName}:${MEETING_FIXTURE_PORT}`,
          authMethod: "api_key",
          credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
        }
      });
      expect(fallbackProvider.status()).toBe(201);
      fallbackProviderId = (await fallbackProvider.json()).provider.id as string;
      const fallbackModel = await page.request.post("/api/ai/models", {
        data: {
          providerConfigId: fallbackProviderId,
          providerModelId: fallbackProviderModelId,
          displayName: "Synthetic meeting UAT fallback model",
          capabilities: ["chat"],
          status: "active",
          tier: "interactive",
          allowUserOverride: true
        }
      });
      expect(fallbackModel.status()).toBe(201);
      fallbackModelId = (await fallbackModel.json()).model.id as string;
      expect(
        (await page.request.put(`/api/ai/providers/${fallbackProviderId}/default`)).status()
      ).toBe(200);
      defaultProviderChanged = true;
      // A fixed service binding takes precedence over the default provider. Preserve and
      // replace it only when present; an absent chat binding has no public delete route.
      if (originalChatBinding?.kind === "model") {
        expect(
          (
            await page.request.put("/api/ai/services/chat/binding", {
              data: { binding: { kind: "model", modelId: fallbackModelId } }
            })
          ).status()
        ).toBe(200);
        chatBindingChanged = true;
      }
      expect((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
      const fallbackSettings = await page.request.get("/api/ai/chat-model-override");
      expect(fallbackSettings.status()).toBe(200);
      expect(
        ((await fallbackSettings.json()) as GetChatModelOverrideSettingsResponse).settings
      ).toMatchObject({
        currentOverrideModelId: modelId,
        effectiveOverrideModelId: null,
        defaultModel: { id: fallbackModelId, providerConfigId: fallbackProviderId },
        selectedModel: { id: fallbackModelId, providerConfigId: fallbackProviderId }
      });
      const fallbackTurn = page.waitForResponse(
        (r) => r.url().endsWith("/api/chat/turn") && r.request().method() === "POST"
      );
      await composer.fill(MEETING_FIXTURE_QUESTION);
      await composer.press("Enter");
      const fallbackRejected = await fallbackTurn;
      expect(fallbackRejected.status()).toBe(422);
      expect((await fallbackRejected.json()).code).toBe("meeting_chat_unsupported");
      await expect(
        page.getByText("Choose an active chat model in AI providers.", { exact: true })
      ).toBeVisible();
      expect(await fixtureEvidence(fixtureName)).toHaveLength(2);
    });
    await test.step("Admin-disabled overrides recover through the locked default-model pill", async () => {
      const disabled = await page.request.put("/api/admin/ai/chat-model-override", {
        data: { enabled: false }
      });
      expect(disabled.status()).toBe(200);
      try {
        expect(
          ((await disabled.json()) as GetChatModelOverrideSettingsResponse).settings
        ).toMatchObject({
          overrideEnabled: false,
          currentOverrideModelId: modelId,
          effectiveOverrideModelId: null,
          defaultModel: { id: fallbackModelId, providerConfigId: fallbackProviderId },
          selectedModel: { id: fallbackModelId, providerConfigId: fallbackProviderId }
        });
        // Load the selected meeting afresh so the pill reads current admin policy.
        await page.goto(`/meetings?id=${selected.id}`);
        await openMeetingChat(page);
        await expect(
          page.getByRole("button", { name: "Remove meeting context", exact: true })
        ).toBeVisible();
        await expect(page.locator(".chatd-model--locked")).toHaveText(
          "Synthetic meeting UAT fallback model"
        );
        await expect(page.getByRole("button", { name: /^Chat model:/ })).toHaveCount(0);
        const recovered = await sendQuestion(page);
        expect(recovered.meetingContext.meetingId).toBe(selected.id);
        expect(recovered.meetingContext.transcriptRevision).toBe(updatedVersion);
        expect(recovered.answerProvenanceCitedIds).toEqual(["S1"]);
        await expect(
          page.locator(".chatd-bubble").filter({ hasText: "The synthetic decision is recorded" })
        ).toHaveCount(3);
        const recoveredEvidence = await fixtureEvidence(fixtureName);
        expect(recoveredEvidence).toHaveLength(3);
        expect(recoveredEvidence[2]).toEqual({
          path: "/v1/chat/completions",
          model: fallbackProviderModelId,
          hasTools: false,
          hasNativeSearch: false,
          hasOld: false,
          hasNew: true,
          hasUnrelated: false,
          hasExternalSource: true
        });
      } finally {
        expect(
          (
            await page.request.put("/api/admin/ai/chat-model-override", { data: { enabled: true } })
          ).status()
        ).toBe(200);
      }
    });
    expect(
      (
        await page.request.patch(`/api/ai/models/${modelId}`, { data: { status: "active" } })
      ).status()
    ).toBe(200);

    // The OLD answer's chip must still dereference revision 1 after revision 2 is current.
    const dereference = page.waitForResponse((r) =>
      r.url().endsWith(`/api/chat/messages/${first.assistantMessageId}/provenance/S1/dereference`)
    );
    await page
      .getByRole("listitem", { name: /^Open transcript at/ })
      .first()
      .click();
    expect((await dereference).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`segmentRevision=1`));
    const evidenceRegion = page.locator(`#meeting-reference-${selected.id}`);
    await expect(evidenceRegion).toContainText(MEETING_FIXTURE_OLD);
    await expect(evidenceRegion).toContainText("Earlier text at 0:01");
    await expect(evidenceRegion).toBeFocused();
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
      MEETING_FIXTURE_NEW
    );
    const url = new URL(page.url());
    expect(url.searchParams.get("id")).toBe(selected.id);
    expect(url.searchParams.get("segmentId")).toBe(segmentId);
    expect(url.searchParams.get("startCharacter")).toBe("0");
    expect(url.searchParams.get("endCharacter")).toBe(String(MEETING_FIXTURE_OLD.length));
    await test.step("A route-selected meeting with notes only sends notes and no invented transcript citation", async () => {
      const notesTitle = `Synthetic notes-only meeting ${randomUUID()}`;
      const created = await page.request.post("/api/meetings/records", {
        data: { requestKey: randomUUID(), title: notesTitle }
      });
      expect(created.status()).toBe(201);
      const notesMeetingId = (await created.json()).meeting.id as string;
      ids.push(notesMeetingId);
      const saved = await page.request.put(`/api/meetings/records/${notesMeetingId}/notes`, {
        data: {
          requestKey: randomUUID(),
          expectedRevision: 0,
          personalNotes: MEETING_FIXTURE_NOTES
        }
      });
      expect(saved.status()).toBe(200);
      await page.goto("/meetings");
      await meetingRow(page, notesTitle).click();
      await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
        MEETING_FIXTURE_NOTES
      );
      await openMeetingChat(page);
      const answer = await sendQuestion(page);
      expect(answer.meetingContext).toMatchObject({
        meetingId: notesMeetingId,
        transcriptRevision: 0,
        cursor: 0,
        throughMs: null,
        notesRevision: 1,
        notesCharacters: MEETING_FIXTURE_NOTES.length,
        notesTruncated: false
      });
      expect(answer.answerProvenanceCitedIds).toEqual([]);
      expect(answer.answerProvenance).toEqual([]);
      await expect(
        page
          .locator(".chatd-bubble")
          .filter({ hasText: "The synthetic decision is recorded in the personal notes." })
      ).toHaveCount(1);
      const observations = await fixtureEvidence(fixtureName);
      expect(observations).toHaveLength(4);
      expect(observations[3]).toEqual({
        path: "/v1/chat/completions",
        model: MEETING_FIXTURE_MODEL,
        hasTools: false,
        hasNativeSearch: false,
        hasOld: false,
        hasNew: false,
        hasUnrelated: false,
        hasExternalSource: true,
        hasNotes: true
      });
      await page.getByRole("button", { name: "Remove meeting context", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Remove meeting context", exact: true })
      ).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
      await page.getByRole("button", { name: "Meetings", exact: true }).click();
      await meetingRow(page, title).click();
      await expect(
        page.getByRole("button", { name: "Remove meeting context", exact: true })
      ).toBeVisible();
    });
    console.log(
      "MEETINGS_CHAT_UAT real UI/API; 6 encoded turn selection rejections before any provider request; disclosed local HTTP provider; 4 observed requests; selected model for transcript and notes-only requests, configured default only after admin disabled overrides; no tools/search; selected latest text only; disabled pinned model and enabled unpinned override rejected with no provider calls; locked default-model pill recovery with retained preference; immutable revision-1 citation opened; route context removable and notes-only question has no timestamp citations"
    );
  } finally {
    // The provisioner destroys the isolated DB too; restoring settings makes failures diagnosable.
    try {
      // Restore the prior hard pin before the user override (override writes reject an active pin).
      expect((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
      for (const id of ids)
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
      if (pin.pinnedModelId || pin.pinnedProviderId)
        expect(
          (
            await page.request.put(pinPath, {
              data: { modelId: pin.pinnedModelId, providerId: pin.pinnedProviderId }
            })
          ).status()
        ).toBe(200);
      if (chatBindingChanged)
        expect(
          (
            await page.request.put("/api/ai/services/chat/binding", {
              data: { binding: originalChatBinding }
            })
          ).status()
        ).toBe(200);
      if (defaultProviderChanged && originalDefault)
        expect(
          (await page.request.put(`/api/ai/providers/${originalDefault.id}/default`)).status()
        ).toBe(200);
      if (fallbackModelId)
        expect((await page.request.delete(`/api/ai/models/${fallbackModelId}`)).status()).toBe(200);
      if (fallbackProviderId)
        expect(
          (await page.request.post(`/api/ai/providers/${fallbackProviderId}/revoke`)).status()
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
