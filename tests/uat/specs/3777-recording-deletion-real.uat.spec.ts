import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { MeetingOutputArtifact, RecordingMemoryReceipt } from "@moss/shared";
import { buildUatComposeArgs } from "../compose-args.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const factText = "Fernworld uses shared wind for grass and birds.";
const contributionText = "The shared wind drives grass and birds.";

/** Task6 supplies filing controls. This setup uses public production Notes/Memory/Vault
 * services as the ordinary app role; it supplies no SQL rows or intercepted responses.
 * The browser exercises real classification, record deletion and Saved memories. */
function sourceState(
  sourceId: string,
  action: "seed" | "change" | "repair" | "read"
): { content: string; memory?: RecordingMemoryReceipt } {
  const output = execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "exec",
      "-T",
      "--user",
      "1000:1000",
      "jarv1s",
      "node",
      "--import",
      "tsx",
      "--input-type=module"
    ]),
    {
      encoding: "utf8",
      timeout: 120000,
      input: String.raw`
    import { randomUUID } from 'node:crypto';
    import { createDatabase, DataContextRunner, getMossDatabaseUrls, readScopedActorUserId } from '@moss/db';
    import { RecordingMetadataRepository, MeetingRecordsRepository } from '@moss/meetings';
    import { RecordingMemoryService, MemoryRepository, VAULT_INGEST_NUDGE_QUEUE } from '@moss/memory';
    import { ManagedSourceLifecycle, ManagedSourceUnavailableError, RecordingContributionService, NOTES_SYNC_QUEUE } from '@moss/notes';
    import { createPgBossClient, scopedJobDatabase, sendJob } from '@moss/jobs';
    import { VaultContextRunner, getVaultBaseDir, mutateVaultFiles, readVaultFile } from '@moss/vault';
    import { createRecordingFactAuthority, createRuntimeEmbeddingProvider } from '@moss/module-registry';
    const db = createDatabase({connectionString: getMossDatabaseUrls().app});
    const runner = new DataContextRunner(db);
    const owner = { actorUserId: ${JSON.stringify(UAT_ADMIN_ID)} };
    const vault = new VaultContextRunner(getVaultBaseDir());
    const path = 'uat/source-cleanup.md';
    const source = {sourceModuleId:'meetings',sourceId:${JSON.stringify(sourceId)},sourceVersion:1,itemKey:'uat-cleanup'};
    const action = ${JSON.stringify(action)};
    const boss = createPgBossClient(getMossDatabaseUrls().app);
    let memory;
    try {
      if(action === 'seed') {
        await boss.start();
        await vault.withVaultContext(owner, ctx => runner.withDataContext(owner, db =>
          mutateVaultFiles(db,ctx,[path],async()=>({changes:[{path,content:'Owner text\n'}],result:undefined}))));
        const metadata = new RecordingMetadataRepository();
        const records = new MeetingRecordsRepository();
        const lifecycle = new ManagedSourceLifecycle(runner,{async assertExists(db,key){
          if(!await records.get(db,key.sourceId)) throw new ManagedSourceUnavailableError();
        }});
        const notes = new RecordingContributionService({runner,lifecycle,privateVault:vault,
          authority:{async readCurrent(db,source){
            const current = await metadata.get(db,source.sourceId);
            if(!current?.side || !current.outputVersion) throw new ManagedSourceUnavailableError();
            return {side:current.side,sourceVersion:current.outputVersion};
          }},
          index:{async invalidateScoped(db,ids){await new MemoryRepository().invalidateManagedDestinations(db,owner.actorUserId,ids);},
            async enqueueScoped(db,destinations){for(const destination of destinations){
              const actorUserId = await readScopedActorUserId(db);
              await sendJob(boss,destination.kind === 'private' ? VAULT_INGEST_NUDGE_QUEUE : NOTES_SYNC_QUEUE,
                destination.kind === 'private' ? {actorUserId,sourcePath:destination.path,op:'upsert'} : {actorUserId},
                {db:scopedJobDatabase(db)});
            }}}
        });
        const candidate = (await notes.inventory(owner)).candidates.find(row=>row.displayPath===path);
        if(!candidate) throw new Error('Real configured note destination unavailable');
        const proposed = await notes.prepare(owner,{kind:'apply',requestId:randomUUID(),source,
          text:${JSON.stringify(contributionText)},destination:{kind:'candidate',candidateId:candidate.id,candidateRevision:candidate.revision}});
        const note = await notes.apply(owner,{proposalId:proposed.id,acceptBinding:true});
        if(note.receipt.state !== 'applied' || note.receipt.side !== 'personal') throw new Error('Note did not apply');
        const provider = await runner.withDataContext(owner,createRuntimeEmbeddingProvider);
        const service = new RecordingMemoryService(runner,createRecordingFactAuthority(runner),provider);
        const proposal = await service.prepare(owner,{kind:'apply',requestId:randomUUID(),source,text:${JSON.stringify(factText)}});
        memory = (await service.apply(owner,{proposalId:proposal.id})).receipt;
      } else if(action !== 'read') {
        await vault.withVaultContext(owner,ctx=>runner.withDataContext(owner,db=>
          mutateVaultFiles(db,ctx,[path],async([file])=>({changes:[{path,content:action==='change'
            ? file.content.replace(${JSON.stringify(contributionText)},'Owner changed this contribution.')
            : file.content.replace('Owner changed this contribution.',${JSON.stringify(contributionText)})+'Later owner text\n'}],result:undefined}))));
      }
      const content = await vault.withVaultContext(owner,ctx=>readVaultFile(ctx,path));
      console.log('RECORDING_CLEANUP_DATA='+JSON.stringify({content,memory}));
    } finally {await boss.stop({graceful:false});await db.destroy();}
    process.exit(0);
  `
    }
  );
  const receipt = output.split("\n").find((line) => line.startsWith("RECORDING_CLEANUP_DATA="));
  if (!receipt) throw new Error("Production source setup did not return current content");
  return JSON.parse(receipt.slice("RECORDING_CLEANUP_DATA=".length));
}

