import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import type { AccessContext } from "@moss/db";
import { readVaultFile, VaultContextRunner, writeVaultFile } from "@moss/vault";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";
import { resetFoundationDatabase, ids } from "../../../../tests/integration/test-database.js";
import { registerPeopleRoutes } from "../routes.js";
import { PeopleRepository } from "../repository.js";
import { PersonContextService } from "../service.js";
import { PeopleNotesService } from "../notes-service.js";

const connectionStrings = getMossDatabaseUrls();
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let vaultRoot: string;
let vaultRunner: VaultContextRunner;
// #2268 — the People folder now lives inside the server's allowed notes roots, so these tests
// stand up a real notes root on disk and choose folders inside it, exactly as the shared folder
// chooser does. The private per-user storage folder is no longer involved.
let notesRoot: string;
let outsideRoot: string;

function accessContext(actorUserId = ids.userA): AccessContext {
  return { actorUserId, requestId: "test" };
}

/** Writes into a chosen People folder the same way the routes do. */
function inFolder<T>(
  folder: string,
  work: Parameters<VaultContextRunner["withVaultContextAt"]>[3],
  actorUserId = ids.userA
): Promise<T> {
  return vaultRunner.withVaultContextAt(
    accessContext(actorUserId),
    folder,
    [notesRoot],
    work
  ) as Promise<T>;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(db as never);
  vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-people-routes-"));
  vaultRunner = new VaultContextRunner(vaultRoot);
  notesRoot = await mkdtemp(join(tmpdir(), "jarvis-people-notes-root-"));
  outsideRoot = await mkdtemp(join(tmpdir(), "jarvis-people-outside-"));
  process.env["JARVIS_NOTES_ROOTS"] = notesRoot;
});

afterAll(async () => {
  await db?.destroy();
  delete process.env["JARVIS_NOTES_ROOTS"];
  if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  if (notesRoot) await rm(notesRoot, { recursive: true, force: true });
  if (outsideRoot) await rm(outsideRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetFoundationDatabase();
});

function buildApp(actorUserId = ids.userA, actorVaultRunner: VaultContextRunner = vaultRunner) {
  const app = Fastify();
  registerPeopleRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId, requestId: "test" }),
    dataContext: runner,
    repo: new PeopleRepository(),
    svc: new PersonContextService(new PeopleRepository()),
    vaultRunner: actorVaultRunner,
    peopleNotesService: new PeopleNotesService()
  });
  return app;
}

async function chooseFolder(app: ReturnType<typeof buildApp>, folder: string) {
  return app.inject({ method: "PUT", url: "/api/people/notes-settings", payload: { folder } });
}

