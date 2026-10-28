import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb
} from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import type { RecordingNoteSource } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import { mutateVaultFiles, readVaultFile, VaultContextRunner } from "@moss/vault";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingContributionService } from "../../packages/notes/src/recording-contributions.js";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError
} from "../../packages/notes/src/managed-source-lifecycle.js";
import {
  NoteContributionConflictError,
  type RecordingContributionIndexPort
} from "../../packages/notes/src/contribution-state.js";
import { RecordingContributionRepository } from "../../packages/notes/src/contribution-repository.js";
import type { RecordingNoteCandidate, RecordingNoteReceipt } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app });
const workerDb = createDatabase({ connectionString: connectionStrings.worker });
const runner = new DataContextRunner(appDb);
const workerRunner = new DataContextRunner(workerDb);
const records = new MeetingRecordsRepository();
const preferences = new PreferencesRepository();
const repository = new RecordingContributionRepository();
const owner = { actorUserId: ids.userA };
const other = { actorUserId: ids.userB };
const current = new Map<string, { sourceVersion: number; side: "personal" | "work" }>();
const authority = {
  async assertExists(db: DataContextDb, source: { sourceModuleId: string; sourceId: string }) {
    if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId)))
      throw new ManagedSourceUnavailableError();
  },
  async readCurrent(db: DataContextDb, source: RecordingNoteSource) {
    await this.assertExists(db, source);
    const state = current.get(source.sourceId);
    if (!state) throw new ManagedSourceUnavailableError();
    return state;
  }
};
// This suite verifies owning Notes persistence and files. Index publication is a separate suite.
const index: RecordingContributionIndexPort = {
  async invalidateScoped() {},
  async enqueueScoped() {}
};
let root: string;
let workspace: string;
let vault: VaultContextRunner;
let service: RecordingContributionService;
function makeService(scopedRunner = runner, publicationIndex = index) {
  return new RecordingContributionService({
    runner: scopedRunner,
    lifecycle: new ManagedSourceLifecycle(scopedRunner, authority),
    privateVault: vault,
    authority,
    index: publicationIndex
  });
}
async function recording(
  side: "personal" | "work" = "work",
  access = owner
): Promise<RecordingNoteSource> {
  const { meeting } = await runner.withDataContext(access, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic contribution recording" })
  );
  current.set(meeting.id, { sourceVersion: 1, side });
  return { sourceModuleId: "meetings", sourceId: meeting.id, sourceVersion: 1, itemKey: "topic" };
}
async function candidate(displayPath: string, access = owner): Promise<RecordingNoteCandidate> {
  const found = (await service.inventory(access)).candidates.find(
    (entry) => entry.displayPath === displayPath
  );
  expect(found).toBeDefined();
  return found!;
}
async function apply(
  source: RecordingNoteSource,
  text = "Source fact",
  target?: RecordingNoteCandidate,
  access = owner
) {
  const review = await service.prepare(access, {
    kind: "apply",
    requestId: randomUUID(),
    source,
    text,
    destination: target
      ? { kind: "candidate", candidateId: target.id, candidateRevision: target.revision }
      : { kind: "fallback" }
  });
  return service.apply(access, { proposalId: review.id, acceptBinding: true });
}
async function read(receipt: RecordingNoteReceipt, access = owner): Promise<string> {
  if (receipt.destination.kind === "linked")
    return readFile(join(root, receipt.destination.displayPath), "utf8");
  return vault.withVaultContext(access, (ctx) =>
    readVaultFile(ctx, receipt.destination.displayPath)
  );
}

beforeAll(async () => {
  await resetFoundationDatabase();
});
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "moss-contributions-"));
  root = join(workspace, "linked");
  await mkdir(root);
  vault = new VaultContextRunner(join(workspace, "private"));
  vi.stubEnv("MOSS_NOTES_ROOTS", root);
  vi.stubEnv("JARVIS_NOTES_ROOTS", root);
  for (const access of [owner, other])
    await runner.withDataContext(access, (db) =>
      preferences.upsert(db, NOTES_SOURCE_PREFERENCE_KEY, root)
    );
  current.clear();
  service = makeService();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