async function settings(page: Page) {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}

test("recording deletion preserves edited notes until an explicit repaired retry (#3777)", async ({
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
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: /^(Browse…|Change folder)$/ }).click();
  const root = `/data/vaults/${UAT_ADMIN_ID}`;
  await page.locator(".vroot").filter({ hasText: root }).click();
  await page.getByRole("button", { name: "Use this folder", exact: true }).click();
  await expect(page.locator(".vault__path")).toHaveText(root);
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
  const seeded = sourceState(meetingId, "seed");
  expect(seeded.memory).toMatchObject({
    side: "personal",
    state: "applied",
    fact: { text: factText }
  });
  expect(seeded.content).toContain(contributionText);
  const edited = sourceState(meetingId, "change");
  expect(edited.content).toContain("Owner changed this contribution.");
  await page.getByRole("button", { name: "Meeting actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete meeting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this meeting?", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/meetings/records/${meetingId}`) &&
      response.request().method() === "DELETE"
  );
  await dialog.getByRole("button", { name: "Permanently delete meeting", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("A note from this recording changed");
  expect(sourceState(meetingId, "read").content).toBe(edited.content);
  expect((await page.request.get(`/api/meetings/records/${meetingId}`)).status()).toBe(200);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  sourceState(meetingId, "repair");
  await page.getByRole("button", { name: "Meeting actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete meeting", exact: true }).click();
  const removed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/meetings/records/${meetingId}`) &&
      response.request().method() === "DELETE"
  );
  await dialog.getByRole("button", { name: "Permanently delete meeting", exact: true }).click();
  expect((await removed).status()).toBe(204);
  await expect(page).toHaveURL((url) => url.pathname === "/meetings" && !url.search);
  expect((await page.request.get(`/api/meetings/records/${meetingId}`)).status()).toBe(404);
  expect(sourceState(meetingId, "read").content).toBe("Owner text\nLater owner text\n");
  await settings(page);
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.getByRole("button", { name: "Memory & context", exact: true }).click();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  const row = page.locator(".memdash-item").filter({ hasText: factText });
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Saved memories", exact: true }).click();
  await expect(row).toHaveCount(0);
  console.log(
    `RECORDING_DELETION_REAL_UAT model=${model.id} realClassification=true productionSourceServices=true conflictRetains=true repairRetry=true unrelatedBytesRetained=true memoryRemovedReload=true screenshots=off`
  );
});