describe("People notes settings routes", () => {
  it("refuses a folder outside the folders this server allows", async () => {
    const app = buildApp();
    await app.ready();

    const outside = await chooseFolder(app, outsideRoot);
    expect(outside.statusCode).toBe(400);
    expect(JSON.parse(outside.body)).toEqual({ error: "People notes folder is unavailable" });
    expect(outside.body).not.toContain(outsideRoot);

    const missing = await chooseFolder(app, join(notesRoot, "NeverCreated"));
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ error: "People notes folder is unavailable" });

    const relative = await chooseFolder(app, "People");
    expect(relative.statusCode).toBe(400);
    expect(JSON.parse(relative.body)).toEqual({ error: "People notes folder is unavailable" });

    await app.close();
  });

  it("keeps folder browsing inside the chosen folder across symlinks", async () => {
    const folder = join(notesRoot, "QA987Escape");
    await mkdir(join(outsideRoot, "OnlyOutside"), { recursive: true });
    await mkdir(folder, { recursive: true });
    await symlink(outsideRoot, join(folder, "EscapeOutside"), "dir");

    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);

    const root = await app.inject({ method: "GET", url: "/api/people/notes-directories" });
    expect(root.statusCode).toBe(200);
    expect(root.body).not.toContain("OnlyOutside");

    const escaped = await app.inject({
      method: "GET",
      url: "/api/people/notes-directories?path=EscapeOutside"
    });
    expect(escaped.statusCode).toBe(400);
    expect(JSON.parse(escaped.body)).toEqual({ error: "People notes folder is unavailable" });
    expect(escaped.body).not.toContain(outsideRoot);
    expect(escaped.body).not.toContain("OnlyOutside");
    await app.close();
  });

  it("maps browse and save failures to one safe response", async () => {
    const folder = join(notesRoot, "QA987Failures");
    await mkdir(folder, { recursive: true });
    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);
    await inFolder(folder, (ctx) => writeVaultFile(ctx, "QA987NotDirectory", "plain file"));

    for (const response of [
      await app.inject({
        method: "GET",
        url: "/api/people/notes-directories?path=QA987NotDirectory"
      }),
      await chooseFolder(app, join(folder, "QA987NotDirectory", "Child"))
    ]) {
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "People notes folder is unavailable" });
      expect(response.body).not.toContain(notesRoot);
    }
    await app.close();

    const loopRunner = {
      withVaultContextAt: async () => {
        throw Object.assign(new Error("ELOOP: /notes/loop"), {
          code: "ELOOP",
          path: "/notes/loop",
          syscall: "scandir"
        });
      }
    } as unknown as VaultContextRunner;
    const loopApp = buildApp(ids.userA, loopRunner);
    await loopApp.ready();
    for (const response of [
      await loopApp.inject({ method: "GET", url: "/api/people/notes-directories" }),
      await chooseFolder(loopApp, join(notesRoot, "Loop", "Child"))
    ]) {
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "People notes folder is unavailable" });
      expect(response.body).not.toContain("/notes/loop");
    }
    await loopApp.close();
  });

  it("lists folders relative to the chosen folder and rejects traversal without details", async () => {
    const folder = join(notesRoot, "QA987Browse");
    await mkdir(join(folder, "QA987", "Family"), { recursive: true });
    await mkdir(join(folder, "QA987Private"), { recursive: true });
    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);

    const root = await app.inject({ method: "GET", url: "/api/people/notes-directories" });
    expect(root.statusCode).toBe(200);
    expect(JSON.parse(root.body).directories).toEqual(
      expect.arrayContaining([
        { name: "QA987", path: "QA987" },
        { name: "QA987Private", path: "QA987Private" }
      ])
    );

    const invalid = await app.inject({
      method: "GET",
      url: "/api/people/notes-directories?path=People%2F..%2FPrivate"
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(notesRoot);
    expect(invalid.body).not.toContain(ids.userA);
    expect(invalid.body).not.toContain("QA987Private");
    await app.close();
  });

  it("serializes exact mixed refresh counters", async () => {
    const folder = join(notesRoot, "QA987Refresh");
    await mkdir(folder, { recursive: true });
    await inFolder(folder, async (ctx) => {
      await writeVaultFile(
        ctx,
        "Canonical.md",
        `---
jarvisPersonId: 00000000-0000-4000-8000-000000000198
displayName: Route Canonical
aliases: []
emails: []
phones: []
status: active
---
body
`
      );
      await writeVaultFile(
        ctx,
        "Missing-Id.md",
        `---
displayName: Route Missing Id
aliases: []
emails: []
phones: []
status: active
---
body
`
      );
      await writeVaultFile(ctx, "Invalid.md", "# Invalid");
      await writeVaultFile(ctx, "Outside-counts.txt", "ignored extension");
    });
    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);

    const refresh = await app.inject({ method: "POST", url: "/api/people/notes/refresh" });
    expect(refresh.statusCode).toBe(200);
    expect(JSON.parse(refresh.body)).toEqual({
      discovered: 3,
      projected: 1,
      ignored: 1,
      candidates: 1
    });

    await chmod(join(folder, "Canonical.md"), 0o000);
    const unavailable = await app.inject({ method: "POST", url: "/api/people/notes/refresh" });
    expect(unavailable.statusCode).toBe(400);
    expect(JSON.parse(unavailable.body)).toEqual({
      error: "People notes folder is unavailable"
    });
    expect(unavailable.body).not.toContain(notesRoot);

    await chmod(join(folder, "Canonical.md"), 0o600);
    await rm(folder, { recursive: true });
    const gone = await app.inject({ method: "POST", url: "/api/people/notes/refresh" });
    expect(gone.statusCode).toBe(400);
    expect(JSON.parse(gone.body)).toEqual({ error: "People notes folder is unavailable" });
    expect(gone.body).not.toContain(notesRoot);
    await app.close();
  });

  it("stores and reads the configured People folder", async () => {
    const folder = join(notesRoot, "QA987Stored");
    await mkdir(folder, { recursive: true });
    const app = buildApp();
    await app.ready();

    const initial = await app.inject({ method: "GET", url: "/api/people/notes-settings" });
    expect(initial.statusCode).toBe(200);
    expect(JSON.parse(initial.body)).toEqual({ folder: null });

    const put = await chooseFolder(app, folder);
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body)).toEqual({ folder });

    await app.close();
  });
});

