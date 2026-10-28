import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { MeetingOutputArtifact, RecordingMemoryReceipt } from "@moss/shared";
import { buildUatComposeArgs } from "../compose-args.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

/** Filing controls land in task 6. Set up their state through the public owning service.
 * This executes unchanged production code as the ordinary app role, without SQL fixtures or
 * intercepted requests. The browser then exercises the registered Settings write/export paths. */
function recordingMemory(sourceId: string, text: string): RecordingMemoryReceipt {
  const output = execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "exec",
      "-T",
      "jarv1s",
      "node",
      "--import",
      "tsx",
      "--input-type=module"
    ]),
    {
      encoding: "utf8",
      timeout: 120000,
      input: `
      import { randomUUID } from 'node:crypto';
      import { createDatabase, DataContextRunner, getMossDatabaseUrls } from '@moss/db';
      import { RecordingMemoryService } from '@moss/memory';
      import { createRecordingFactAuthority, createRuntimeEmbeddingProvider } from '@moss/module-registry';
      const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
      try {
        const runner = new DataContextRunner(db);
        const owner = { actorUserId: ${JSON.stringify(UAT_ADMIN_ID)} };
        const provider = await runner.withDataContext(owner, createRuntimeEmbeddingProvider);
        console.log('RECORDING_MEMORY_STAGE=provider-ready');
        const service = new RecordingMemoryService(runner, createRecordingFactAuthority(runner), provider);
        const proposal = await service.prepare(owner, { kind: 'apply', requestId: randomUUID(),
          source: { sourceModuleId: 'meetings', sourceId: ${JSON.stringify(sourceId)}, sourceVersion: 1, itemKey: 'uat-memory' },
          text: ${JSON.stringify(text)} });
        console.log('RECORDING_MEMORY_STAGE=proposal-ready');
        const result = await service.apply(owner, { proposalId: proposal.id });
        console.log('RECORDING_MEMORY_RECEIPT=' + JSON.stringify(result.receipt));
      } finally { await db.destroy(); }
      // This one-shot harness has completed its transaction. Local embedding workers can
      // retain native handles; terminate this helper after flushing its receipt and DB pool.
      process.exit(0);
    `
    }
  );
  const receipt = output.split("\n").find((line) => line.startsWith("RECORDING_MEMORY_RECEIPT="));
  if (!receipt) throw new Error("Owning Memory service did not produce a receipt");
  return JSON.parse(receipt.slice("RECORDING_MEMORY_RECEIPT=".length)) as RecordingMemoryReceipt;
}

async function settings(page: Page) {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}

test("recording-derived memory participates in real Settings pin, export and forget (#3777)", async ({
  page
}) => {
  test.setTimeout(600000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await settings(page);
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingCodex(requireUatProjectName());
  await page.getByRole("link", { name: "Meetings", exact: true }).click();
  await page.getByRole("button", { name: "Add recording", exact: true }).click();
  const entry = page.getByRole("region", { name: "Add recording", exact: true });
  await entry
    .getByLabel("Transcript", { exact: true })
    .fill(
      "This is a personal hobby idea for my game Fernworld. I am prototyping wind-driven grass and birds that react to the same wind. It is a free-time project, unrelated to my job. I want to remember that the wind simulation should be shared by grass and birds."
    );
  const added = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/meetings/manual-transcripts") &&
      response.request().method() === "POST"
  );
  await entry.getByRole("button", { name: "Add recording", exact: true }).click();
  const addedResponse = await added;
  expect(addedResponse.status()).toBe(201);
  const { meetingId } = (await addedResponse.json()) as { meetingId: string };
  await expect
    .poll(
      async () => {
        const result = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
        expect(result.status()).toBe(200);
        const value = await result.json();
        if (value.automaticSummary?.status === "failed")
          throw new Error(`Analysis failed: ${value.automaticSummary.code}`);
        return value.headVersion;
      },
      { timeout: 150000 }
    )
    .toBe(1);
  const outputs = await page.request.get(`/api/meetings/records/${meetingId}/outputs`);
  const artifact = (await outputs.json()).artifacts[0] as MeetingOutputArtifact;
  expect(JSON.parse(artifact.modelRoute).modelId).toBe(model.id);
  expect(artifact.content.recording?.side).toBe("personal");
  await expect(page.getByText("Personal", { exact: true })).toBeVisible();
  const factText = "Fernworld uses shared wind for grass and birds.";
  const receipt = recordingMemory(meetingId, factText);
  expect(receipt).toMatchObject({ side: "personal", state: "applied", fact: { text: factText } });
  await settings(page);
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.getByRole("button", { name: "Memory & context", exact: true }).click();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  const row = page.locator(".memdash-item").filter({ hasText: factText });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").first().click();
  const pinned = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/memory/graph/facts/${receipt.fact!.id}`) &&
      response.request().method() === "PATCH"
  );
  await row.getByRole("button", { name: "Pin", exact: true }).click();
  expect((await pinned).status()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  await row.getByRole("button").first().click();
  await expect(row.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account & preferences", exact: true }).click();
  await page.getByRole("button", { name: "Prepare export", exact: true }).click();
  const download = page.getByRole("link", { name: "Download", exact: true });
  await expect(download).toBeVisible({ timeout: 120000 });
  const received = page.waitForEvent("download");
  await download.click();
  const file = await received;
  expect(await file.failure()).toBeNull();
  const archivePath = await file.path();
  expect(archivePath).toBeTruthy();
  const archive = JSON.parse(await readFile(archivePath!, "utf8"));
  expect(archive.sections.memory.recordingHistory.receipts).toContainEqual(
    expect.objectContaining({
      receiptId: receipt.id,
      factId: receipt.fact!.id,
      sourceId: meetingId,
      side: "personal",
      state: "applied"
    })
  );
  expect(archive.sections.memory.recordingHistory.factVersions).toContainEqual(
    expect.objectContaining({
      factId: receipt.fact!.id,
      side: "personal",
      state: "current"
    })
  );
  expect(archive.sections.memory.recordingHistory.proposals).toHaveLength(1);
  expect(archive.sections.memory.graphFacts).toContainEqual(
    expect.objectContaining({
      id: receipt.fact!.id,
      recordingSide: "personal",
      objectText: factText,
      pinned: true
    })
  );
  await page.getByRole("button", { name: "Memory & context", exact: true }).click();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  await row.getByRole("button").first().click();
  await row.getByRole("button", { name: "Forget", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Forget this memory?", exact: true });
  await expect(dialog).toContainText(factText);
  const forgotten = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/memory/graph/facts/${receipt.fact!.id}`) &&
      response.request().method() === "DELETE"
  );
  await dialog.getByRole("button", { name: "Forget", exact: true }).click();
  expect((await forgotten).status()).toBe(204);
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  await expect(row).toHaveCount(0);
  console.log(
    `RECORDING_MEMORY_REAL_UAT model=${model.id} realClassification=true productionSourceService=true pinReload=true populatedExport=true forgetReload=true screenshots=off`
  );
});
