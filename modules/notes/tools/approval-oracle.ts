// Actual legacy approval hooks with real actor-scoped preferences and temporary files.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import {
  notesCreatePresentation,
  notesDeletePresentation,
  notesEditPresentation
} from "../../../packages/notes/src/approval-presentation.js";

export async function approvalOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const db = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const runner = new DataContextRunner(app);
  const folder = await mkdtemp(join(tmpdir(), "moss-notes-approval-"));
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const root = join(folder, "notes");
  const alias = join(folder, "alias");
  const outside = join(folder, "outside");
  const path = join(folder, "expected.json");
  const previousRoots = process.env.JARVIS_NOTES_ROOTS;
  const cleanup = async () => {
    if (previousRoots === undefined) delete process.env.JARVIS_NOTES_ROOTS;
    else process.env.JARVIS_NOTES_ROOTS = previousRoots;
    try {
      await db.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      await Promise.allSettled([
        db.end(),
        app.destroy(),
        rm(folder, { recursive: true, force: true })
      ]);
    }
  };
  try {
    await db.connect();
    for (const [index, id] of actors.entries()) {
      await db.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes approval oracle',$3)",
        [id, `notes-approval-${id}@example.test`, index === 2]
      );
    }
    await mkdir(join(root, "Journal"), { recursive: true });
    await mkdir(outside);
    await symlink(root, alias, "dir");
    const content = "# Private synthetic note\nold café 😀\r\n";
    await writeFile(join(root, "Journal/note.md"), content);
    const variants = [
      { tool: "create", input: { path: "new.md", content: "new" } },
      { tool: "create", input: { path: "Journal/note.md", overwrite: true, content: "new" } },
      { tool: "edit", input: { path: "Journal/note.md", newText: "new", oldText: "old" } },
      { tool: "edit", input: { path: "Journal/note.md", oldText: "", newText: "new" } },
      { tool: "delete", input: { path: "Journal/note.md" } },
      { tool: "create", input: { path: "new.md", content: null } },
      { tool: "delete", input: { path: "Journal/note.md", actorUserId: actors[0] } }
    ];
    const expected = [];
    for (const source of [root, alias, null, 3, join(root, "missing"), outside]) {
      const roots = source === alias ? [alias] : [root];
      process.env.JARVIS_NOTES_ROOTS = roots.join(":");
      await db.query("DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[])", [actors]);
      await db.query(
        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2::jsonb)",
        [actors[0], JSON.stringify(source)]
      );
      for (const variant of variants) {
        const present =
          variant.tool === "create"
            ? notesCreatePresentation
            : variant.tool === "edit"
              ? notesEditPresentation
              : notesDeletePresentation;
        let result;
        try {
          result = {
            ok: await runner.withDataContext({ actorUserId: actors[0]! }, (scoped) =>
              present(scoped, variant.input, {
                actorUserId: actors[0]!,
                requestId: "approval-oracle",
                chatSessionId: "approval-oracle"
              })
            )
          };
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("statusCode" in error) ||
            !(error instanceof Error)
          )
            throw error;
          result = { error: { statusCode: error.statusCode, error: error.message } };
        }
        expected.push({
          source,
          roots,
          tool: `notes.${variant.tool}`,
          inputJson: JSON.stringify(variant.input),
          expected: result
        });
      }
    }
    // Source configured and real, but no live allowed roots.
    for (const roots of [[], [join(folder, "stale")]]) {
      process.env.JARVIS_NOTES_ROOTS = roots.join(":");
      await db.query("UPDATE app.preferences SET value_json=$1::jsonb WHERE owner_user_id=$2", [
        JSON.stringify(root),
        actors[0]
      ]);
      let result;
      try {
        result = {
          ok: await runner.withDataContext({ actorUserId: actors[0]! }, (scoped) =>
            notesDeletePresentation(
              scoped,
              { path: "Journal/note.md" },
              {
                actorUserId: actors[0]!,
                requestId: "approval-oracle",
                chatSessionId: "approval-oracle"
              }
            )
          )
        };
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("statusCode" in error) ||
          !(error instanceof Error)
        )
          throw error;
        result = { error: { statusCode: error.statusCode, error: error.message } };
      }
      expected.push({
        source: root,
        roots,
        tool: "notes.delete",
        inputJson: JSON.stringify({ path: "Journal/note.md" }),
        expected: result
      });
    }
    await writeFile(
      path,
      JSON.stringify({ actors, root: await realpath(root), alias, content, expected }),
      { mode: 0o600 }
    );
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
