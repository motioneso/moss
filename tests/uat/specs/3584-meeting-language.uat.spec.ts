import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { recordingBundle, recordingFile } from "../../fixtures/recording-bundle.js";
import {
  syntheticMeetingPcm,
  CAPTURE_FIXTURE_MODEL,
  CAPTURE_FIXTURE_TEXT
} from "../fixtures/meeting-capture-fixture-server.js";
import { requireUatBaseURL, requireUatProjectName } from "./real-chat-signin.js";

// Real Settings, owner API, queue, ASR adapter, vault and transcript. The disclosed
// third-party ASR stand-in checks generated WAV and records the actual multipart hint.
// This proves request behavior, not speech recognition quality or physical ring capture.
export const uatLevel = { level: "bare", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const exec = promisify(execFile);

async function chooseLanguage(page: Page, language: string) {
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/meetings/preferences") && r.request().method() === "PUT"
  );
  await page.getByLabel("Transcript language", { exact: true }).selectOption(language);
  expect((await saved).status()).toBe(200);
}

test("shared language saved through Settings reaches normal import ASR and clears for automatic detection (#3584)", async ({
  page
}) => {
  test.setTimeout(240_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-") || process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    throw new Error("Use isolated credential-free UAT");
  await page.goto(requireUatBaseURL());
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Meeting Language Owner");
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Skip setup" }).click();
  await page.getByRole("button", { name: "Skip anyway" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
  const original = await (await page.request.get("/api/meetings/preferences")).json();
  const originalMode = (await (await page.request.get("/api/me/themes")).json()).mode;
  const { user } = await (await page.request.get("/api/me")).json();
  const pinPath = `/api/admin/users/${user.id}/ai-pin`;
  const { pin } = await (await page.request.get(pinPath)).json();
  const fixtureName = `${project}-meeting-language-fixture`;
  const fixturePort = Number(
    (await exec("devports", ["claim", "meeting-language-asr"])).stdout.trim()
  );
  const meetings: string[] = [];
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
      "tests/uat/fixtures/meeting-capture-fixture-cli.ts",
      String(fixturePort)
    ]);
    await expect
      .poll(async () =>
        (await exec("docker", ["logs", fixtureName])).stdout.includes(
          "[meeting-capture-fixture] ready"
        )
      )
      .toBe(true);
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Synthetic language ASR",
        baseUrl: `http://${fixtureName}:${fixturePort}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
      }
    });
    expect(provider.status()).toBe(201);
    const providerId = (await provider.json()).provider.id;
    const model = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: CAPTURE_FIXTURE_MODEL,
        displayName: "Synthetic language ASR",
        capabilities: ["transcription"],
        status: "active",
        tier: "economy"
      }
    });
    expect(model.status()).toBe(201);
    expect(
      (
        await page.request.put(pinPath, { data: { modelId: (await model.json()).model.id } })
      ).status()
    ).toBe(200);
    // Avoid unrelated summary inference; restore the original choice in finally.
    expect(
      (
        await page.request.put("/api/meetings/preferences", { data: { summarizeOnStop: false } })
      ).status()
    ).toBe(200);
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Modules", exact: true }).click();
    await page.getByRole("button", { name: "Configure Meetings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
    await chooseLanguage(page, "es");
    await page.reload();
    await expect(page.getByLabel("Transcript language", { exact: true })).toHaveValue("es");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("group", { name: "Color mode", exact: true })
      .getByRole("button", { name: "Dark", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
    await page.getByRole("button", { name: "Modules", exact: true }).click();
    await page.getByRole("button", { name: "Configure Meetings", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Transcript language", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );

    const imported = async (failed = false) => {
      const bundle = { ...recordingBundle(), sourceDeviceId: randomUUID() };
      const wav = Buffer.from(bundle.wav.base64, "base64");
      syntheticMeetingPcm(120).copy(wav, 44);
      const response = await page.request.post("/api/meetings/recording-imports", {
        data: {
          ...bundle,
          wav: recordingFile(bundle.wav.name, wav)
        }
      });
      expect(response.status()).toBe(202);
      const accepted = await response.json();
      meetings.push(accepted.meetingId);
      const statusPath = `/api/meetings/recording-imports/${accepted.id}`;
      await expect
        .poll(async () => (await (await page.request.get(statusPath)).json()).state, {
          timeout: 60_000
        })
        .toBe(failed ? "failed" : "complete");
      if (failed)
        expect(await (await page.request.get(statusPath)).json()).toMatchObject({
          code: "transcription_failed",
          retryable: false
        });
      else {
        const transcript = await page.request.get(
          `/api/meetings/records/${accepted.meetingId}/transcript?maxSegments=50&maxCharacters=10000`
        );
        expect(transcript.status()).toBe(200);
        expect(JSON.stringify(await transcript.json())).toContain(CAPTURE_FIXTURE_TEXT);
      }
      return accepted.meetingId as string;
    };
    const first = await imported();
    await chooseLanguage(page, "");
    await imported();
    await chooseLanguage(page, "aa");
    await imported(true);
    const evidence = await exec("docker", [
      "exec",
      fixtureName,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${fixturePort}/evidence').then(r=>r.text()).then(console.log)`
    ]);
    const { observations } = JSON.parse(evidence.stdout);
    expect(observations.map((o: { language: string | null }) => o.language)).toEqual([
      "es",
      null,
      "aa"
    ]);
    expect(observations.every((o: { generatedPcm: boolean }) => o.generatedPcm)).toBe(true);
    await chooseLanguage(page, "");
    await page.goto(`/meetings?id=${first}`);
    await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
      CAPTURE_FIXTURE_TEXT
    );
    console.log(
      "MEETING_LANGUAGE_UAT PASS: fresh owner signup; Settings path; save/reload Spanish; saved dark mode at phone width; authenticated generated normal import; actual multipart es then absent; unsupported aa fails without fallback; retained transcript visible after reset. Disclosed ASR stand-in; no real speech or ring claim."
    );
  } finally {
    for (const id of meetings)
      expect.soft((await page.request.delete(`/api/meetings/records/${id}`)).status()).toBe(204);
    expect
      .soft((await page.request.put("/api/meetings/preferences", { data: original })).status())
      .toBe(200);
    expect
      .soft(
        (await page.request.put("/api/me/themes/mode", { data: { mode: originalMode } })).status()
      )
      .toBe(200);
    expect.soft((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
    if (pin.pinnedModelId || pin.pinnedProviderId)
      await page.request.put(pinPath, {
        data: { modelId: pin.pinnedModelId, providerId: pin.pinnedProviderId }
      });
    await exec("docker", ["rm", "--force", fixtureName]).catch(() => undefined);
    await exec("devports", ["release", String(fixturePort)]);
  }
});
