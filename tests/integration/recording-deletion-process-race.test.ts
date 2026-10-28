import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabase, DataContextRunner } from "@moss/db";
import { RecordingContributionService } from "@moss/notes";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import { mutateVaultFiles, VaultContextRunner } from "@moss/vault";
import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { connectionStrings } from "./test-database.js";

const fixture = useRecordingMemoryFixture();
let workspace: string | undefined;
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  vi.unstubAllEnvs();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

it("serializes two cleanup processes and rejects a concurrent filing retry without recreating content", async () => {
  const state = await fixture.setup("app");
  const source = await state.create();
  workspace = await mkdtemp(join(tmpdir(), "recording-cleanup-processes-"));
  const linked = join(workspace, "linked");
  const privateRoot = join(workspace, "private");
  await mkdir(linked);
  const vault = new VaultContextRunner(privateRoot);
  vi.stubEnv("MOSS_NOTES_ROOTS", linked);
  vi.stubEnv("JARVIS_NOTES_ROOTS", linked);
  vi.stubEnv("MOSS_VAULT_ROOT", privateRoot);
  vi.stubEnv("JARVIS_VAULT_ROOT", privateRoot);
  await writeFile(join(linked, "topic.md"), "Owner text\n");
  await state.runner.withDataContext(state.owner, (db) =>
    new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
  );
  const notes = new RecordingContributionService({
    runner: state.runner,
    lifecycle: state.lifecycle,
    privateVault: vault,
    authority: {
      async readCurrent() {
        return { side: "work", sourceVersion: 1 };
      }
    },
    index: { async invalidateScoped() {}, async enqueueScoped() {} }
  });
  const candidate = (await notes.inventory(state.owner)).candidates.find(
    (row) => row.displayPath === "topic.md"
  )!;
  const destination = {
    kind: "candidate" as const,
    candidateId: candidate.id,
    candidateRevision: candidate.revision
  };
  const proposal = await notes.prepare(state.owner, {
    kind: "apply",
    requestId: randomUUID(),
    source,
    destination,
    text: "Source-owned text"
  });
  await notes.apply(state.owner, { proposalId: proposal.id, acceptBinding: true });
  const current = (await notes.inventory(state.owner)).candidates.find(
    (row) => row.displayPath === "topic.md"
  )!;
  const retry = await notes.prepare(state.owner, {
    kind: "apply",
    requestId: randomUUID(),
    source: { ...source, itemKey: "late" },
    destination: { ...destination, candidateRevision: current.revision },
    text: "Late retry must never appear"
  });
  await writeFile(
    join(linked, "topic.md"),
    (await readFile(join(linked, "topic.md"), "utf8")) + "Later owner text\n"
  );
  const memory = await state.service.prepare(state.owner, {
    kind: "apply",
    requestId: randomUUID(),
    source,
    text: "Durable source memory"
  });
  const receipt = (await state.service.apply(state.owner, { proposalId: memory.id })).receipt;

  function start(mode: "delete" | "retry") {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child);
    let output = "";
    let errors = "";
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const result = new Promise<{ code: number | null; output: string; errors: string }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output, errors }));
      }
    );
    child.stdout.setEncoding("utf8").on("data", (text) => {
      output += text;
      if (output.includes("STARTED\n")) notifyStarted();
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      errors += text;
    });
    child.stdin.end(`
      import { createDatabase, DataContextRunner, getMossDatabaseUrls } from '@moss/db';
      import { MeetingDeletionService, MeetingRecordsRepository, MeetingCleanupError } from '@moss/meetings';
      import { ManagedSourceLifecycle, RecordingContributionService, ManagedSourceFencedError, NoteContributionUnavailableError } from '@moss/notes';
      import { createMeetingDeletionPort } from '@moss/module-registry';
      import { createPgBossClient } from '@moss/jobs';
      import { VaultContextRunner } from '@moss/vault';
      const db = createDatabase({connectionString: getMossDatabaseUrls().app});
      const runner = new DataContextRunner(db);
      const owner = ${JSON.stringify(state.owner)};
      const vault = new VaultContextRunner(${JSON.stringify(privateRoot)});
      const boss = createPgBossClient(getMossDatabaseUrls().app);
      try {
        if (${JSON.stringify(mode)} === 'delete') {
          await boss.start();
          console.log('STARTED');
          const service = new MeetingDeletionService({dataContext: runner,
            cleanup: createMeetingDeletionPort({dataContext: runner,privateVault: vault,boss}),async beforeRemove(){}});
          try {
            await service.remove(owner,${JSON.stringify(source.sourceId)});
            console.log('DELETED');
          } catch (error) {
            if (!(error instanceof MeetingCleanupError) || error.code !== 'meeting_cleanup_pending') throw error;
            console.log('PENDING');
          }
        } else {
          const records = new MeetingRecordsRepository();
          const lifecycle = new ManagedSourceLifecycle(runner,{async assertExists(db,key){if(!await records.get(db,key.sourceId)) throw new NoteContributionUnavailableError();}});
          const service = new RecordingContributionService({runner,lifecycle,privateVault: vault,
            authority:{async readCurrent(){return {side:'work',sourceVersion:1};}},
            index:{async invalidateScoped(){},async enqueueScoped(){}}});
          console.log('STARTED');
          try {
            await service.apply(owner,{proposalId:${JSON.stringify(retry.id)},acceptBinding:true});
            throw new Error('Stale filing retry was admitted');
          } catch(error) {
            if (!(error instanceof ManagedSourceFencedError || error instanceof NoteContributionUnavailableError)) throw error;
            console.log('RETRY_REJECTED');
          }
        }
      } finally {await boss.stop({graceful:false});await db.destroy();}
    `);
    return {
      started: Promise.race([
        started,
        result.then((value) => {
          if (!value.output.includes("STARTED\n"))
            throw new Error(value.errors || "Cleanup child exited before starting");
        })
      ]),
      result
    };
  }

  const blockerDb = createDatabase({ connectionString: connectionStrings.app });
  const blocker = new DataContextRunner(blockerDb);
  let locked!: () => void;
  let release!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = vault.withVaultContextAt(state.owner, linked, [linked], (ctx) =>
    blocker.withDataContext(state.owner, (db) =>
      mutateVaultFiles(db, ctx, ["topic.md"], async () => {
        locked();
        await released;
        return { changes: [], result: undefined };
      })
    )
  );
  try {
    await lockReady;
    const first = start("delete");
    await first.started;
    await expect
      .poll(
        () =>
          state.runner.withDataContext(
            state.owner,
            async (db) =>
              (
                await sql<{
                  state: string;
                }>`select state from app.notes_managed_sources where owner_user_id = ${state.owner.actorUserId}::uuid and source_id = ${source.sourceId}::uuid`.execute(
                  db.db
                )
              ).rows[0]?.state
          ),
        { timeout: 15000 }
      )
      .toBe("deleting");
    const second = start("delete");
    const filing = start("retry");
    await Promise.all([second.started, filing.started]);
    release();
    await held;
    const [a, b, c] = await Promise.all([first.result, second.result, filing.result]);
    expect(a, a.errors).toMatchObject({ code: 0 });
    expect(b, b.errors).toMatchObject({ code: 0 });
    expect(c, c.errors).toMatchObject({ code: 0 });
    expect(a.output).toMatch(/DELETED|PENDING/);
    expect(b.output).toMatch(/DELETED|PENDING/);
    expect(a.output + b.output).toContain("DELETED");
    expect(c.output).toContain("RETRY_REJECTED");
    const idempotent = await start("delete").result;
    expect(idempotent, idempotent.errors).toMatchObject({ code: 0 });
    expect(idempotent.output).toContain("DELETED");
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe("Owner text\nLater owner text\n");
    await state.runner.withDataContext(state.owner, async (db) => {
      expect(await fixture.records.get(db, source.sourceId)).toBeNull();
      expect(
        (
          await sql`select id from app.memory_facts where id = ${receipt.fact!.id}::uuid`.execute(
            db.db
          )
        ).rows
      ).toEqual([]);
      expect(
        (
          await sql`select receipt_id from app.notes_recording_contributions where source_id = ${source.sourceId}::uuid`.execute(
            db.db
          )
        ).rows
      ).toEqual([]);
    });
  } finally {
    release();
    await held;
    await blockerDb.destroy();
  }
}, 90000);