describe("recording note contribution receipts", () => {
  it("keeps apply replay stable and requires explicit restore after undo", async () => {
    const source = await recording();
    const review = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text: "Durable fact",
      destination: { kind: "fallback" }
    });
    const saved = await service.apply(owner, { proposalId: review.id, acceptBinding: false });
    expect(saved.receipt.state).toBe("applied");
    const original = await read(saved.receipt);
    await service.apply(owner, { proposalId: review.id, acceptBinding: false });
    expect(await read(saved.receipt)).toBe(original);
    const undone = await service.undo(owner, {
      requestId: randomUUID(),
      receiptId: saved.receipt.id,
      expectedRevision: saved.receipt.revision
    });
    expect(undone.status).toBe("undone");
    expect(await read(undone.receipt)).not.toContain("Durable fact");
    await service.apply(owner, { proposalId: review.id, acceptBinding: false });
    expect(await read(undone.receipt)).not.toContain("Durable fact");
    const restored = await service.restore(owner, {
      requestId: randomUUID(),
      receiptId: undone.receipt.id,
      expectedRevision: undone.receipt.revision
    });
    expect(restored.status).toBe("applied");
    expect(await read(restored.receipt)).toBe(original);
  });

  it("requires explicit before/after consent to bind an existing unlabelled topic note", async () => {
    await writeFile(join(root, "topic.md"), "Existing owner text\n");
    const selected = await candidate("topic.md");
    const source = await recording();
    const review = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text: "New source text",
      destination: {
        kind: "candidate",
        candidateId: selected.id,
        candidateRevision: selected.revision
      }
    });
    expect(review.bindingReview).toMatchObject({
      before: "unlabelled",
      after: "work",
      excerpt: "Existing owner text\n"
    });
    await expect(
      service.apply(owner, { proposalId: review.id, acceptBinding: false })
    ).rejects.toThrow(NoteContributionConflictError);
    expect(await readFile(join(root, "topic.md"), "utf8")).toBe("Existing owner text\n");
    const saved = await service.apply(owner, { proposalId: review.id, acceptBinding: true });
    expect(await read(saved.receipt)).toContain("Existing owner text\n");
    expect(await read(saved.receipt)).toContain("New source text");
  });

  it("preserves unrelated edits through change, undo and restore", async () => {
    const source = await recording();
    const saved = await apply(source, "First source text");
    await runner.withDataContext(owner, (db) =>
      vault.withVaultContext(owner, (ctx) =>
        mutateVaultFiles(db, ctx, [saved.receipt.destination.displayPath], async ([file]) => ({
          changes: [{ path: file!.path, content: `Owner preface\n${file!.content}\nOwner ending` }],
          result: undefined
        }))
      )
    );
    const review = await service.prepare(owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: saved.receipt.id,
      expectedRevision: saved.receipt.revision,
      text: "Edited source text",
      destination: { kind: "fallback" }
    });
    const changed = await service.change(owner, { proposalId: review.id, acceptBinding: false });
    expect(await read(changed.receipt)).toContain("Owner preface\n");
    expect(await read(changed.receipt)).not.toContain("First source text");
    const undone = await service.undo(owner, {
      requestId: randomUUID(),
      receiptId: changed.receipt.id,
      expectedRevision: changed.receipt.revision
    });
    expect(await read(undone.receipt)).toContain("Owner ending");
    expect(await read(undone.receipt)).not.toContain("Edited source text");
    const restored = await service.restore(owner, {
      requestId: randomUUID(),
      receiptId: undone.receipt.id,
      expectedRevision: undone.receipt.revision
    });
    expect(await read(restored.receipt)).toContain("Owner ending");
    expect(await read(restored.receipt)).toContain("Edited source text");
  });

  it("moves one source between topic notes and preserves both notes' unrelated text", async () => {
    await writeFile(join(root, "old.md"), "Old owner text\n");
    await writeFile(join(root, "new.md"), "New owner text\n");
    const source = await recording();
    const saved = await apply(source, "Moving source", await candidate("old.md"));
    const destination = await candidate("new.md");
    const review = await service.prepare(owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: saved.receipt.id,
      expectedRevision: saved.receipt.revision,
      text: "Moved and reviewed",
      destination: {
        kind: "candidate",
        candidateId: destination.id,
        candidateRevision: destination.revision
      }
    });
    const moved = await service.change(owner, { proposalId: review.id, acceptBinding: true });
    expect(moved.receipt.state).toBe("applied");
    expect(moved.receipt.destination.displayPath).toBe("new.md");
    expect(await readFile(join(root, "old.md"), "utf8")).toContain("Old owner text");
    expect(await readFile(join(root, "old.md"), "utf8")).not.toContain("Moving source");
    expect(await readFile(join(root, "new.md"), "utf8")).toContain("New owner text");
    expect(await readFile(join(root, "new.md"), "utf8")).toContain("Moved and reviewed");
    await service.change(owner, { proposalId: review.id, acceptBinding: true });
    expect((await read(moved.receipt)).split("Moved and reviewed")).toHaveLength(2);
  });

  it("refuses stale reviewed bytes and retains the external edit", async () => {
    await writeFile(join(root, "topic.md"), "Reviewed text");
    const selected = await candidate("topic.md");
    const source = await recording();
    const review = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text: "Contribution",
      destination: {
        kind: "candidate",
        candidateId: selected.id,
        candidateRevision: selected.revision
      }
    });
    await writeFile(join(root, "topic.md"), "Newer external text");
    await expect(
      service.apply(owner, { proposalId: review.id, acceptBinding: true })
    ).rejects.toThrow(NoteContributionConflictError);
    expect(await readFile(join(root, "topic.md"), "utf8")).toBe("Newer external text");
  });

  it("does not undo an externally edited source block", async () => {
    const source = await recording();
    const saved = await apply(source, "Original source text");
    await runner.withDataContext(owner, (db) =>
      vault.withVaultContext(owner, (ctx) =>
        mutateVaultFiles(db, ctx, [saved.receipt.destination.displayPath], async ([file]) => ({
          changes: [
            {
              path: file!.path,
              content: file!.content!.replace("Original source text", "Owner corrected text")
            }
          ],
          result: undefined
        }))
      )
    );
    await expect(
      service.undo(owner, {
        requestId: randomUUID(),
        receiptId: saved.receipt.id,
        expectedRevision: saved.receipt.revision
      })
    ).rejects.toThrow(NoteContributionConflictError);
    expect((await service.inspect(owner, source))?.state).toBe("conflict");
    expect(await read(saved.receipt)).toContain("Owner corrected text");
  });

  it("rejects cross-side writes through an alias of the same canonical topic", async () => {
    await writeFile(join(root, "topic.md"), "");
    await symlink(".", join(root, "alias-root"));
    const personal = await recording("personal");
    const saved = await apply(personal, "Personal source", await candidate("topic.md"));
    const work = await recording("work");
    // Resolve the same allowed root through a different configured alias.
    await runner.withDataContext(owner, (db) =>
      preferences.upsert(db, NOTES_SOURCE_PREFERENCE_KEY, join(root, "alias-root"))
    );
    const selected = await candidate("topic.md");
    await expect(apply(work, "Work source", selected)).rejects.toThrow(
      NoteContributionConflictError
    );
    expect(await read(saved.receipt)).not.toContain("Work source");
    const id = saved.receipt.destination.id;
    expect(await runner.withDataContext(owner, (db) => repository.binding(db, id))).toMatchObject({
      side: "personal"
    });
  });

  it("hides a foreign claim before attempting to decode its preview", async () => {
    await writeFile(join(root, "topic.md"), "");
    const source = await recording();
    const saved = await apply(source, "Owner source", await candidate("topic.md"));
    await writeFile(join(root, "topic.md"), Buffer.from([0xff, 0xfe]));
    expect(
      (await service.inventory(other)).candidates.some((entry) => entry.displayPath === "topic.md")
    ).toBe(false);
    expect(
      await workerRunner.withDataContext(other, (db) =>
        repository.available(db, saved.receipt.destination.id)
      )
    ).toBe(false);
    expect(
      await workerRunner.withDataContext(other, (db) =>
        repository.binding(db, saved.receipt.destination.id)
      )
    ).toBeNull();
  });

  it.each(["app", "worker"] as const)(
    "keeps %s receipt, proposal and operation rows owner only, including administrators",
    async (role) => {
      const source = await recording();
      const review = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Private source",
        destination: { kind: "fallback" }
      });
      const saved = await service.apply(owner, { proposalId: review.id, acceptBinding: false });
      const scoped = role === "app" ? runner : workerRunner;
      for (const actorUserId of [ids.userB, ids.adminUser]) {
        await scoped.withDataContext({ actorUserId }, async (db) => {
          expect(await repository.receipt(db, saved.receipt.id)).toBeNull();
          expect(await repository.proposal(db, review.id)).toBeNull();
          expect(await repository.operation(db, review.id)).toBeNull();
        });
      }
      expect(
        await scoped.withDataContext(owner, (db) => repository.receipt(db, saved.receipt.id))
      ).toMatchObject({ text: "Private source" });
    }
  );

  it("rejects an old proposal after a source generation changes, even when side returns unchanged", async () => {
    const source = await recording();
    const review = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text: "Old proposal",
      destination: { kind: "fallback" }
    });
    const lifecycle = new ManagedSourceLifecycle(runner, authority);
    const snapshot = await lifecycle.registerSource(owner, {
      ownerUserId: owner.actorUserId,
      sourceModuleId: source.sourceModuleId,
      sourceId: source.sourceId
    });
    await lifecycle.advanceSource(owner, snapshot, async () => undefined);
    await expect(
      service.apply(owner, { proposalId: review.id, acceptBinding: false })
    ).rejects.toThrow();
    expect(await service.inspect(owner, source)).toBeNull();
  });

  it("does not restore a twenty-first active contribution after another item fills its place", async () => {
    const source = await recording();
    const initial = await apply(source, "First item");
    const undone = await service.undo(owner, {
      requestId: randomUUID(),
      receiptId: initial.receipt.id,
      expectedRevision: initial.receipt.revision
    });
    for (let offset = 0; offset < 20; offset++)
      await apply({ ...source, itemKey: `item-${offset}` }, `Fact ${offset}`);
    await expect(
      service.restore(owner, {
        requestId: randomUUID(),
        receiptId: undone.receipt.id,
        expectedRevision: undone.receipt.revision
      })
    ).rejects.toThrow(NoteContributionConflictError);
    expect((await service.inspect(owner, source))?.state).toBe("undone");
    expect(await read(undone.receipt)).not.toContain("First item");
  });

  it("serializes competing proposals for the final item slot", async () => {
    const source = await recording();
    for (let offset = 0; offset < 19; offset++)
      await apply({ ...source, itemKey: `item-${offset}` }, `Fact ${offset}`);
    const proposals = await Promise.all(
      ["left", "right"].map((itemKey) =>
        service.prepare(owner, {
          kind: "apply",
          requestId: randomUUID(),
          source: { ...source, itemKey },
          text: itemKey,
          destination: { kind: "fallback" }
        })
      )
    );
    const results = await Promise.allSettled(
      proposals.map((proposal) =>
        service.apply(owner, { proposalId: proposal.id, acceptBinding: false })
      )
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const count = await runner.withDataContext(owner, (db) =>
      repository.activeItemCount(db, source)
    );
    expect(count).toBe(20);
  });

  it("preserves an unrelated edit committed after reservation", async () => {
    await writeFile(join(root, "topic.md"), "Reviewed owner text\n");
    let afterCommit: (() => Promise<void>) | null = null;
    class InterleavedRunner extends DataContextRunner {
      override async withDataContext<T>(
        access: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ): Promise<T> {
        const result = await super.withDataContext(access, work);
        const action = afterCommit;
        afterCommit = null;
        await action?.();
        return result;
      }
    }
    service = makeService(new InterleavedRunner(appDb), {
      ...index,
      async invalidateScoped() {
        afterCommit = () =>
          writeFile(join(root, "topic.md"), "Reviewed owner text\nLater unrelated edit\n");
      }
    });
    const saved = await apply(await recording(), "Reserved source", await candidate("topic.md"));
    expect(saved.receipt.state).toBe("applied");
    expect(await read(saved.receipt)).toContain("Later unrelated edit");
    expect(await read(saved.receipt)).toContain("Reserved source");
  });

  it("keeps a target edit after the remove leg of a committed move", async () => {
    await writeFile(join(root, "old.md"), "Old owner text\n");
    await writeFile(join(root, "new.md"), "New owner text\n");
    const saved = await apply(await recording(), "Moving source", await candidate("old.md"));
    let moved = false;
    let edited = false;
    class InterleavedRunner extends DataContextRunner {
      override async withDataContext<T>(
        access: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ): Promise<T> {
        const result = await super.withDataContext(access, work);
        if (
          moved &&
          !edited &&
          !(await readFile(join(root, "old.md"), "utf8")).includes("Moving source")
        ) {
          edited = true;
          await writeFile(join(root, "new.md"), "New owner text\nLater target edit\n");
        }
        return result;
      }
    }
    service = makeService(new InterleavedRunner(appDb));
    const target = await candidate("new.md");
    const review = await service.prepare(owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: saved.receipt.id,
      expectedRevision: saved.receipt.revision,
      text: "Moved source",
      destination: { kind: "candidate", candidateId: target.id, candidateRevision: target.revision }
    });
    moved = true;
    const result = await service.change(owner, { proposalId: review.id, acceptBinding: true });
    expect(edited).toBe(true);
    expect(result.receipt.state).toBe("applied");
    expect(await read(result.receipt)).toContain("Later target edit");
    expect(await read(result.receipt)).toContain("Moved source");
    expect(await readFile(join(root, "old.md"), "utf8")).toContain("Old owner text");
  });

  it("conflicts on a changed source block and resumes after exact repair", async () => {
    const saved = await apply(await recording(), "Original source");
    const original = await read(saved.receipt);
    let afterCommit: (() => Promise<void>) | null = null;
    class InterleavedRunner extends DataContextRunner {
      override async withDataContext<T>(
        access: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ): Promise<T> {
        const result = await super.withDataContext(access, work);
        const action = afterCommit;
        afterCommit = null;
        await action?.();
        return result;
      }
    }
    const path = join(
      workspace,
      "private",
      owner.actorUserId,
      saved.receipt.destination.displayPath
    );
    service = makeService(new InterleavedRunner(appDb), {
      ...index,
      async invalidateScoped() {
        afterCommit = () =>
          writeFile(path, original.replace("Original source", "External source edit"));
      }
    });
    const review = await service.prepare(owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: saved.receipt.id,
      expectedRevision: saved.receipt.revision,
      text: "Reviewed change",
      destination: { kind: "fallback" }
    });
    const conflicted = await service.change(owner, { proposalId: review.id, acceptBinding: false });
    expect(conflicted.status).toBe("conflict");
    expect(await read(conflicted.receipt)).toContain("External source edit");
    await writeFile(path, original + "\nUnrelated repair note\n");
    const resumed = await service.change(owner, { proposalId: review.id, acceptBinding: false });
    expect(resumed.receipt.state).toBe("applied");
    expect(await read(resumed.receipt)).toContain("Reviewed change");
    expect(await read(resumed.receipt)).toContain("Unrelated repair note");
  });

  it("recovers a crash after file publication but before receipt commit without appending twice", async () => {
    let failAfterPublish = false;
    let failOnce = true;
    class FailingRunner extends DataContextRunner {
      override withDataContext<T>(
        access: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ): Promise<T> {
        return super.withDataContext(access, async (db) => {
          const result = await work(db);
          if (failAfterPublish) {
            failAfterPublish = false;
            throw new Error("simulated post-file pre-commit death");
          }
          return result;
        });
      }
    }
    const crashRunner = new FailingRunner(appDb);
    service = makeService(crashRunner, {
      ...index,
      async enqueueScoped() {
        if (failOnce) {
          failOnce = false;
          failAfterPublish = true;
        }
      }
    });
    const source = await recording();
    const review = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text: "One durable source",
      destination: { kind: "fallback" }
    });
    await expect(
      service.apply(owner, { proposalId: review.id, acceptBinding: false })
    ).rejects.toThrow("pre-commit death");
    const pending = await service.inspect(owner, source);
    expect(pending?.state).toBe("pending");
    expect(await read(pending!)).toContain("One durable source");
    const recovered = await service.apply(owner, { proposalId: review.id, acceptBinding: false });
    expect(recovered.receipt.state).toBe("applied");
    expect((await read(recovered.receipt)).split("One durable source")).toHaveLength(2);
  });
});
