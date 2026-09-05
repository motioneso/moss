import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { readVaultFile, VaultContextRunner, writeVaultFile } from "@moss/vault";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";

import { resetFoundationDatabase, ids } from "../../../../tests/integration/test-database.js";
import {
  CanonicalNoteNotFoundError,
  PeopleNotesFolderUnavailableError,
  PeopleNotesService
} from "../notes-service.js";
import { PeopleRepository } from "../repository.js";

const connectionStrings = getMossDatabaseUrls();
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let vaultRoot: string;
let vaultRunner: VaultContextRunner;
// #2268 — a People folder is now an absolute folder inside the server's allowed notes roots, and
// the service works inside a context rooted at that folder, so note paths are relative to it.
let notesRoot: string;

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(db as never);
  vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-people-notes-"));
  vaultRunner = new VaultContextRunner(vaultRoot);
  notesRoot = await mkdtemp(join(tmpdir(), "jarvis-people-notes-root-"));
});

afterAll(async () => {
  await db?.destroy();
  if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  if (notesRoot) await rm(notesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetFoundationDatabase();
});

function peopleFolder(name: string): string {
  return join(notesRoot, name);
}

/** Creates a People folder inside the allowed notes root and opens a context rooted there. */
async function withPeopleFolder<T>(
  name: string,
  work: Parameters<VaultContextRunner["withVaultContextAt"]>[3]
) {
  const folder = peopleFolder(name);
  await mkdir(folder, { recursive: true });
  return vaultRunner.withVaultContextAt(
    { actorUserId: ids.userA, requestId: "people-notes" },
    folder,
    [notesRoot],
    work
  ) as Promise<T>;
}

describe("PeopleNotesService", () => {
  it("reports mixed refresh counts and rejects unavailable or absolute folders", async () => {
    const service = new PeopleNotesService();

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-mixed" },
      async (sdb) => {
        // A folder saved before #2268 was a relative name; only an absolute folder saves now.
        await expect(
          service.putSettings(sdb, ids.userA, { folder: "People" })
        ).rejects.toBeInstanceOf(PeopleNotesFolderUnavailableError);
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleMixed") });
      }
    );

    await withPeopleFolder("PeopleMixed", async (vaultCtx) => {
      await writeVaultFile(
        vaultCtx,
        "Canonical.md",
        `---
jarvisPersonId: 00000000-0000-4000-8000-000000000199
displayName: Canonical Person
aliases: []
emails: []
phones: []
status: active
---
body
`
      );
      await writeVaultFile(
        vaultCtx,
        "Missing-Id.md",
        `---
displayName: Missing Id
aliases: []
emails: []
phones: []
status: active
---
body
`
      );
      await writeVaultFile(vaultCtx, "Invalid.md", "# Not People frontmatter");
      await writeVaultFile(vaultCtx, "Outside-counts.txt", "ignored extension");

      const result = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "refresh-mixed" },
        (sdb) => service.refreshFromFolder(sdb, vaultCtx, ids.userA)
      );
      expect(result).toEqual({ discovered: 3, projected: 1, ignored: 1, candidates: 1 });

      // A folder that was never created cannot be opened at all, which is how the People screen
      // reaches its "folder unavailable, choose another" state.
      await expect(
        vaultRunner.withVaultContextAt(
          { actorUserId: ids.userA, requestId: "people-notes-unavailable" },
          peopleFolder("PeopleUnavailable"),
          [notesRoot],
          async () => undefined
        )
      ).rejects.toThrow();
    });
  });

  it("projects one canonical note into one person", async () => {
    const service = new PeopleNotesService();

    await runner.withDataContext({ actorUserId: ids.userA, requestId: "settings" }, async (sdb) => {
      await service.putSettings(sdb, ids.userA, { folder: peopleFolder("People") });
    });

    await withPeopleFolder("People", async (vaultCtx) => {
      await writeVaultFile(
        vaultCtx,
        "Ada.md",
        `---
jarvisPersonId: 00000000-0000-4000-8000-000000000101
displayName: Ada Lovelace
aliases:
  - Ada
emails:
  - ada@example.test
phones: []
status: active
---
# Ada

Human note.
`
      );

      const result = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "refresh" },
        (sdb) => service.refreshFromFolder(sdb, vaultCtx, ids.userA)
      );

      expect(result.projected).toBe(1);
      expect(result.candidates).toBe(0);
    });

    await runner.withDataContext({ actorUserId: ids.userA, requestId: "assert" }, async (sdb) => {
      const repo = new PeopleRepository();
      const people = await repo.listPeople(sdb, ids.userA, { search: "Ada" });
      expect(people).toHaveLength(1);
      expect(people[0]?.id).toBe("00000000-0000-4000-8000-000000000101");
      const identities = await repo.listIdentities(sdb, ids.userA, people[0]!.id);
      expect(identities.map((identity) => identity.displayValue).sort()).toEqual([
        "Ada",
        "ada@example.test"
      ]);
    });
  });

  it("creates review candidate for duplicate canonical notes", async () => {
    const service = new PeopleNotesService();

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-dup" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleDup") });
      }
    );

    await withPeopleFolder("PeopleDup", async (vaultCtx) => {
      const note = `---
jarvisPersonId: 00000000-0000-4000-8000-000000000102
displayName: Duplicate Person
aliases: []
emails: []
phones: []
status: active
---
body
`;
      await writeVaultFile(vaultCtx, "One.md", note);
      await writeVaultFile(vaultCtx, "Two.md", note);

      const result = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "refresh-dup" },
        (sdb) => service.refreshFromFolder(sdb, vaultCtx, ids.userA)
      );

      expect(result.projected).toBe(0);
      expect(result.candidates).toBe(1);
    });
  });

  it("counts and records review candidates for notes missing jarvisPersonId", async () => {
    const service = new PeopleNotesService();

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-missing-id" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleMissingId") });
      }
    );

    await withPeopleFolder("PeopleMissingId", async (vaultCtx) => {
      await writeVaultFile(
        vaultCtx,
        "No-Id.md",
        `---
displayName: Missing Id
aliases: []
emails: []
phones: []
status: active
---
body
`
      );

      const result = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "refresh-missing-id" },
        (sdb) => service.refreshFromFolder(sdb, vaultCtx, ids.userA)
      );

      expect(result.projected).toBe(0);
      expect(result.candidates).toBe(1);
    });

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "assert-missing-id" },
      async (sdb) => {
        const candidates = await new PeopleRepository().listMatchCandidates(sdb, ids.userA);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.reasonSummary).toBe("People note missing jarvisPersonId");
      }
    );
  });

  it("creates review candidates for existing people without canonical notes", async () => {
    const service = new PeopleNotesService();
    const repo = new PeopleRepository();

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-missing-note" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleMissingNote") });
        await repo.upsertPerson(sdb, {
          ownerUserId: ids.userA,
          displayName: "Structured Only",
          confidence: 0.8
        });
      }
    );

    await withPeopleFolder("PeopleMissingNote", async (vaultCtx) => {
      await writeVaultFile(vaultCtx, "README.txt", "configured folder");

      const result = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "refresh-missing-note" },
        (sdb) => service.refreshFromFolder(sdb, vaultCtx, ids.userA)
      );

      expect(result.projected).toBe(0);
      expect(result.candidates).toBe(1);
    });

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "assert-missing-note" },
      async (sdb) => {
        const candidates = await repo.listMatchCandidates(sdb, ids.userA);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.reasonSummary).toBe("Existing People record missing canonical note");
      }
    );
  });

  it("writes notes first and preserves human body on edit", async () => {
    const service = new PeopleNotesService();
    let personId = "";
    let notePath = "";

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-write" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleWrite") });
      }
    );

    await withPeopleFolder("PeopleWrite", async (vaultCtx) => {
      const created = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "create-note" },
        (sdb) =>
          service.createPersonNote(sdb, vaultCtx, ids.userA, {
            displayName: "Grace Hopper",
            emails: ["grace@example.test"]
          })
      );
      personId = created.person.id;
      notePath = created.notePath;

      await writeVaultFile(
        vaultCtx,
        notePath,
        (await readVaultFile(vaultCtx, notePath)) + "\nHuman-owned detail.\n"
      );

      await runner.withDataContext({ actorUserId: ids.userA, requestId: "edit-note" }, (sdb) =>
        service.updatePersonNote(sdb, vaultCtx, ids.userA, personId, {
          displayName: "Amazing Grace"
        })
      );

      const edited = await readVaultFile(vaultCtx, notePath);
      expect(edited).toContain("displayName: Amazing Grace");
      expect(edited).toContain("Human-owned detail.");
    });

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "assert-edit" },
      async (sdb) => {
        const repo = new PeopleRepository();
        const person = await repo.getPerson(sdb, ids.userA, personId);
        expect(person.displayName).toBe("Amazing Grace");
      }
    );
  });

  it("archives by updating the note without deleting it", async () => {
    const service = new PeopleNotesService();
    let personId = "";
    let notePath = "";

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-archive" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleArchive") });
      }
    );

    await withPeopleFolder("PeopleArchive", async (vaultCtx) => {
      const created = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "create-archive" },
        (sdb) => service.createPersonNote(sdb, vaultCtx, ids.userA, { displayName: "Archive Me" })
      );
      personId = created.person.id;
      notePath = created.notePath;

      await runner.withDataContext({ actorUserId: ids.userA, requestId: "archive-note" }, (sdb) =>
        service.archivePersonNote(sdb, vaultCtx, ids.userA, personId)
      );

      const archived = await readVaultFile(vaultCtx, notePath);
      expect(archived).toContain("status: archived");
    });

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "assert-archive" },
      async (sdb) => {
        const repo = new PeopleRepository();
        const person = await repo.getPerson(sdb, ids.userA, personId);
        expect(person.status).toBe("archived");
      }
    );
  });

  it("throws CanonicalNoteNotFoundError when updating a person with no canonical note", async () => {
    const service = new PeopleNotesService();
    const repo = new PeopleRepository();
    let personId = "";

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "settings-no-note" },
      async (sdb) => {
        await service.putSettings(sdb, ids.userA, { folder: peopleFolder("PeopleNoNote") });
        const person = await repo.upsertPerson(sdb, {
          ownerUserId: ids.userA,
          displayName: "No Note Person",
          confidence: 0.8
        });
        personId = person.id;
      }
    );

    await withPeopleFolder("PeopleNoNote", async (vaultCtx) => {
      await expect(
        runner.withDataContext({ actorUserId: ids.userA, requestId: "update-no-note" }, (sdb) =>
          service.updatePersonNote(sdb, vaultCtx, ids.userA, personId, { displayName: "X" })
        )
      ).rejects.toThrow(CanonicalNoteNotFoundError);
    });
  });
});
