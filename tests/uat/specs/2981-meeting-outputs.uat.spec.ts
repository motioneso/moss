import { assertMeetingReviewLayout } from "./meeting-review-layout.js";
import { meetingRow, openMeetingAction } from "./meeting-minimal-ui.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { MeetingsExportSection } from "@moss/meetings";
import type {
  MeetingActionCandidate,
  MeetingExportReceipt,
  MeetingOutputArtifact
} from "@moss/shared";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import {
  OUTPUT_FIXTURE_PORT,
  OUTPUT_FIXTURE_MODEL,
  OUTPUT_FIXTURE_TEXT,
  OUTPUT_FIXTURE_OVERVIEW,
  OUTPUT_FIXTURE_DECISION,
  OUTPUT_FIXTURE_MANUAL
} from "../fixtures/meeting-outputs-fixture-server.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
export const uatLevel = { level: "solo-admin", without: [] } as const;
const exec = promisify(execFile);
interface Outputs {
  headVersion: number;
  artifacts: MeetingOutputArtifact[];
  candidates: MeetingActionCandidate[];
}
interface VaultEvidence {
  file: string;
  hash: string;
  generatedOverview: boolean;
  manualOverview: boolean;
}
async function readOutputs(page: Page, path: string): Promise<Outputs> {
  const response = await page.request.get(`${path}/outputs`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Outputs>;
}
async function vaultEvidence(project: string, meetingId: string): Promise<VaultEvidence[]> {
  if (!project.startsWith("uat-")) throw new Error("Use isolated UAT provisioner");
  // The launcher has no DAC override. Match the API's ordinary runtime owner, as the
  // existing notes-failure-evidence fixture does, without changing any vault permissions.
  const ownerResult = await exec(
    "docker",
    buildUatComposeArgs(project, ["exec", "-T", "jarv1s", "stat", "-c", "%u:%g", "/data/vaults"])
  );
  const owner = ownerResult.stdout.trim();
  if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(owner))
    throw new Error("Expected a non-root isolated vault runtime owner");
  const { stdout } = await exec(
    "docker",
    buildUatComposeArgs(project, [
      "exec",
      "-T",
      "--user",
      owner,
      "jarv1s",
      "node_modules/.bin/tsx",
      "tests/uat/fixtures/meeting-outputs-vault-evidence-cli.ts",
      UAT_ADMIN_ID,
      meetingId,
      owner
    ])
  );
  return JSON.parse(stdout) as VaultEvidence[];
}
async function clickCommand(page: Page, name: string, path: string, method = "POST") {
  const response = page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === method
  );
  await page.getByRole("button", { name, exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result;
}
async function assertReceipt(page: Page, receipt: MeetingExportReceipt, version: number) {
  expect(receipt).toMatchObject({
    artifactVersion: version,
    destination: "private-vault",
    audience: "owner",
    writeStatus: "saved"
  });
  expect(receipt.noteReference).toMatch(new RegExp(`/v${version}\\.md$`));
  // A durable write and acknowledged indexing request are different outcomes, never "Indexed".
  expect(["queued", "delayed"]).toContain(receipt.indexStatus);
  if (receipt.indexStatus === "queued") expect(receipt.indexJobId).toBeTruthy();
  if (receipt.indexStatus === "delayed") expect(receipt.errorCode).toBe("meeting_index_delayed");
  await expect(page.getByRole("region", { name: "Save to vault", exact: true })).toContainText(
    `Saved to Moss private vault. Search indexing ${receipt.indexStatus}`
  );
}

// Live-path scope: real login/UI, API/services, configured synthetic third-party HTTP model,
// Task API and public VaultContext reads. No Moss response interception. Bounded source only:
// this does not prove hosted-model quality, audio/ASR, or whole long-meeting coverage. The
// runtime's escaped prompt has a 65,536-byte ceiling, independently exercised by pure tests.
test("reviewed summary versions create independent Tasks and private vault copies (#2981)", async ({
  page
}) => {
  test.setTimeout(180_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use isolated UAT provisioner");
  const fixtureName = `${project}-meeting-outputs-fixture`;
  let meetingId: string | undefined;
  let providerId: string | undefined;
  let modelId: string | undefined;
  await signInUatAdmin(page);
  const pinPath = `/api/admin/users/${UAT_ADMIN_ID}/ai-pin`;
  const prior = await page.request.get(pinPath);
  expect(prior.status()).toBe(200);
  const { pin } = (await prior.json()) as {
    pin: { pinnedModelId: string | null; pinnedProviderId: string | null };
  };
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
      "tests/uat/fixtures/meeting-outputs-fixture-cli.ts"
    ]);
    await expect
      .poll(
        async () =>
          (await exec("docker", ["logs", fixtureName])).stdout.includes(
            "[meeting-outputs-fixture] ready"
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    const provider = await page.request.post("/api/ai/providers", {
      data: {
        providerKind: "openai-compatible",
        displayName: "Synthetic meeting output HTTP provider",
        baseUrl: `http://${fixtureName}:${OUTPUT_FIXTURE_PORT}`,
        authMethod: "api_key",
        credentialPayload: { apiKey: "synthetic-uat-not-a-provider-credential" }
      }
    });
    expect(provider.status()).toBe(201);
    providerId = (await provider.json()).provider.id as string;
    const model = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId: providerId,
        providerModelId: OUTPUT_FIXTURE_MODEL,
        displayName: "Synthetic summary JSON model",
        capabilities: ["chat", "summarization", "json"],
        status: "active",
        tier: "economy"
      }
    });
    expect(model.status()).toBe(201);
    modelId = (await model.json()).model.id as string;
    expect((await page.request.put(pinPath, { data: { modelId } })).status()).toBe(200);
    const title = `Synthetic Orchid summary ${randomUUID()}`;
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    // Notes-only output review does not require a linked Mac. Create the fixture through
    // the real API, then open it from the unlinked account's preserved history list.
    const createdResponse = await page.request.post("/api/meetings/records", {
      data: { requestKey: randomUUID(), title: "Untitled meeting" }
    });
    expect(createdResponse.status()).toBe(201);
    meetingId = (await createdResponse.json()).meeting.id as string;
    await page.reload();
    await meetingRow(page, "Untitled meeting").click();
    await page.getByRole("button", { name: "Edit meeting title", exact: true }).click();
    await page.getByLabel("Meeting title", { exact: true }).fill(title);
    const renamed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/meetings/records/${meetingId}/title`) &&
        response.request().method() === "PUT"
    );
    await page.getByLabel("Meeting title", { exact: true }).press("Enter");
    expect((await renamed).status()).toBe(200);
    const path = `/api/meetings/records/${meetingId}`;
    const segmentId = randomUUID();
    const posted = await page.request.post(`${path}/transcript`, {
      data: {
        requestKey: randomUUID(),
        expectedVersion: 0,
        sources: [
          {
            sourceId: "synthetic-mic",
            epoch: 1,
            kind: "microphone",
            label: "Synthetic source",
            startMs: 0,
            endMs: 10000
          }
        ],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId,
              segmentId,
              sourceId: "synthetic-mic",
              epoch: 1,
              startMs: 1000,
              endMs: 4000,
              revision: 1,
              text: OUTPUT_FIXTURE_TEXT,
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: 10000
      }
    });
    expect(posted.status()).toBe(201);
    await page.reload();
    const summary = page.getByRole("region", { name: "Summary and actions", exact: true });
    await expect(page.getByLabel("Summary style", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Write summary", exact: true })).toHaveCount(0);
    await openMeetingAction(page, "Rewrite summary");
    await expect(summary).toBeVisible();
    await expect(page.getByLabel("Summary style", { exact: true })).toHaveValue("general");
    await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeEnabled();
    await test.step("summary availability follows the effective default without dispatch", async () => {
      // Install the official locked Claude native binary in this disposable stack only.
      // This existing install seam verifies the package; no login/model invocation follows.
      const installed = await page.request.post("/api/onboarding/provider-install", {
        data: { providerKind: "anthropic" }
      });
      expect(installed.status()).toBe(200);
      expect(await installed.json()).toMatchObject({
        installState: "installed",
        version: "2.1.282"
      });
      const { stdout } = await exec(
        "docker",
        buildUatComposeArgs(project, [
          "exec",
          "-T",
          "jarv1s",
          "node_modules/.bin/tsx",
          "tests/uat/fixtures/meeting-output-default-models-cli.ts",
          project
        ])
      );
      const defaults = JSON.parse(stdout) as Record<
        "codex" | "claude",
        { providerId: string; modelId: string }
      >;
      try {
        for (const [name, availability] of [
          ["codex", "subscription-unsupported"],
          ["claude", "available"]
        ] as const) {
          expect(
            (
              await page.request.put(pinPath, {
                data: { modelId: defaults[name].modelId }
              })
            ).status()
          ).toBe(200);
          // Assert the real chat resolver's selected default too, not merely a seeded row.
          const effective = await page.request.get("/api/ai/chat-model-override");
          expect(effective.status()).toBe(200);
          expect((await effective.json()).settings).toMatchObject({
            defaultModel: { id: defaults[name].modelId },
            selectedModel: { id: defaults[name].modelId }
          });
          const refreshed = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
          expect((await refreshed.json()).generationAvailability).toBe(availability);
          const generate = page.getByRole("button", { name: "Write summary", exact: true });
          if (name === "codex") {
            await expect(generate).toBeDisabled();
            await expect(summary).toContainText(
              "Summaries on this subscription aren’t supported yet. No other model was used."
            );
          } else {
            // The production-like runner isolates each owner's structured calls.
            // Readiness makes no model request and does not require login.
            await expect(generate).toBeEnabled();
            await expect(summary).not.toContainText("Claude summaries aren’t available");
            await expect(summary).not.toContainText("Your default model is unavailable");
          }
          expect(await readOutputs(page, path)).toMatchObject({ headVersion: 0, artifacts: [] });
        }
      } finally {
        expect((await page.request.put(pinPath, { data: { modelId } })).status()).toBe(200);
        for (const configured of Object.values(defaults)) {
          expect((await page.request.delete(`/api/ai/models/${configured.modelId}`)).status()).toBe(
            200
          );
          expect(
            (await page.request.post(`/api/ai/providers/${configured.providerId}/revoke`)).status()
          ).toBe(200);
        }
      }
      const restored = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
      expect((await restored.json()).generationAvailability).toBe("available");
      await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeEnabled();
    });
    await test.step("an inactive default stays unavailable rather than substituting another model", async () => {
      try {
        expect(
          (
            await page.request.patch(`/api/ai/models/${modelId}`, {
              data: { status: "disabled" }
            })
          ).status()
        ).toBe(200);
        const unavailable = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
        expect((await unavailable.json()).generationAvailability).toBe("model-unavailable");
        await expect(
          page.getByRole("button", { name: "Write summary", exact: true })
        ).toBeDisabled();
        await expect(summary).toContainText(
          "Your default model is unavailable or cannot produce structured summaries. Check its connection and try again. No other model will be used."
        );
      } finally {
        expect(
          (
            await page.request.patch(`/api/ai/models/${modelId}`, {
              data: { status: "active" }
            })
          ).status()
        ).toBe(200);
      }
      const repaired = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
      expect((await repaired.json()).generationAvailability).toBe("available");
      await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeEnabled();
    });
    const failedRequestKey =
      await test.step("unsupported summary model explains real configuration recovery", async () => {
        // Change the real synthetic model, not a Moss response. The hard pin stays selected;
        // missing structured-output capability must fail before the provider is dispatched.
        try {
          expect(
            (
              await page.request.patch(`/api/ai/models/${modelId}`, {
                data: { capabilities: ["chat", "summarization"] }
              })
            ).status()
          ).toBe(200);
          const rejectedGeneration = page.waitForResponse(
            (r) => r.url().endsWith(`${path}/outputs`) && r.request().method() === "POST"
          );
          await page.getByRole("button", { name: "Write summary", exact: true }).click();
          const rejected = await rejectedGeneration;
          expect(rejected.status()).toBe(422);
          const requestKey = rejected.request().postDataJSON().requestKey as string;
          expect(await rejected.json()).toEqual({
            status: "failed",
            requestKey,
            code: "meeting_output_route_unavailable"
          });
          await expect(summary).toContainText(
            "Your default model is unavailable or cannot produce structured summaries. Check its connection and try again. No other model will be used."
          );
          await expect(summary).toContainText("Check your default model in");
          await expect(summary).not.toContainText("Choose Generate to start a new request");
          expect(await readOutputs(page, path)).toMatchObject({ headVersion: 0, artifacts: [] });
          const recovery = summary.getByRole("link", {
            name: "Settings → AI providers",
            exact: true
          });
          await expect(recovery).toHaveAttribute("href", "/settings?section=aiproviders");
          const reviewUrl = page.url();
          const timeOrigin = await page.evaluate(() => performance.timeOrigin);
          await recovery.click();
          await expect(page).toHaveURL(/\/settings\?section=aiproviders$/);
          await expect(
            page.getByRole("heading", { name: "AI providers", exact: true })
          ).toBeVisible();
          expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          const unavailableOnReturn = page.waitForResponse(
            (response) =>
              response.url().endsWith(`${path}/outputs`) && response.request().method() === "GET"
          );
          await page.goBack();
          await expect(page).toHaveURL(reviewUrl);
          await openMeetingAction(page, "Rewrite summary");
          expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          const unavailable = await unavailableOnReturn;
          expect(unavailable.status()).toBe(200);
          expect((await unavailable.json()).generationAvailability).toBe("model-unavailable");
          await expect(
            summary.getByText("Checking summary model availability…", { exact: true })
          ).toHaveCount(0);
          await expect(summary).toContainText("Check your default model in");
          await expect(page.getByLabel("Summary style", { exact: true })).toHaveValue("general");
          await expect(
            page.getByRole("button", { name: "Write summary", exact: true })
          ).toBeDisabled();
          await expect(summary).toContainText(
            "Refresh summaries after the configuration is updated, then generate again."
          );
          return requestKey;
        } finally {
          expect(
            (
              await page.request.patch(`/api/ai/models/${modelId}`, {
                data: { capabilities: ["chat", "summarization", "json"] }
              })
            ).status()
          ).toBe(200);
        }
      });
    await test.step("refreshes availability after a repair while the review stays open", async () => {
      // The API-only repair above happens after returning to the focused review, so it
      // creates no mount or visibility event. Follow the disabled-state recovery hint.
      await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeDisabled();
      await expect(summary).toContainText(
        "Refresh summaries after the configuration is updated, then generate again."
      );
      const refreshed = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
      expect((await refreshed.json()).generationAvailability).toBe("available");
      await expect(page.getByRole("button", { name: "Write summary", exact: true })).toBeEnabled();
    });
    await test.step("returning from repaired model settings rechecks availability without Refresh", async () => {
      // Also prove the ordinary Settings → repair → return flow. Change the real
      // synthetic model through its API; never replace an availability response.
      try {
        expect(
          (
            await page.request.patch(`/api/ai/models/${modelId}`, {
              data: { capabilities: ["chat", "summarization"] }
            })
          ).status()
        ).toBe(200);
        const unavailable = await clickCommand(page, "Refresh summaries", `${path}/outputs`, "GET");
        expect((await unavailable.json()).generationAvailability).toBe("model-unavailable");
        await expect(
          page.getByRole("button", { name: "Write summary", exact: true })
        ).toBeDisabled();
        const reviewUrl = page.url();
        await summary.getByRole("link", { name: "Settings → AI providers", exact: true }).click();
        await expect(page).toHaveURL(/\/settings\?section=aiproviders$/);
        await expect(
          page.getByRole("heading", { name: "AI providers", exact: true })
        ).toBeVisible();
        expect(
          (
            await page.request.patch(`/api/ai/models/${modelId}`, {
              data: { capabilities: ["chat", "summarization", "json"] }
            })
          ).status()
        ).toBe(200);
        const returning = page.waitForResponse(
          (response) =>
            response.url().endsWith(`${path}/outputs`) && response.request().method() === "GET"
        );
        await page.goBack();
        await expect(page).toHaveURL(reviewUrl);
        await openMeetingAction(page, "Rewrite summary");
        const rechecked = await returning;
        expect(rechecked.status()).toBe(200);
        expect((await rechecked.json()).generationAvailability).toBe("available");
        await expect(
          page.getByRole("button", { name: "Write summary", exact: true })
        ).toBeEnabled();
        await expect(page.getByLabel("Summary style", { exact: true })).toHaveValue("general");
        const selectedPin = await page.request.get(pinPath);
        expect(selectedPin.status()).toBe(200);
        expect((await selectedPin.json()).pin.pinnedModelId).toBe(modelId);
      } finally {
        expect(
          (
            await page.request.patch(`/api/ai/models/${modelId}`, {
              data: { capabilities: ["chat", "summarization", "json"] }
            })
          ).status()
        ).toBe(200);
      }
    });
    const generated = await clickCommand(page, "Write summary", `${path}/outputs`);
    expect(generated.request().postDataJSON().requestKey).not.toBe(failedRequestKey);
    console.log(
      "MEETINGS_SUMMARY_RECOVERY_UAT explicit disabled-state Refresh hint; focused-review repair → Refresh → enabled; Settings repair → return → automatic availability recheck → Generate POST, without an extra Refresh click."
    );
    await expect(summary).toContainText(OUTPUT_FIXTURE_OVERVIEW);
    await expect(summary).toContainText(OUTPUT_FIXTURE_DECISION);
    await assertMeetingReviewLayout(page);
    await page.getByRole("tab", { name: "Summary", exact: true }).click();
    let outputs = await readOutputs(page, path);
    expect(outputs.headVersion).toBe(1);
    expect(outputs.candidates).toHaveLength(1);
    const original = outputs.artifacts[0]!;
    expect(original.content.decisions[0]!.evidence).toEqual([
      {
        kind: "transcript",
        meetingId,
        segmentId,
        segmentRevision: 1,
        startCharacter: 0,
        endCharacter: OUTPUT_FIXTURE_TEXT.length
      }
    ]);
    const candidate = outputs.candidates[0]!;
    expect(candidate.reviewState).toBe("pending");
    expect(candidate.acceptedTaskId).toBeNull();
    const taskList = async () => {
      const response = await page.request.get("/api/tasks");
      expect(response.status()).toBe(200);
      const { tasks } = (await response.json()) as {
        tasks: { id: string; sourceRef: string | null; title: string; dueAt: string | null }[];
      };
      return tasks.filter((task) => task.sourceRef === meetingId);
    };
    expect(await taskList()).toHaveLength(0);
    // Follow exact evidence without unmounting the focused review controls.
    await page.getByRole("button", { name: "Edit summary", exact: true }).click();
    const overview = page.getByLabel("Overview", { exact: true });
    const editorNode = await overview.elementHandle();
    const evidenceLink = summary.getByRole("link", { name: /^Transcript ·/ }).first();
    await evidenceLink.focus();
    await evidenceLink.press("Enter");
    await expect(page.locator(`#meeting-line-${segmentId}`)).toContainText(OUTPUT_FIXTURE_TEXT);
    await expect(page.locator(`#meeting-line-${segmentId}`)).toBeFocused();
    expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(overview).toHaveValue(OUTPUT_FIXTURE_OVERVIEW);
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("segmentRevision")).toBe("1");
    await expect(
      page.getByRole("checkbox", { name: "Create in my Tasks after owner review", exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add to Tasks", exact: true })).toBeEnabled();
    const reviewedTitle = "Owner reviewed Orchid action";
    await page.getByLabel("Suggested task", { exact: true }).fill(reviewedTitle);
    const review = await clickCommand(
      page,
      "Add to Tasks",
      `${path}/actions/${candidate.id}/review`
    );
    const accepted = (await review.json()) as MeetingActionCandidate;
    expect(accepted.acceptedTaskId).toBeTruthy();
    expect(await taskList()).toEqual([
      expect.objectContaining({ id: accepted.acceptedTaskId, title: reviewedTitle, dueAt: null })
    ]);
    // Same command and a fresh acceptance request both reconcile to the same Task.
    for (const requestKey of [review.request().postDataJSON().requestKey as string, randomUUID()]) {
      const replay = await page.request.post(`${path}/actions/${candidate.id}/review`, {
        data: {
          ...review.request().postDataJSON(),
          requestKey
        }
      });
      expect(replay.status()).toBe(200);
      expect((await replay.json()).acceptedTaskId).toBe(accepted.acceptedTaskId);
    }
    await test.step("required Notes cannot be disabled before a private export", async () => {
      // Notes is required, so the review's disabled-Notes scenario cannot be reached
      // through real settings. Keep that product rule and never fake a missing module.
      const rejected = await page.request.patch("/api/me/modules/notes", {
        data: { disabled: true }
      });
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: "Required modules cannot be disabled" });
    });
    await openMeetingAction(page, "Save to vault");
    const firstSave = await clickCommand(page, "Save new private version", `${path}/exports`);
    const firstReceipt = (await firstSave.json()).receipt as MeetingExportReceipt;
    await assertReceipt(page, firstReceipt, 1);
    const firstFiles = await vaultEvidence(project, meetingId);
    expect(firstFiles).toEqual([
      {
        file: "v1.md",
        hash: firstReceipt.contentHash,
        generatedOverview: true,
        manualOverview: false
      }
    ]);
    const retrySave = await clickCommand(page, "Retry private save", `${path}/exports`);
    const repeated = (await retrySave.json()).receipt as MeetingExportReceipt;
    expect(repeated.noteReference).toBe(firstReceipt.noteReference);
    expect(repeated.contentHash).toBe(firstReceipt.contentHash);
    expect(await vaultEvidence(project, meetingId)).toEqual(firstFiles);
    // Owner changes the independent Task, then regenerates. It must not be overwritten.
    const changedTitle = "Independent Task edited after acceptance";
    expect(
      (
        await page.request.patch(`/api/tasks/${accepted.acceptedTaskId}`, {
          data: { title: changedTitle }
        })
      ).status()
    ).toBe(200);
    await openMeetingAction(page, "Rewrite summary");
    await clickCommand(page, "Rewrite summary", `${path}/outputs`);
    outputs = await readOutputs(page, path);
    expect(outputs.headVersion).toBe(2);
    expect(outputs.candidates).toHaveLength(1);
    expect(outputs.candidates[0]!.acceptedTaskId).toBe(accepted.acceptedTaskId);
    expect(await taskList()).toEqual([
      expect.objectContaining({ id: accepted.acceptedTaskId, title: changedTitle })
    ]);
    await openMeetingAction(page, "Earlier versions");
    await expect(page.getByLabel("Saved version", { exact: true })).toHaveValue("2");
    await page.getByRole("button", { name: "Edit summary", exact: true }).click();
    await page.getByLabel("Overview", { exact: true }).fill(OUTPUT_FIXTURE_MANUAL);
    await clickCommand(page, "Save edits as new version", `${path}/outputs`, "PUT");
    outputs = await readOutputs(page, path);
    expect(outputs.headVersion).toBe(3);
    expect(outputs.artifacts.find((artifact) => artifact.version === 1)).toEqual(original);
    expect(outputs.artifacts.find((artifact) => artifact.version === 3)).toMatchObject({
      origin: "manual",
      content: { overview: OUTPUT_FIXTURE_MANUAL }
    });
    expect(await vaultEvidence(project, meetingId)).toEqual(firstFiles);
    await expect(page.getByLabel("Saved version", { exact: true })).toHaveValue("3");
    await openMeetingAction(page, "Save to vault");
    const manualSave = await clickCommand(page, "Save new private version", `${path}/exports`);
    const manualReceipt = (await manualSave.json()).receipt as MeetingExportReceipt;
    await assertReceipt(page, manualReceipt, 3);
    expect(manualReceipt.noteReference).not.toBe(firstReceipt.noteReference);
    const finalFiles = await vaultEvidence(project, meetingId);
    expect(finalFiles).toEqual([
      ...firstFiles,
      {
        file: "v3.md",
        hash: manualReceipt.contentHash,
        generatedOverview: false,
        manualOverview: true
      }
    ]);
    await clickCommand(page, "Retry private save", `${path}/exports`);
    expect(await vaultEvidence(project, meetingId)).toEqual(finalFiles);
    const receipts = await page.request.get(`${path}/exports`);
    expect(receipts.status()).toBe(200);
    expect((await receipts.json()).receipts).toHaveLength(2);
    const { stdout } = await exec("docker", [
      "exec",
      fixtureName,
      "node",
      "--input-type=module",
      "-e",
      `const r=await fetch('http://127.0.0.1:${OUTPUT_FIXTURE_PORT}/evidence'); if(!r.ok)process.exit(1); console.log(await r.text());`
    ]);
    const { observations } = JSON.parse(stdout) as { observations: { promptBytes: number }[] };
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        model: OUTPUT_FIXTURE_MODEL,
        hasTools: false,
        hasSearch: false,
        exactSource: true,
        sourceCount: 1
      });
      expect(observation.promptBytes).toBeLessThanOrEqual(65536);
    }
    // The minimal list shows the summary gist; receipt detail remains factual in its API.
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(meetingRow(page, title)).toContainText(OUTPUT_FIXTURE_MANUAL);
    await expect(meetingRow(page, title)).not.toContainText("Indexed");
    const history = await page.request.post("/api/meetings/history/search", {
      data: { query: title, filter: "all", limit: 30 }
    });
    expect(history.status()).toBe(200);
    expect((await history.json()).meetings).toEqual([
      expect.objectContaining({
        id: meetingId,
        summary: expect.objectContaining({ version: 3, overview: OUTPUT_FIXTURE_MANUAL }),
        actions: expect.objectContaining({ accepted: 1 }),
        vault: expect.objectContaining({
          savedVersionCount: 2,
          latest: expect.objectContaining({
            artifactVersion: 3,
            indexStatus: manualReceipt.indexStatus
          })
        })
      })
    ]);
    await test.step("Settings downloads retained meeting data through the real export worker", async () => {
      // Retained revisions are seeded through real owner writes, not archive/response rewriting.
      for (const [expectedRevision, personalNotes] of [
        [0, "Synthetic retained meeting note"],
        [1, "Synthetic current meeting note"]
      ] as const) {
        expect(
          (
            await page.request.put(`${path}/notes`, {
              data: { requestKey: randomUUID(), expectedRevision, personalNotes }
            })
          ).status()
        ).toBe(200);
      }
      await page.goto(new URL("/settings?section=profile", page.url()).toString());
      await expect(page.getByText("Meetings — notes, transcripts & summaries")).toBeVisible();
      await page.getByRole("button", { name: "Prepare export", exact: true }).click();
      const downloadLink = page.getByRole("link", { name: "Download", exact: true });
      await expect(downloadLink).toBeVisible({ timeout: 60_000 });
      const downloaded = page.waitForEvent("download");
      await downloadLink.click();
      const download = await downloaded;
      expect(await download.failure()).toBeNull();
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const archive = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        format: string;
        userId: string;
        sections: { meetings: MeetingsExportSection };
      };
      expect(archive.format).toBe("jarvis-archive/v1");
      expect(archive.userId).toBe(UAT_ADMIN_ID);
      const exported = archive.sections.meetings;
      expect(Object.keys(exported).sort()).toEqual(
        [
          "records",
          "note_writes",
          "transcript_batches",
          "output_requests",
          "output_artifacts",
          "action_candidates",
          "export_receipts",
          "export_requests",
          "stop_summaries",
          "capture_grants",
          "capture_connections",
          "capture_start_cancellations",
          "capture_start_limits"
        ].sort()
      );
      // This notes-only UAT does not create recording connections, cancellations, grants or Start history.
      expect(exported.stop_summaries).toEqual([]);
      expect(exported.capture_grants).toEqual([]);
      expect(exported.capture_connections).toEqual([]);
      expect(exported.capture_start_cancellations).toEqual([]);
      expect(exported.capture_start_limits).toEqual([]);
      for (const [name, rows] of Object.entries(exported)) {
        if (
          ![
            "stop_summaries",
            "capture_grants",
            "capture_connections",
            "capture_start_cancellations",
            "capture_start_limits"
          ].includes(name)
        )
          expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.ownerUserId).toBe(UAT_ADMIN_ID);
      }
      expect(exported.records).toEqual([
        expect.objectContaining({
          id: meetingId,
          title,
          creationTitle: "Untitled meeting",
          personalNotes: "Synthetic current meeting note"
        })
      ]);
      expect(exported.note_writes.map((row) => row.personalNotes)).toEqual([
        "Synthetic retained meeting note",
        "Synthetic current meeting note"
      ]);
      expect(exported.transcript_batches[0]?.inputJson).toContain(OUTPUT_FIXTURE_TEXT);
      expect(exported.output_artifacts.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(exported.output_artifacts[2]?.artifactJson).toContain(OUTPUT_FIXTURE_MANUAL);
      expect(exported.action_candidates).toContainEqual(
        expect.objectContaining({
          reviewState: "accepted",
          acceptedTaskId: accepted.acceptedTaskId
        })
      );
      expect(exported.export_receipts).toHaveLength(2);
      await page.getByRole("button", { name: "Prepare a new export", exact: true }).click();
      console.log(
        "MEETINGS_ACCOUNT_EXPORT_UAT real Settings prepare/download; worker-built owner archive; 13 collections (recording and stop-summary collections empty in notes-only path); retained note revisions, transcript, generated/manual outputs, accepted Task reference and vault receipts"
      );
    });
    // Meeting deletion removes provenance, never independently accepted Tasks/private copies.
    expect((await page.request.delete(path)).status()).toBe(204);
    expect((await page.request.get(`${path}/outputs`)).status()).toBe(404);
    expect(await taskList()).toEqual([
      expect.objectContaining({ id: accepted.acceptedTaskId, title: changedTitle })
    ]);
    expect(await vaultEvidence(project, meetingId)).toEqual(finalFiles);
    meetingId = undefined;
    console.log(
      "MEETINGS_OUTPUT_UAT real UI/API; disclosed synthetic HTTP model; unsupported summary capability returns bounded code and actionable copy; admin AI provider link and Back preserve the SPA document and summary selection; capabilities restored before a fresh successful request; two bounded no-tool requests; exact source evidence; explicit owner-reviewed Task; acceptance replay and regeneration no duplicate/overwrite; immutable manual version; explicit create-only private copies; receipts separate write/index status; repeated save stable; independent Task and vault copies survive meeting deletion. Real Codex effective default rejected; official locked Claude default available with Generate enabled on the per-user runner before generation or login; HTTP default restored for all generated artifacts. No whole long-meeting/model-quality/audio proof."
    );
  } finally {
    try {
      if (meetingId)
        expect((await page.request.delete(`/api/meetings/records/${meetingId}`)).status()).toBe(
          204
        );
      expect((await page.request.put(pinPath, { data: { modelId: null } })).status()).toBe(200);
      if (pin.pinnedModelId || pin.pinnedProviderId)
        expect(
          (
            await page.request.put(pinPath, {
              data: { modelId: pin.pinnedModelId, providerId: pin.pinnedProviderId }
            })
          ).status()
        ).toBe(200);
      if (modelId)
        expect((await page.request.delete(`/api/ai/models/${modelId}`)).status()).toBe(200);
      if (providerId)
        expect((await page.request.post(`/api/ai/providers/${providerId}/revoke`)).status()).toBe(
          200
        );
      // Independent copies intentionally survive. The isolated provisioner destroys fixture DB/volumes.
    } finally {
      await exec("docker", ["rm", "--force", fixtureName]);
    }
  }
});
