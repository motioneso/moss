import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { PreferencesRepository } from "@moss/structured-state";
import { PeopleNotesService } from "@moss/people";
import { listVaultFiles, VaultContextError, VaultContextRunner } from "@moss/vault";

/**
 * #2268 — a People folder saved before this change was a relative name inside the app's private
 * storage. It now resolves against the user's chosen notes folder, and nothing else is guessed.
 * Resolving is path arithmetic only; whether the folder exists is settled by the guarded folder
 * access, which checks the allowed roots before it touches the disk. When that open fails the
 * People screen shows its existing "choose another folder" state.
 */
const preferences = new Map<string, unknown>();

const fakePreferences = {
  async get(_db: DataContextDb, key: string) {
    return preferences.get(key) ?? null;
  }
} as unknown as PreferencesRepository;

const scopedDb = {} as DataContextDb;

const accessContext = { actorUserId: "00000000-0000-4000-8000-000000000001", requestId: "people" };

function makeService() {
  return new PeopleNotesService({ preferencesRepository: fakePreferences });
}

describe("resolving a People folder saved before the shared picker", () => {
  beforeEach(() => {
    preferences.clear();
  });

  it("returns nothing when no folder has been chosen", async () => {
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("returns an absolute saved folder unchanged", async () => {
    preferences.set("people-notes-folder", "/data/external-notes/People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBe(
      "/data/external-notes/People"
    );
  });

  it("resolves a relative saved folder against the chosen notes folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    await mkdir(join(root, "People"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBe(join(root, "People"));
  });

  it("returns nothing when no notes folder has been chosen", async () => {
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("leaves a folder that is not there to be refused by the guarded folder access", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    const resolved = await makeService().resolveFolder(scopedDb);
    expect(resolved).toBe(join(root, "People"));

    const runner = new VaultContextRunner(await mkdtemp(join(tmpdir(), "people-vaults-")));
    await expect(
      runner.withVaultContextAt(accessContext, resolved as string, [root], async () => "opened")
    ).rejects.toThrow(VaultContextError);
  });

  it("leaves a saved name that points at a file to fail when the folder is read", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    await writeFile(join(root, "People"), "not a folder");
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    const resolved = await makeService().resolveFolder(scopedDb);
    expect(resolved).toBe(join(root, "People"));

    const runner = new VaultContextRunner(await mkdtemp(join(tmpdir(), "people-vaults-")));
    await expect(
      runner.withVaultContextAt(accessContext, resolved as string, [root], (ctx) =>
        listVaultFiles(ctx, ".")
      )
    ).rejects.toThrow();
  });

  it("refuses a saved name that climbs out of the notes folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "../elsewhere");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });
});
