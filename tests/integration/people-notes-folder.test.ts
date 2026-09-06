import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";
import {
  PeopleNotesService,
  PeopleRepository,
  PersonContextService,
  registerPeopleRoutes
} from "@moss/people";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * #2268 — the People folder is chosen with the same folder chooser as the notes source, so it must
 * be an absolute folder inside one of the server's allowed notes roots. These tests exercise the
 * real routes against a real database and real folders on disk: a folder inside the allowed root
 * saves and receives the note file, and a folder outside it is refused with the plain message the
 * People screen already shows.
 */
describe("choosing a People folder", () => {
  let db: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let vaultRoot: string;
  let vaultRunner: VaultContextRunner;
  let notesRoot: string;
  let outsideRoot: string;

  beforeAll(async () => {
    await resetFoundationDatabase();
    db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    runner = new DataContextRunner(db as never);
    vaultRoot = await mkdtemp(join(tmpdir(), "jarv1s-people-folder-vault-"));
    vaultRunner = new VaultContextRunner(vaultRoot);
    notesRoot = await mkdtemp(join(tmpdir(), "jarv1s-people-folder-notes-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "jarv1s-people-folder-outside-"));
    process.env["JARVIS_NOTES_ROOTS"] = notesRoot;
  });

  afterAll(async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    await db?.destroy();
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(notesRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetFoundationDatabase();
  });

  function buildApp() {
    const app = Fastify();
    registerPeopleRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: ids.userA, requestId: "people-folder" }),
      dataContext: runner,
      repo: new PeopleRepository(),
      svc: new PersonContextService(new PeopleRepository()),
      vaultRunner,
      peopleNotesService: new PeopleNotesService()
    });
    return app;
  }

  it("saves a folder inside the allowed notes folder and writes the note there", async () => {
    const folder = join(notesRoot, "People");
    await mkdir(folder, { recursive: true });
    const app = buildApp();
    await app.ready();

    const saved = await app.inject({
      method: "PUT",
      url: "/api/people/notes-settings",
      payload: { folder }
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toEqual({ folder });

    const created = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { displayName: "Ada Lovelace", emails: ["ada@example.test"] }
    });
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.body).notePath).toBe("Ada-Lovelace.md");
    await expect(readdir(folder)).resolves.toContain("Ada-Lovelace.md");

    await app.close();
  });

  it("refuses a folder outside the allowed notes folder with the plain message", async () => {
    const app = buildApp();
    await app.ready();

    const refused = await app.inject({
      method: "PUT",
      url: "/api/people/notes-settings",
      payload: { folder: outsideRoot }
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: "People notes folder is unavailable" });
    expect(refused.body).not.toContain(outsideRoot);

    const settings = await app.inject({ method: "GET", url: "/api/people/notes-settings" });
    expect(JSON.parse(settings.body)).toEqual({ folder: null });

    await app.close();
  });
});
