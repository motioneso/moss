// Real legacy service and VaultContext, inside the caller's rollback-only DB call.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDataContextDb } from "@moss/db";
import { readVaultFile, writeVaultFile, VaultContextRunner } from "@moss/vault";
import { PeopleNotesService } from "../../../packages/people/src/notes-service.js";

export async function notesOracle(scope: unknown, ownerUserId: string): Promise<unknown> {
  assertDataContextDb(scope);
  const root = await mkdtemp(join(tmpdir(), "moss-people-notes-oracle-"));
  const selected = join(root, "Contacts");
  await mkdir(selected);
  try {
    const vault = new VaultContextRunner(join(root, "private"));
    return await vault.withVaultContextAt(
      { actorUserId: ownerUserId, requestId: "people-notes-oracle" },
      selected,
      [root],
      async (context) => {
        const service = new PeopleNotesService();
        const created = await service.createPersonNote(scope, context, ownerUserId, {
          displayName: "Note Oracle",
          aliases: ["Oracle"],
          emails: ["oracle@example.test"],
          phones: ["123"]
        });
        const initial = await readVaultFile(context, created.notePath);
        await writeVaultFile(context, created.notePath, `${initial}\nHuman text stays.\n`);
        const updated = await service.updatePersonNote(
          scope,
          context,
          ownerUserId,
          created.person.id,
          {
            displayName: "Renamed Oracle"
          }
        );
        const changed = await readVaultFile(context, created.notePath);
        const archived = await service.archivePersonNote(
          scope,
          context,
          ownerUserId,
          created.person.id
        );
        const final = await readVaultFile(context, created.notePath);
        return { responses: [created, updated, archived], contents: [initial, changed, final] };
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
