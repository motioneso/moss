import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { recordingBundle, recordingFile } from "../../fixtures/recording-bundle.js";
import {
  syntheticMeetingPcm,
  CAPTURE_FIXTURE_MODEL,
  CAPTURE_FIXTURE_TEXT
} from "../fixtures/meeting-capture-fixture-server.js";
import { requireUatBaseURL, requireUatProjectName } from "./real-chat-signin.js";

// Real signup, Settings, routing, ASR transport, import queue and retained transcript.
// The disclosed third-party ASR stand-in validates generated audio, not speech quality.
export const uatLevel = { level: "bare", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const exec = promisify(execFile);

test("admin selection reaches voice and Meeting ASR and preserves the old endpoint (#3601)", async ({
  page
}) => {
  test.setTimeout(240_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-") || process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    throw new Error("Use isolated credential-free UAT");
  await page.goto(requireUatBaseURL());
  await page.getByLabel("Name", { exact: true }).fill("Transcription Owner");
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Skip setup" }).click();
  await page.getByRole("button", { name: "Skip anyway" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
  const fixtureName = `${project}-transcription-fixture`;
  const port = Number(
    (await exec("devports", ["claim", "transcription-provider-asr"])).stdout.trim()
  );
  let meetingId: string | undefined;
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
      String(port)
    ]);
    await expect
      .poll(async () =>
        (await exec("docker", ["logs", fixtureName])).stdout.includes(
          "[meeting-capture-fixture] ready"
        )
      )
      .toBe(true);
    // Configure two real records through product APIs. The old endpoint is deliberately
    // unreachable: a successful ASR call must use the explicit new selection.
    expect(
      (
        await page.request.put("/api/ai/voice-endpoint", {
          data: {
            baseUrl: "http://unselected.invalid",
            modelName: "legacy-asr",
            apiKey: "synthetic-legacy-key"
          }
        })
      ).status()
    ).toBe(200);
    const original = await (await page.request.get("/api/ai/voice-endpoint")).json();
    const created = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Generated audio provider",
        baseUrl: `http://${fixtureName}:${port}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-real-key" }
      }
    });
    expect(created.status()).toBe(201);
    const providerId = (await created.json()).provider.id;
    const added = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: CAPTURE_FIXTURE_MODEL,
        displayName: "Generated audio model",
        capabilities: ["transcription"],
        status: "active",
        tier: "economy"
      }
    });
    expect(added.status()).toBe(201);
    const modelId = (await added.json()).model.id;
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
    await page.getByRole("button", { name: "AI providers", exact: true }).click();
    const selection = page.getByLabel("Provider and model", { exact: true });
    await expect(selection).toHaveValue("");
    await expect(page.getByLabel("Voice endpoint base URL")).toHaveValue(
      "http://unselected.invalid"
    );
    await selection.selectOption(modelId);
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/ai/services/transcription/binding") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save transcription provider", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await page.reload();
    await expect(selection).toHaveValue(modelId);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(selection).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    const bundle = { ...recordingBundle(), sourceDeviceId: randomUUID() };
    const wav = Buffer.from(bundle.wav.base64, "base64");
    syntheticMeetingPcm(120).copy(wav, 44);
    const voice = await page.request.post("/api/ai/transcriptions?timestamps=segment", {
      headers: { "content-type": "audio/wav" },
      data: wav
    });
    expect(voice.status()).toBe(200);
    expect((await voice.json()).text).toBe(CAPTURE_FIXTURE_TEXT);
    expect(
      (
        await page.request.put("/api/meetings/preferences", {
          data: { summarizeOnStop: false, transcriptLanguage: "es" }
        })
      ).status()
    ).toBe(200);
    const imported = await page.request.post("/api/meetings/recording-imports", {
      data: { ...bundle, wav: recordingFile(bundle.wav.name, wav) }
    });
    expect(imported.status()).toBe(202);
    const accepted = await imported.json();
    meetingId = accepted.meetingId;
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/meetings/recording-imports/${accepted.id}`)).json())
            .state,
        { timeout: 60_000 }
      )
      .toBe("complete");
    const transcript = await page.request.get(
      `/api/meetings/records/${meetingId}/transcript?maxSegments=50&maxCharacters=10000`
    );
    expect(transcript.status()).toBe(200);
    expect(JSON.stringify(await transcript.json())).toContain(CAPTURE_FIXTURE_TEXT);
    const evidence = await exec("docker", [
      "exec",
      fixtureName,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/evidence').then(r=>r.text()).then(console.log)`
    ]);
    const { observations } = JSON.parse(evidence.stdout);
    expect(observations.map((o: { language: string | null }) => o.language)).toEqual([null, "es"]);
    expect(
      (
        await page.request.patch(`/api/ai/models/${modelId}`, { data: { status: "disabled" } })
      ).status()
    ).toBe(200);
    expect(
      (
        await page.request.post("/api/ai/transcriptions", {
          headers: { "content-type": "audio/wav" },
          data: wav
        })
      ).status()
    ).toBe(422);
    await page.reload();
    await expect(selection).toHaveValue(modelId);
    await expect(selection.locator("option:checked")).toHaveText("Saved model (unavailable)");
    await selection.selectOption("");
    const cleared = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/ai/services/transcription/binding") &&
        r.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Save transcription provider", exact: true }).click();
    expect((await cleared).status()).toBe(200);
    await page.reload();
    await expect(selection).toHaveValue("");
    expect(await (await page.request.get("/api/ai/voice-endpoint")).json()).toEqual(original);
    await expect(page.getByLabel("Voice endpoint base URL")).toHaveValue(
      "http://unselected.invalid"
    );
    await page.goto(`/meetings?id=${meetingId}`);
    await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
      CAPTURE_FIXTURE_TEXT
    );
    console.log(
      "TRANSCRIPTION_PROVIDER_UAT PASS: real owner signup and Settings path; provider selection save/reload; phone width; actual voice and normal Meeting ASR requests; retained transcript; Spanish hint; unavailable selection fails closed; explicit restore keeps legacy endpoint/key metadata. Disclosed generated-audio ASR stand-in; no speech quality or physical ring claim."
    );
  } finally {
    if (meetingId) await page.request.delete(`/api/meetings/records/${meetingId}`);
    await exec("docker", ["rm", "--force", fixtureName]).catch(() => undefined);
    await exec("devports", ["release", String(port)]);
  }
});