describe("People note write routes", () => {
  it("creates, edits, and archives through the canonical note", async () => {
    const folder = join(notesRoot, "PeopleRoute");
    await mkdir(folder, { recursive: true });
    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { displayName: "Route Person", emails: ["route@example.test"] }
    });
    expect(created.statusCode).toBe(200);
    const createdBody = JSON.parse(created.body);
    const personId = createdBody.person.id;
    const notePath = createdBody.notePath;
    expect(notePath).toBe("Route-Person.md");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/people/${personId}`,
      payload: { displayName: "Route Person Edited" }
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).person.displayName).toBe("Route Person Edited");

    const archived = await app.inject({ method: "POST", url: `/api/people/${personId}/archive` });
    expect(archived.statusCode).toBe(200);

    await inFolder(folder, async (ctx) => {
      const note = await readVaultFile(ctx, notePath);
      expect(note).toContain("displayName: Route Person Edited");
      expect(note).toContain("status: archived");
    });

    await app.close();
  });

  it("falls back to DB-only update/archive when person has no canonical note", async () => {
    const folder = join(notesRoot, "PeopleNoNoteRoute");
    await mkdir(folder, { recursive: true });
    const app = buildApp();
    await app.ready();
    expect((await chooseFolder(app, folder)).statusCode).toBe(200);

    const repo = new PeopleRepository();
    let personId = "";
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "no-note-setup" },
      async (sdb) => {
        const person = await repo.upsertPerson(sdb, {
          ownerUserId: ids.userA,
          displayName: "Projected Person",
          confidence: 0.8
        });
        personId = person.id;
      }
    );

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/people/${personId}`,
      payload: { displayName: "Projected Person Edited" }
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).person.displayName).toBe("Projected Person Edited");

    const archived = await app.inject({ method: "POST", url: `/api/people/${personId}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(JSON.parse(archived.body)).toEqual({ archived: true });

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "no-note-assert" },
      async (sdb) => {
        const person = await repo.getPerson(sdb, ids.userA, personId);
        expect(person.displayName).toBe("Projected Person Edited");
        expect(person.status).toBe("archived");
      }
    );

    await app.close();
  });
});

describe("GET /api/people", () => {
  it("returns 200 with empty people array for new user", async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/people" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.people)).toBe(true);
    await app.close();
  });
});

describe("GET /api/people/:id/links", () => {
  it("strips source_ref and normalized_value from link response", async () => {
    const app = buildApp();
    await app.ready();

    const repo = new PeopleRepository();
    let personId = "";
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "setup" }, async (sdb) => {
      const person = await repo.upsertPerson(sdb, {
        ownerUserId: ids.userA,
        displayName: "Test Person",
        status: "active"
      });
      personId = person.id;
      await repo.upsertLink(sdb, {
        ownerUserId: ids.userA,
        personId: person.id,
        sourceKind: "email",
        sourceRef: "PRIVATE_SOURCE_REF",
        sourceRefHash: "abc123",
        linkKind: "sender",
        confidence: 0.9,
        provenance: "source"
      });
    });

    const res = await app.inject({ method: "GET", url: `/api/people/${personId}/links` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.links)).toBe(true);
    for (const link of body.links) {
      expect(link).not.toHaveProperty("sourceRef");
      expect(link).not.toHaveProperty("source_ref");
      expect(link).not.toHaveProperty("normalizedValue");
      expect(link).not.toHaveProperty("normalized_value");
    }
    await app.close();
  });
});
