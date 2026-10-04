import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertUniqueMigrationVersions,
  loadMigrationFiles
} from "../../packages/db/src/migrations/sql-runner.js";
import {
  meetingsModuleManifest,
  meetingsModuleSqlMigrationDirectory
} from "../../packages/meetings/src/manifest.js";
import {
  checkLocalDuplicates,
  findLocalMigrationFiles
} from "../../scripts/check-migration-collisions.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const expectedSequence = [
  "0273_meeting_records.sql",
  "0274_meeting_draft_delete.sql",
  "0275_meeting_transcript_batches.sql",
  "0276_meeting_chat_cleanup.sql",
  "0277_chat_surface_immutable.sql",
  "0278_meeting_outputs.sql",
  "0279_meeting_exports.sql",
  "0280_meeting_history.sql"
];

describe("unapplied Meetings migration sequence", () => {
  it("keeps the eight migrations in dependency order without colliding with other modules", async () => {
    const files = await findLocalMigrationFiles(root);
    expect(checkLocalDuplicates(files)).toEqual([]);
    expect(
      files
        .filter(({ filename }) => /_(meeting_|chat_surface_immutable)/.test(filename))
        .map(({ filename }) => filename)
    ).toEqual(expectedSequence);
  });

  it("declares every Meetings SQL file and loads the canonical renamed History sidecar", async () => {
    const meetings = await loadMigrationFiles(meetingsModuleSqlMigrationDirectory);
    const chat = await loadMigrationFiles(join(root, "packages/chat/sql"));
    assertUniqueMigrationVersions([...meetings, ...chat]);
    expect(meetingsModuleManifest.database.migrations).toEqual(
      meetings.map(({ name }) => `sql/${name}`)
    );
    expect(
      [...meetings, ...chat]
        .filter(({ name }) => expectedSequence.includes(name))
        .sort((a, b) => a.version.localeCompare(b.version))
        .map(({ name }) => name)
    ).toEqual(expectedSequence);
    const history = meetings.find(({ version }) => version === "0280");
    expect(history?.backfill?.name).toBe("0280_meeting_history.backfill.mjs");
    expect(history?.backfill?.source).toBe(
      await readFile(
        join(meetingsModuleSqlMigrationDirectory, "0280_meeting_history.backfill.mjs"),
        "utf8"
      )
    );
  });
});
