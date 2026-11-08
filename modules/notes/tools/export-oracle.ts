// Database differential oracle. Uses the actual legacy collector on disposable synthetic data.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { collectManagedNotesExportSection } from "../../../packages/notes/src/managed-source-export.js";

export async function exportOracle(): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const worker = createDatabase({ connectionString: urls.worker });
  const folder = await mkdtemp(join(tmpdir(), "moss-notes-export-"));
  const path = join(folder, "expected.json");
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const cleanup = async (): Promise<void> => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      await Promise.allSettled([
        bootstrap.end(),
        app.destroy(),
        worker.destroy(),
        rm(folder, { recursive: true, force: true })
      ]);
    }
  };
  try {
    await bootstrap.connect();
    for (const [index, actor] of actors.entries()) {
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes export oracle',$3)",
        [actor, `notes-export-${actor}@example.test`, index === 2]
      );
    }
    const cases: { seed: string[] }[] = JSON.parse(
      await readFile(new URL("../tests/01-notes_managed_actors.json", import.meta.url), "utf8")
    );
    for (const sql of cases[0]!.seed) {
      // Distinct binding/receipt IDs avoid the earlier privacy suite's existing data.
      await bootstrap.query(
        sql
          .replaceAll("{{userA}}", actors[0]!)
          .replaceAll("{{userB}}", actors[1]!)
          .replaceAll("a".repeat(64), "c".repeat(64))
          .replaceAll("b".repeat(64), "d".repeat(64))
      );
    }
    // Insert non-key order in every multi-row section. Actors has one row per owner.
    for (const variant of [3, 2]) {
      for (const sql of cases[0]!.seed) {
        if (sql.includes("app.notes_managed_actors")) continue;
        await bootstrap.query(
          sql
            .replaceAll("{{userA}}", actors[0]!)
            .replaceAll("{{userB}}", actors[1]!)
            .replaceAll("a".repeat(64), (variant === 3 ? "3" : "1").repeat(64))
            .replaceAll("b".repeat(64), (variant === 3 ? "4" : "2").repeat(64))
            .replaceAll(
              "64000000-0000-4000-8000-000000000001",
              `64000000-0000-4000-8000-${String(variant).padStart(12, "0")}`
            )
            .replaceAll(
              "65000000-0000-4000-8000-000000000001",
              `65000000-0000-4000-8000-${String(variant).padStart(12, "0")}`
            )
        );
      }
    }
    for (const [index, actor] of actors.slice(0, 2).entries()) {
      const operation = randomUUID();
      await bootstrap.query(
        "UPDATE app.notes_managed_actors SET generation=$2,state='deleting',operation_id=$3 WHERE owner_user_id=$1",
        [actor, index + 2, operation]
      );
      await bootstrap.query(
        "UPDATE app.notes_managed_sources SET generation=$2,state='sealed',operation_id=$3 WHERE owner_user_id=$1",
        [actor, index + 3, operation]
      );
      await bootstrap.query(
        "UPDATE app.notes_destination_bindings SET side='work',revision=7 WHERE owner_user_id=$1",
        [actor]
      );
      await bootstrap.query(
        "UPDATE app.notes_recording_contributions SET operation_id=$2,cleanup_operation_id=$2,prose=$3,block_bytes=$4 WHERE owner_user_id=$1",
        [actor, operation, `Private prose ${index}: 🌱 \\n"quoted"`, "<!-- exact -->\r\nline\r\n"]
      );
      const payload = { nested: [null, "🌱", { revision: 3 }], text: `private payload ${index}` };
      await bootstrap.query(
        "UPDATE app.notes_contribution_proposals SET payload=$2 WHERE owner_user_id=$1",
        [actor, payload]
      );
      await bootstrap.query(
        "UPDATE app.notes_contribution_operations SET payload=$2,state='cancelled' WHERE owner_user_id=$1",
        [actor, payload]
      );
    }
    // More than one guest page, including ordering across modules and UUIDs.
    for (let n = 0; n < 105; n++) {
      await bootstrap.query(
        "INSERT INTO app.notes_managed_sources(owner_user_id,source_module_id,source_id,generation) VALUES($1,$2,$3,$4)",
        [actors[0], n % 2 ? "meetings" : "calendar", randomUUID(), n]
      );
    }
    const expected = [];
    for (const [role, database] of [
      ["app", app],
      ["worker", worker]
    ] as const) {
      const runner = new DataContextRunner(database);
      for (const actor of actors) {
        expected.push({
          actor,
          role,
          value: await runner.withDataContext(
            { actorUserId: actor },
            collectManagedNotesExportSection
          )
        });
      }
    }
    await writeFile(path, JSON.stringify({ actors, expected }), { mode: 0o600 });
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
